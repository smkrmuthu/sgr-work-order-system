-- Business logic that must be atomic and server-enforced (never trust the client for these): WO
-- numbering, revisioning, column-level edit rules per role, status recomputation, invoicing.
-- These are this app's "API" in the sense NestJS controllers would otherwise have been (v1.3 §9).

-- ---------------------------------------------------------------- WO numbering (§3.1, §10: unique, never reused)
-- One counter per Indian financial year (Apr-Mar), so numbers read NNN/2026-27 and restart each FY.
-- DECISION TO CONFIRM WITH BUSINESS: this starts a NEW system at 1 each FY. If SGR wants Work Order
-- numbers to continue the paper/prototype system's existing count instead of restarting, change the
-- starting `next_number` in app.wo_number_counters for the current FY once, before go-live.
create table if not exists app.wo_number_counters (
  fiscal_year_start int primary key,
  next_number        int not null default 1
);

create or replace function app.fiscal_year_label(for_date date) returns text
language sql immutable as $$
  select (case when extract(month from for_date) < 4
               then extract(year from for_date)::int - 1
               else extract(year from for_date)::int end)::text
         || '-' ||
         lpad(((case when extract(month from for_date) < 4
                     then extract(year from for_date)::int
                     else extract(year from for_date)::int + 1 end) % 100)::text, 2, '0')
$$;

create or replace function app.next_wo_number(for_date date default current_date) returns text
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  fy int := case when extract(month from for_date) < 4
                 then extract(year from for_date)::int - 1
                 else extract(year from for_date)::int end;
  n int;
begin
  insert into app.wo_number_counters (fiscal_year_start, next_number) values (fy, 2)
  on conflict (fiscal_year_start) do update set next_number = app.wo_number_counters.next_number + 1
  returning next_number - 1 into n;
  return n || '/' || app.fiscal_year_label(for_date);
end $$;

-- ---------------------------------------------------------------- create / update Work Orders
-- Draft: the Creator's own, freely re-savable, never numbered. payload shape mirrors work_orders'
-- editable columns plus a `lines` array (see README for the exact JSON shape and a worked example).
create or replace function app.save_draft(p_id uuid, p jsonb) returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
begin
  insert into app.work_orders as w (
    id, status, partner_id, delivery_location_id, delivery_location_snapshot, wo_date, delivery_date,
    doc_ref, test_cert_required, inspection_report_required, additional_notes, packing_required,
    units_per_bundle, pallet_height_in, separate_vehicle_required, transport_notes, created_by, updated_by
  ) values (
    v_id, 'draft', (p->>'partner_id')::uuid, (p->>'delivery_location_id')::uuid, p->'delivery_location_snapshot',
    coalesce((p->>'wo_date')::date, current_date), (p->>'delivery_date')::date, p->>'doc_ref',
    coalesce((p->>'test_cert_required')::boolean, false), coalesce((p->>'inspection_report_required')::boolean, false),
    p->>'additional_notes', coalesce((p->>'packing_required')::boolean, true), (p->>'units_per_bundle')::int,
    (p->>'pallet_height_in')::numeric, coalesce((p->>'separate_vehicle_required')::boolean, false),
    p->>'transport_notes', auth.uid(), auth.uid()
  )
  on conflict (id) do update set
    partner_id = excluded.partner_id, delivery_location_id = excluded.delivery_location_id,
    delivery_location_snapshot = excluded.delivery_location_snapshot, wo_date = excluded.wo_date,
    delivery_date = excluded.delivery_date, doc_ref = excluded.doc_ref,
    test_cert_required = excluded.test_cert_required, inspection_report_required = excluded.inspection_report_required,
    additional_notes = excluded.additional_notes, packing_required = excluded.packing_required,
    units_per_bundle = excluded.units_per_bundle, pallet_height_in = excluded.pallet_height_in,
    separate_vehicle_required = excluded.separate_vehicle_required, transport_notes = excluded.transport_notes,
    updated_by = auth.uid(), updated_at = now()
  where w.status = 'draft' and w.created_by = auth.uid();   -- re-saving someone else's draft is a no-op, not an error

  delete from app.work_order_lines where work_order_id = v_id;
  insert into app.work_order_lines (
    work_order_id, line_no, part_id, part_no_snapshot, description_snapshot, uom_snapshot,
    standard_weight_kg_snapshot, category_snapshot, standard_price_snapshot, final_price, qty, remarks
  )
  select v_id, ord, (l->>'part_id')::uuid, prt.part_no, prt.description, prt.uom, prt.standard_weight_kg,
         cat.name, prt.price, prt.price, coalesce((l->>'qty')::numeric, 0), l->>'remarks'
  from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) with ordinality as t(l, ord)
  join app.parts prt on prt.id = (l->>'part_id')::uuid
  left join app.categories cat on cat.id = prt.category_id;

  return v_id;
end $$;

-- Promotes a draft to a real, numbered Work Order. Validates §10's minimum bar, then hands it straight
-- to the Production floor (CONFIRMED 28 Sep 2026: no MD sign-off gate, no separate release step).
create or replace function app.create_work_order(p_id uuid) returns app.work_orders
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_wo app.work_orders;
  v_line_count int;
begin
  select * into v_wo from app.work_orders where id = p_id for update;
  if v_wo is null then raise exception 'Work order % not found', p_id; end if;
  if v_wo.status <> 'draft' then raise exception 'Work order % is not a draft', p_id; end if;
  if v_wo.created_by <> auth.uid() and not app.current_role_in('md', 'admin') then
    raise exception 'Only the creator or MD may create this work order';
  end if;
  if v_wo.partner_id is null then raise exception 'Select a Business Partner before creating.'; end if;
  if v_wo.delivery_location_id is null then raise exception 'Select a Delivery Location before creating.'; end if;
  if v_wo.delivery_date is null then raise exception 'Enter a Delivery Date before creating.'; end if;
  select count(*) into v_line_count from app.work_order_lines where work_order_id = p_id;
  if v_line_count = 0 then raise exception 'Add at least one line item before creating.'; end if;

  perform set_config('app.bypass_edit_check', 'true', true);
  -- status_history + the "created" notification are NOT inserted here: the work_orders_status_log
  -- AFTER UPDATE trigger (below) fires on this same UPDATE and logs both generically for every
  -- status change, wherever it originates. Inserting them here too would double them up.
  update app.work_orders
     set wo_number = app.next_wo_number(current_date), status = 'created', updated_by = auth.uid(), updated_at = now()
   where id = p_id
  returning * into v_wo;

  return v_wo;
end $$;

-- ---------------------------------------------------------------- MD edits -> automatic revisioning (§6)
-- Column-level enforcement RLS can't express: Planner may change ONLY expected_completion_date;
-- Creator only while status='draft'; MD may change any business field, which opens a new revision.
create or replace function app.enforce_work_order_edit() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_role app.user_role := app.current_role();
  v_business_changed boolean;
begin
  if current_setting('app.bypass_edit_check', true) = 'true' then
    return new;   -- internal system update (status recompute, create_work_order) — already validated above
  end if;

  if v_role in ('md', 'admin') then
    -- allowed; falls through to revisioning below
    null;
  elsif v_role = 'creator' then
    if old.status <> 'draft' then raise exception 'Only MD may edit a Work Order once it is created.'; end if;
  elsif v_role = 'planner' then
    -- Planner may change ONLY expected_completion_date. Reject (never silently discard) any other
    -- attempted change, so a client that saves back a whole loaded row fails loudly, not quietly.
    if (old.wo_number, old.revision, old.status, old.partner_id, old.delivery_location_id, old.wo_date,
        old.delivery_date, old.doc_ref, old.test_cert_required, old.inspection_report_required,
        old.additional_notes, old.packing_required, old.units_per_bundle, old.pallet_height_in,
        old.separate_vehicle_required, old.transport_notes)
       is distinct from
       (new.wo_number, new.revision, new.status, new.partner_id, new.delivery_location_id, new.wo_date,
        new.delivery_date, new.doc_ref, new.test_cert_required, new.inspection_report_required,
        new.additional_notes, new.packing_required, new.units_per_bundle, new.pallet_height_in,
        new.separate_vehicle_required, new.transport_notes) then
      raise exception 'Production Planner may change only the Expected Completion Date.';
    end if;
    if new.expected_completion_date is distinct from old.expected_completion_date then
      insert into app.completion_date_changes (work_order_id, from_date, to_date, changed_by)
        values (old.id, old.expected_completion_date, new.expected_completion_date, auth.uid());
    end if;
    new.updated_by := auth.uid(); new.updated_at := now();
    return new;
  else
    raise exception 'Role % may not edit Work Orders', v_role;
  end if;

  -- MD path: any business-field change opens a new revision, preserving the prior snapshot (§6).
  v_business_changed := (old.delivery_date, old.doc_ref, old.test_cert_required, old.inspection_report_required,
                          old.additional_notes, old.packing_required, old.units_per_bundle, old.pallet_height_in,
                          old.separate_vehicle_required, old.transport_notes)
                     is distinct from
                         (new.delivery_date, new.doc_ref, new.test_cert_required, new.inspection_report_required,
                          new.additional_notes, new.packing_required, new.units_per_bundle, new.pallet_height_in,
                          new.separate_vehicle_required, new.transport_notes);
  if v_business_changed and old.status <> 'draft' then
    new.revision := old.revision + 1;
    insert into app.work_order_revisions (work_order_id, revision, snapshot, changed_by, change_summary)
      values (old.id, old.revision, to_jsonb(old.*) || jsonb_build_object(
                'lines', (select coalesce(jsonb_agg(to_jsonb(l.*)), '[]') from app.work_order_lines l
                          where l.work_order_id = old.id)),
              auth.uid(), 'MD edit');
  end if;
  new.updated_by := auth.uid(); new.updated_at := now();
  return new;
end $$;

drop trigger if exists work_orders_edit_guard on app.work_orders;
create trigger work_orders_edit_guard before update on app.work_orders
  for each row execute function app.enforce_work_order_edit();

-- Any status change gets one status_history row, whoever/whatever caused it.
create or replace function app.log_status_change() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if new.status is distinct from old.status then
    insert into app.status_history (work_order_id, from_status, to_status, changed_by)
      values (new.id, old.status, new.status, auth.uid());
    insert into app.notifications (user_id, work_order_id, message)
      values (null, new.id, 'Work Order ' || coalesce(new.wo_number, '(draft)') || ' is now ' || new.status || '.');
  end if;
  return new;
end $$;

drop trigger if exists work_orders_status_log on app.work_orders;
create trigger work_orders_status_log after update on app.work_orders
  for each row execute function app.log_status_change();

-- ---------------------------------------------------------------- status recompute (§7)
-- DOCUMENTED CHOICE (exact rule is explicitly open in v1.3 §4/§10/§13 — revisit with business):
--   no production yet            -> in_production stays 'created'
--   produced, nothing submitted to QC in full -> 'in_production'
--   something submitted, not fully inspected  -> 'qc_pending'
--   some inspected (accepted or held), not all ordered qty accepted -> 'partially_qc_approved'
--   all ordered qty accepted                  -> 'ready_for_dispatch'
-- 'draft', 'completed' and 'cancelled' are set explicitly, never recomputed.
create or replace function app.recompute_work_order_status(p_work_order_id uuid) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_status app.wo_status;
  v_ordered numeric; v_produced numeric; v_submitted numeric; v_accepted numeric;
begin
  select status into v_status from app.work_orders where id = p_work_order_id;
  if v_status in ('draft', 'completed', 'cancelled') then return; end if;

  select coalesce(sum(l.qty), 0) into v_ordered from app.work_order_lines l where l.work_order_id = p_work_order_id;
  select coalesce(sum(o.qty), 0) into v_produced from app.production_output_lines o
    join app.work_order_lines l on l.id = o.work_order_line_id where l.work_order_id = p_work_order_id;
  select coalesce(sum(s.qty), 0) into v_submitted from app.qc_submissions s
    join app.work_order_lines l on l.id = s.work_order_line_id where l.work_order_id = p_work_order_id;
  select coalesce(sum(i.accepted_qty), 0) into v_accepted from app.qc_inspections i
    join app.work_order_lines l on l.id = i.work_order_line_id where l.work_order_id = p_work_order_id;

  v_status := case
    when v_produced = 0 then 'created'
    when v_accepted >= v_ordered and v_ordered > 0 then 'ready_for_dispatch'
    when v_accepted > 0 then 'partially_qc_approved'
    when v_submitted > 0 then 'qc_pending'
    else 'in_production'
  end;

  perform set_config('app.bypass_edit_check', 'true', true);
  update app.work_orders set status = v_status where id = p_work_order_id and status is distinct from v_status;
end $$;

create or replace function app.recompute_status_from_output_line() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_wo_id uuid;
begin
  select work_order_id into v_wo_id from app.work_order_lines where id = new.work_order_line_id;
  perform app.recompute_work_order_status(v_wo_id);
  return new;
end $$;
drop trigger if exists production_output_status on app.production_output_lines;
create trigger production_output_status after insert on app.production_output_lines
  for each row execute function app.recompute_status_from_output_line();

create or replace function app.recompute_status_from_qc() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_wo_id uuid;
begin
  select work_order_id into v_wo_id from app.work_order_lines where id = new.work_order_line_id;
  perform app.recompute_work_order_status(v_wo_id);
  return new;
end $$;
drop trigger if exists qc_submission_status on app.qc_submissions;
create trigger qc_submission_status after insert on app.qc_submissions
  for each row execute function app.recompute_status_from_qc();
drop trigger if exists qc_inspection_status on app.qc_inspections;
create trigger qc_inspection_status after insert on app.qc_inspections
  for each row execute function app.recompute_status_from_qc();

-- ---------------------------------------------------------------- production entry (§4)
-- One call: the daily header + its output lines, in one transaction, with the over-production guard
-- (§10: "Prevent over-production or require an explicit, audited override" — Phase 1 default: prevent).
create or replace function app.record_production(p jsonb) returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_entry_id uuid;
  v_line record;
  v_produced_so_far numeric;
  v_qty numeric;
begin
  if not app.current_role_in('planner', 'md', 'admin') then
    raise exception 'Only the Production Planner (or MD) may record production.';
  end if;

  insert into app.production_entries (work_order_id, production_date, shift_id, labour_count, planner_id)
  values ((p->>'work_order_id')::uuid, coalesce((p->>'production_date')::date, current_date),
          (p->>'shift_id')::uuid, (p->>'labour_count')::int, auth.uid())
  returning id into v_entry_id;

  for v_line in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) as x(v) loop
    v_qty := (v_line.v->>'qty')::numeric;
    continue when v_qty is null or v_qty <= 0;

    select coalesce(sum(o.qty), 0) into v_produced_so_far
      from app.production_output_lines o where o.work_order_line_id = (v_line.v->>'work_order_line_id')::uuid;

    if v_produced_so_far + v_qty > (select l.qty from app.work_order_lines l where l.id = (v_line.v->>'work_order_line_id')::uuid) then
      raise exception 'Line %: % would take produced to %, above the ordered quantity.',
        (v_line.v->>'work_order_line_id')::uuid, v_qty, v_produced_so_far + v_qty;
    end if;

    insert into app.production_output_lines (production_entry_id, work_order_line_id, qty, actual_weight_kg, note)
    values (v_entry_id, (v_line.v->>'work_order_line_id')::uuid, v_qty,
            coalesce((v_line.v->>'actual_weight_kg')::numeric, 0), v_line.v->>'note');
  end loop;

  return v_entry_id;
end $$;

-- Sends everything produced-but-not-yet-sent for a line to QC in one action (§4: partial output can
-- be sent separately, so this is called once per line, not once per Work Order).
create or replace function app.send_line_to_qc(p_work_order_line_id uuid) returns numeric
language plpgsql security invoker set search_path = app, pg_temp as $$
declare v_produced numeric; v_sent numeric; v_amount numeric;
begin
  if not app.current_role_in('planner', 'md', 'admin') then
    raise exception 'Only the Production Planner (or MD) may send output to QC.';
  end if;
  select coalesce(sum(qty), 0) into v_produced from app.production_output_lines where work_order_line_id = p_work_order_line_id;
  select coalesce(sum(qty), 0) into v_sent from app.qc_submissions where work_order_line_id = p_work_order_line_id;
  v_amount := v_produced - v_sent;
  if v_amount <= 0 then raise exception 'Nothing new to send to QC for this line.'; end if;
  insert into app.qc_submissions (work_order_line_id, qty, submitted_by) values (p_work_order_line_id, v_amount, auth.uid());
  return v_amount;
end $$;

-- ---------------------------------------------------------------- QC inspection (§5)
-- One inspection decides ALL of a line's currently-awaiting quantity: accepted_qty advances toward
-- Ready for Dispatch, the remainder becomes Held (never silently accepted, never silently dropped —
-- §5's own warning, since Phase 1 has no reject/rework workflow yet). Held is recoverable via
-- app.reopen_held(), not a dead end.
create or replace function app.record_qc_inspection(p_work_order_line_id uuid, p_accepted_qty numeric, p_comments text)
returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare v_sent numeric; v_approved numeric; v_held numeric; v_awaiting numeric; v_id uuid;
begin
  if not app.current_role_in('qc', 'md', 'admin') then raise exception 'Only QC (or MD) may record an inspection.'; end if;
  select coalesce(sum(qty), 0) into v_sent from app.qc_submissions where work_order_line_id = p_work_order_line_id;
  select coalesce(sum(accepted_qty), 0), coalesce(sum(held_qty), 0) into v_approved, v_held
    from app.qc_inspections where work_order_line_id = p_work_order_line_id;
  v_awaiting := v_sent - v_approved - v_held;
  if v_awaiting <= 0 then raise exception 'Nothing is awaiting inspection for this line.'; end if;
  if p_accepted_qty < 0 or p_accepted_qty > v_awaiting then
    raise exception 'Accepted quantity must be between 0 and %.', v_awaiting;
  end if;

  insert into app.qc_inspections (work_order_line_id, accepted_qty, held_qty, comments, inspector_id)
  values (p_work_order_line_id, p_accepted_qty, v_awaiting - p_accepted_qty, p_comments, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Brings previously-Held quantity back into the awaiting-inspection pool.
create or replace function app.reopen_held(p_work_order_line_id uuid) returns numeric
language plpgsql security invoker set search_path = app, pg_temp as $$
declare v_held numeric;
begin
  if not app.current_role_in('qc', 'md', 'admin') then raise exception 'Only QC (or MD) may reopen held quantity.'; end if;
  select coalesce(sum(held_qty), 0) into v_held from app.qc_inspections where work_order_line_id = p_work_order_line_id;
  if v_held <= 0 then raise exception 'Nothing is held for this line.'; end if;
  -- A zeroing inspection row moves held back to "awaiting" without ever deleting the original record.
  insert into app.qc_inspections (work_order_line_id, accepted_qty, held_qty, comments, inspector_id)
  values (p_work_order_line_id, 0, -v_held, 'Reopened for re-inspection', auth.uid());
  perform app.recompute_work_order_status((select work_order_id from app.work_order_lines where id = p_work_order_line_id));
  return v_held;
end $$;

-- ---------------------------------------------------------------- invoicing (§6)
-- OPEN DECISION (v1.3 §13): invoice quantity basis. Phase 1 default: QC-approved quantity once any
-- exists for a line, else ordered quantity (matches the Phase 1 wireframe) — confirm with business.
create or replace function app.generate_invoice(p_work_order_id uuid, p_gst_rate numeric, p_supply_type app.supply_type)
returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_invoice_id uuid;
  v_number text;
  v_subtotal numeric := 0;
  v_line record;
  v_qty numeric;
  v_amount numeric;
  v_cgst numeric := 0; v_sgst numeric := 0; v_igst numeric := 0; v_total numeric;
  v_seq int;
begin
  if not app.current_role_in('md', 'admin') then raise exception 'Only MD may generate an invoice.'; end if;

  insert into app.wo_number_counters (fiscal_year_start, next_number) values (-1, 2)
  on conflict (fiscal_year_start) do update set next_number = app.wo_number_counters.next_number + 1
  returning next_number - 1 into v_seq;
  v_number := 'INV/' || app.fiscal_year_label(current_date) || '/' || lpad(v_seq::text, 4, '0');

  insert into app.invoices (work_order_id, invoice_number, gst_rate, supply_type, subtotal, grand_total)
  values (p_work_order_id, v_number, p_gst_rate, p_supply_type, 0, 0) returning id into v_invoice_id;

  for v_line in select l.*, coalesce((select sum(accepted_qty) from app.qc_inspections where work_order_line_id = l.id), 0) as qc_qty
                from app.work_order_lines l where l.work_order_id = p_work_order_id loop
    v_qty := case when v_line.qc_qty > 0 then v_line.qc_qty else v_line.qty end;
    v_amount := v_qty * v_line.final_price;
    v_subtotal := v_subtotal + v_amount;
    insert into app.invoice_lines (invoice_id, work_order_line_id, description, qty, price, amount)
    values (v_invoice_id, v_line.id, v_line.description_snapshot, v_qty, v_line.final_price, v_amount);
  end loop;

  if p_supply_type = 'intra' then
    v_cgst := round(v_subtotal * p_gst_rate / 200, 2); v_sgst := v_cgst;
  else
    v_igst := round(v_subtotal * p_gst_rate / 100, 2);
  end if;
  v_total := v_subtotal + v_cgst + v_sgst + v_igst;

  update app.invoices set subtotal = v_subtotal, cgst = v_cgst, sgst = v_sgst, igst = v_igst,
                          grand_total = v_total, generated_by = auth.uid()
  where id = v_invoice_id;

  return v_invoice_id;
end $$;

revoke all on function app.generate_invoice(uuid, numeric, app.supply_type) from public, anon;
grant execute on function app.generate_invoice(uuid, numeric, app.supply_type) to authenticated;

-- 012: fixes from the first code review (see chat/PR history) applied with minimal edits, each
-- `create or replace function` restating the current (007/010) body unchanged except for the one
-- fix noted in its own comment. Safe to re-run.

-- ---------------------------------------------------------------- #1: no row lock -> check-then-act races
-- All three functions below now take a `for update` lock on the work_order_lines row FIRST, so two
-- concurrent calls for the same line serialize: the second one blocks until the first commits, then
-- (READ COMMITTED re-reads on each new statement) sees the first's already-inserted rows.
create or replace function app.record_qc_inspection(p_work_order_line_id uuid, p_accepted_qty numeric, p_comments text)
returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare v_sent numeric; v_approved numeric; v_held numeric; v_awaiting numeric; v_id uuid;
begin
  if not app.current_role_in('qc', 'md', 'admin') then raise exception 'Only QC (or MD) may record an inspection.'; end if;
  perform 1 from app.work_order_lines where id = p_work_order_line_id for update;   -- fix #1: serialise concurrent inspections of this line
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

create or replace function app.send_line_to_qc(p_work_order_line_id uuid) returns numeric
language plpgsql security invoker set search_path = app, pg_temp as $$
declare v_produced numeric; v_sent numeric; v_amount numeric;
begin
  if not app.current_role_in('planner', 'md', 'admin') then
    raise exception 'Only the Production Planner (or MD) may send output to QC.';
  end if;
  perform 1 from app.work_order_lines where id = p_work_order_line_id for update;   -- fix #1: serialise concurrent sends of this line
  select coalesce(sum(qty), 0) into v_produced from app.production_output_lines where work_order_line_id = p_work_order_line_id;
  select coalesce(sum(qty), 0) into v_sent from app.qc_submissions where work_order_line_id = p_work_order_line_id;
  v_amount := v_produced - v_sent;
  if v_amount <= 0 then raise exception 'Nothing new to send to QC for this line.'; end if;
  insert into app.qc_submissions (work_order_line_id, qty, submitted_by) values (p_work_order_line_id, v_amount, auth.uid());
  return v_amount;
end $$;

create or replace function app.record_production(p jsonb) returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_entry_id uuid;
  v_line record;
  v_produced_so_far numeric;
  v_qty numeric;
  v_wo_status app.wo_status;
begin
  if not app.current_role_in('planner', 'md', 'admin') then
    raise exception 'Only the Production Planner (or MD) may record production.';
  end if;

  select status into v_wo_status from app.work_orders where id = (p->>'work_order_id')::uuid;
  if v_wo_status is null then raise exception 'Work order % not found', (p->>'work_order_id')::uuid; end if;
  if v_wo_status = 'pending_finance_approval' then
    raise exception 'This Work Order is awaiting Finance approval and cannot start production yet.';
  end if;
  if v_wo_status in ('draft', 'cancelled', 'completed') then
    raise exception 'This Work Order is % and cannot record production.', v_wo_status;
  end if;

  insert into app.production_entries (work_order_id, production_date, shift_id, labour_count, planner_id)
  values ((p->>'work_order_id')::uuid, coalesce((p->>'production_date')::date, current_date),
          (p->>'shift_id')::uuid, (p->>'labour_count')::int, auth.uid())
  returning id into v_entry_id;

  for v_line in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) as x(v) loop
    v_qty := (v_line.v->>'qty')::numeric;
    continue when v_qty is null or v_qty <= 0;

    perform 1 from app.work_order_lines where id = (v_line.v->>'work_order_line_id')::uuid for update;   -- fix #1: serialise concurrent production entries on this line

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

-- ---------------------------------------------------------------- #2: 'cancelled' had become unreachable
-- 007's blanket status guard (correctly) closed the direct-UPDATE path Creator/MD used to be able to
-- abuse; this reopens ONLY 'cancelled', only for MD/Admin, only through this one audited function, using
-- the same bypass_edit_check + finance_approvals-style trail as approve/reject_work_order.
create or replace function app.cancel_work_order(p_work_order_id uuid, p_reason text default null) returns app.work_orders
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_wo app.work_orders;
begin
  if not app.current_role_in('md', 'admin') then raise exception 'Only MD may cancel a Work Order.'; end if;

  select * into v_wo from app.work_orders where id = p_work_order_id for update;
  if v_wo is null then raise exception 'Work order % not found', p_work_order_id; end if;
  if v_wo.status in ('completed', 'cancelled') then
    raise exception 'A % Work Order cannot be cancelled.', v_wo.status;
  end if;

  insert into app.finance_approvals (work_order_id, action, comments, actor)
    values (p_work_order_id, 'rejected', coalesce('Cancelled: ' || nullif(btrim(p_reason), ''), 'Cancelled'), auth.uid());

  perform set_config('app.bypass_edit_check', 'true', true);
  update app.work_orders set status = 'cancelled', updated_by = auth.uid(), updated_at = now()
   where id = p_work_order_id
  returning * into v_wo;

  return v_wo;
end $$;

revoke execute on function app.cancel_work_order(uuid, text) from public, anon;
grant execute on function app.cancel_work_order(uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------- #7: save_draft's header write was creator-only
-- RLS (work_orders_update) already lets MD/Admin edit any order's header; this WHERE clause hadn't
-- caught up, so an MD calling save_draft on someone else's draft silently kept the old header while
-- lines/notes (no such restriction for md/admin) were still rewritten underneath it.
create or replace function app.save_draft(p_id uuid, p jsonb) returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
begin
  insert into app.work_orders as w (
    id, status, partner_id, delivery_location_id, delivery_location_snapshot, wo_date, delivery_date,
    doc_ref, test_cert_required, inspection_report_required, packing_required,
    units_per_bundle, pallet_height_in, separate_vehicle_required, transport_notes, created_by, updated_by
  ) values (
    v_id, 'draft', (p->>'partner_id')::uuid, (p->>'delivery_location_id')::uuid, p->'delivery_location_snapshot',
    coalesce((p->>'wo_date')::date, current_date), (p->>'delivery_date')::date, p->>'doc_ref',
    coalesce((p->>'test_cert_required')::boolean, false), coalesce((p->>'inspection_report_required')::boolean, false),
    coalesce((p->>'packing_required')::boolean, true), (p->>'units_per_bundle')::int,
    (p->>'pallet_height_in')::numeric, coalesce((p->>'separate_vehicle_required')::boolean, false),
    p->>'transport_notes', auth.uid(), auth.uid()
  )
  on conflict (id) do update set
    partner_id = excluded.partner_id, delivery_location_id = excluded.delivery_location_id,
    delivery_location_snapshot = excluded.delivery_location_snapshot, wo_date = excluded.wo_date,
    delivery_date = excluded.delivery_date, doc_ref = excluded.doc_ref,
    test_cert_required = excluded.test_cert_required, inspection_report_required = excluded.inspection_report_required,
    packing_required = excluded.packing_required,
    units_per_bundle = excluded.units_per_bundle, pallet_height_in = excluded.pallet_height_in,
    separate_vehicle_required = excluded.separate_vehicle_required, transport_notes = excluded.transport_notes,
    updated_by = auth.uid(), updated_at = now()
  where w.status in ('draft', 'pending_finance_approval')
    and (w.created_by = auth.uid() or app.current_role_in('md', 'admin'));   -- fix #7: MD/Admin no longer need to be the creator

  -- Lines and notes are rewritten below; if the order is no longer editable by this caller, RLS refuses
  -- the insert and the whole call fails (rather than silently doing nothing).
  delete from app.work_order_lines where work_order_id = v_id;
  insert into app.work_order_lines (
    work_order_id, line_no, part_id, part_no_snapshot, description_snapshot, uom_snapshot,
    standard_weight_kg_snapshot, category_snapshot, standard_price_snapshot, final_price, qty, remarks, customer_ref
  )
  select v_id, ord, (l->>'part_id')::uuid, prt.part_no, prt.description, prt.uom, prt.standard_weight_kg,
         cat.name, prt.price, prt.price, coalesce((l->>'qty')::numeric, 0), l->>'remarks',
         nullif(btrim(coalesce(l->>'customer_ref', prt.customer_ref)), '')
  from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) with ordinality as t(l, ord)
  join app.parts prt on prt.id = (l->>'part_id')::uuid
  left join app.categories cat on cat.id = prt.category_id;

  delete from app.work_order_notes where work_order_id = v_id;
  insert into app.work_order_notes (work_order_id, position, note, icon)
  select v_id, row_number() over (order by ord), x.txt, nullif(btrim(t.n->>'icon'), '')
  from jsonb_array_elements(coalesce(p->'notes', '[]'::jsonb)) with ordinality as t(n, ord)
  cross join lateral (
    select btrim(case jsonb_typeof(t.n) when 'string' then t.n #>> '{}' when 'object' then t.n->>'text' end) as txt
  ) x
  where x.txt is not null and x.txt <> '';

  return v_id;
end $$;

revoke execute on function app.save_draft(uuid, jsonb) from public, anon;
grant execute on function app.save_draft(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------- #8: create_work_order never validated qty
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
  if exists (select 1 from app.work_order_lines where work_order_id = p_id and qty <= 0) then
    raise exception 'Every line must have a quantity greater than zero before creating.';   -- fix #8
  end if;

  perform set_config('app.bypass_edit_check', 'true', true);
  -- status_history + the notification are NOT inserted here: the work_orders_status_log AFTER
  -- UPDATE trigger (below) fires on this same UPDATE and logs both generically for every status
  -- change, wherever it originates. Inserting them here too would double them up.
  -- coalesce(wo_number, ...): a Work Order rejected by Finance comes back here as a draft and keeps
  -- its original number on resubmission rather than burning a second one from the counter.
  update app.work_orders
     set wo_number = coalesce(wo_number, app.next_wo_number(current_date)),
         status = 'pending_finance_approval', updated_by = auth.uid(), updated_at = now()
   where id = p_id
  returning * into v_wo;

  return v_wo;
end $$;

-- ---------------------------------------------------------------- #9: generate_invoice never bounded the GST rate
create or replace function app.generate_invoice(p_work_order_id uuid, p_gst_rate numeric, p_supply_type app.supply_type)
returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_invoice_id uuid;
  v_number text;
  v_subtotal numeric := 0;
  v_line record;
  v_amount numeric;
  v_cgst numeric := 0; v_sgst numeric := 0; v_igst numeric := 0; v_total numeric;
  v_seq int;
  v_status app.wo_status;
  v_billable_lines int;
begin
  if not app.current_role_in('md', 'admin') then raise exception 'Only MD may generate an invoice.'; end if;
  if p_gst_rate < 0 or p_gst_rate > 100 then raise exception 'GST rate must be between 0 and 100.'; end if;   -- fix #9

  select status into v_status from app.work_orders where id = p_work_order_id for update;   -- serialises two people billing at once
  if v_status is null then raise exception 'Work order % not found', p_work_order_id; end if;
  if v_status in ('draft', 'pending_finance_approval', 'cancelled') then
    raise exception 'Cannot generate an invoice before this Work Order is created and approved by Finance.';
  end if;

  -- What is ready to bill, per line: QC-approved minus already invoiced (only lines with something left).
  -- Counted first, so a refused request never takes an invoice number.
  select count(*) into v_billable_lines
  from app.work_order_lines l
  where coalesce((select sum(i.accepted_qty) from app.qc_inspections i where i.work_order_line_id = l.id), 0)
      - coalesce((select sum(il.qty) from app.invoice_lines il where il.work_order_line_id = l.id), 0) > 0
    and l.work_order_id = p_work_order_id;
  if v_billable_lines = 0 then
    raise exception 'Nothing is ready to bill: every QC-approved unit on this order has already been invoiced (or none has been approved yet).';
  end if;

  insert into app.wo_number_counters (fiscal_year_start, next_number) values (-1, 2)
  on conflict (fiscal_year_start) do update set next_number = app.wo_number_counters.next_number + 1
  returning next_number - 1 into v_seq;
  v_number := 'INV/' || app.fiscal_year_label(current_date) || '/' || lpad(v_seq::text, 4, '0');

  insert into app.invoices (work_order_id, invoice_number, gst_rate, supply_type, subtotal, grand_total)
  values (p_work_order_id, v_number, p_gst_rate, p_supply_type, 0, 0) returning id into v_invoice_id;

  for v_line in
    select l.id as work_order_line_id, l.description_snapshot as description, l.final_price as price,
           coalesce((select sum(i.accepted_qty) from app.qc_inspections i where i.work_order_line_id = l.id), 0)
             - coalesce((select sum(il.qty) from app.invoice_lines il where il.work_order_line_id = l.id), 0) as qty
    from app.work_order_lines l where l.work_order_id = p_work_order_id order by l.line_no
  loop
    continue when v_line.qty <= 0;
    v_amount := v_line.qty * v_line.price;
    v_subtotal := v_subtotal + v_amount;
    insert into app.invoice_lines (invoice_id, work_order_line_id, description, qty, price, amount)
    values (v_invoice_id, v_line.work_order_line_id, v_line.description, v_line.qty, v_line.price, v_amount);
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

revoke execute on function app.generate_invoice(uuid, numeric, app.supply_type) from public, anon;
grant execute on function app.generate_invoice(uuid, numeric, app.supply_type) to authenticated, service_role;

notify pgrst, 'reload schema';

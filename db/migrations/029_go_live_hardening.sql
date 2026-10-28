-- 029: go-live hardening, from a full architecture review before the company starts entering real data.
--
-- 1. A Work Order can only be INSERTED as a plain draft owned by the caller. Before, the insert policy checked only
--    the role, so a Creator could post a row straight to the API already "created" with a made-up number and skip
--    Finance approval. Every real path (save_draft) inserts a draft, so nothing legitimate changes.
-- 2. Quantities are protected by the database, not only by the app's functions:
--    * QC inspections can be written only by record_qc_inspection / reopen_held (the direct-insert policy is removed);
--    * production output can never exceed the ordered quantity, and QC submissions never exceed what was produced,
--      whichever way the row arrives.
-- 3. Internal helpers (recompute_work_order_status and two trigger functions) are no longer callable from the API.
-- 4. create_work_order checks the caller's role (a deactivated user could submit a draft they once created).
-- 5. update_work_order will not take a quantity below what has been written off by a scrap / re-produce decision
--    (it used to fail with a raw constraint error).
-- 6. Dates follow Indian time. The database clock is UTC, so between midnight and 5:30 am IST "today" was still
--    yesterday: wrong financial year on 1 April, wrong default production date for a night shift. app.today_ist()
--    is now used for numbering, defaults and the "not in the past" check.
-- 7. Delivery Challan numbers restart each financial year (DC/2027-28/0001), like Work Order numbers.
-- 8. Least privilege: append-only ledgers (history, approvals, invoices, inspections ...) lose UPDATE / DELETE rights
--    for signed-in users altogether. Row-level security already refused them; now the grant says so too, so a later
--    policy mistake cannot open them up.
-- 9. Indexes on the foreign keys the screens join and filter on.

-- ---------------------------------------------------------------- 6. India date
create or replace function app.today_ist() returns date
language sql stable set search_path = pg_catalog, pg_temp as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;
revoke all on function app.today_ist() from public, anon;
grant execute on function app.today_ist() to authenticated, service_role;

alter table app.work_orders alter column wo_date set default app.today_ist();
alter table app.production_entries alter column production_date set default app.today_ist();
alter function app.fiscal_year_label(date) set search_path = pg_catalog, pg_temp;

-- ---------------------------------------------------------------- 1. Work Orders are inserted as drafts only
drop policy if exists work_orders_insert on app.work_orders;
create policy work_orders_insert on app.work_orders for insert to authenticated
  with check (app.current_role_in('creator', 'md')
              and status = 'draft' and wo_number is null and revision = 0 and created_by = auth.uid());

-- ---------------------------------------------------------------- 2. quantity invariants
create or replace function app.check_production_output() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_line_qty numeric; v_so_far numeric;
begin
  if new.qty is null or new.qty <= 0 then raise exception 'Produced quantity must be above zero.'; end if;
  select qty into v_line_qty from app.work_order_lines where id = new.work_order_line_id for update;   -- serialises entries on a line
  select coalesce(sum(qty), 0) into v_so_far from app.production_output_lines where work_order_line_id = new.work_order_line_id;
  if v_so_far + new.qty > v_line_qty then
    raise exception 'Production would reach %, above the ordered quantity of %.', v_so_far + new.qty, v_line_qty;
  end if;
  return new;
end $$;

drop trigger if exists production_output_limit on app.production_output_lines;
create trigger production_output_limit before insert on app.production_output_lines
  for each row execute function app.check_production_output();

create or replace function app.check_qc_submission() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_produced numeric; v_sent numeric;
begin
  if new.qty is null or new.qty <= 0 then raise exception 'The quantity sent to QC must be above zero.'; end if;
  perform 1 from app.work_order_lines where id = new.work_order_line_id for update;
  select coalesce(sum(qty), 0) into v_produced from app.production_output_lines where work_order_line_id = new.work_order_line_id;
  select coalesce(sum(qty), 0) into v_sent from app.qc_submissions where work_order_line_id = new.work_order_line_id;
  if v_sent + new.qty > v_produced then
    raise exception 'Cannot send % to QC: only % of the % produced is not yet with QC.', new.qty, v_produced - v_sent, v_produced;
  end if;
  return new;
end $$;

drop trigger if exists qc_submission_limit on app.qc_submissions;
create trigger qc_submission_limit before insert on app.qc_submissions
  for each row execute function app.check_qc_submission();

-- Inspections are written only by record_qc_inspection and reopen_held (both security definer).
drop policy if exists qc_inspections_write on app.qc_inspections;

-- ---------------------------------------------------------------- 3. internal helpers are not API
revoke execute on function app.recompute_work_order_status(uuid) from public, anon, authenticated;
revoke execute on function app.parts_weight_limits_guard() from public, anon, authenticated;
revoke execute on function app.check_production_output() from public, anon, authenticated;
revoke execute on function app.check_qc_submission() from public, anon, authenticated;

-- ---------------------------------------------------------------- 4 + 6. create_work_order
-- Identical to the live body, plus a role check and the India date.
create or replace function app.create_work_order(p_id uuid) returns app.work_orders
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_wo app.work_orders;
  v_line_count int;
begin
  if not app.current_role_in('creator', 'md', 'admin') then
    raise exception 'Only the Work Order Master Creator or the MD may create a Work Order.';
  end if;
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
    raise exception 'Every line must have a quantity greater than zero before creating.';
  end if;

  perform set_config('app.bypass_edit_check', 'true', true);
  -- status_history + the notification come from the work_orders_status_log trigger on this same UPDATE.
  -- coalesce(wo_number, ...): a Work Order rejected by Finance comes back here as a draft and keeps its number.
  update app.work_orders
     set wo_number = coalesce(wo_number, app.next_wo_number(app.today_ist())),
         status = 'pending_finance_approval', updated_by = auth.uid(), updated_at = now()
   where id = p_id
  returning * into v_wo;

  return v_wo;
end $$;

revoke execute on function app.create_work_order(uuid) from public, anon;
grant execute on function app.create_work_order(uuid) to authenticated;

-- ---------------------------------------------------------------- 7. challan numbers restart each financial year
-- The counter row for a financial year is keyed -(its start year), e.g. -2026. (-1 was the old invoice counter,
-- -2 the first challan counter.) Carry the running number across for 2026-27 so no number is repeated.
insert into app.wo_number_counters (fiscal_year_start, next_number)
select -2026, next_number from app.wo_number_counters where fiscal_year_start = -2
on conflict (fiscal_year_start) do nothing;

create or replace function app.generate_challan(p_work_order_id uuid) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_id uuid;
  v_number text;
  v_value numeric := 0;
  v_line record;
  v_seq int;
  v_status app.wo_status;
  v_deliverable_lines int;
  v_today date := app.today_ist();
  v_fy int := case when extract(month from app.today_ist()) < 4
                   then extract(year from app.today_ist())::int - 1
                   else extract(year from app.today_ist())::int end;
begin
  if not app.current_role_in('md', 'admin') then raise exception 'Only MD or Admin may create a delivery challan.'; end if;

  select status into v_status from app.work_orders where id = p_work_order_id for update;   -- serialises two people at once
  if v_status is null then raise exception 'Work order % not found', p_work_order_id; end if;
  if v_status in ('draft', 'pending_finance_approval', 'cancelled') then
    raise exception 'Cannot create a delivery challan before this Work Order is created and approved by Finance.';
  end if;

  -- What is ready to go, per line: QC-approved minus what is already on a challan/invoice. Counted first, so a
  -- refused request never takes a number.
  select count(*) into v_deliverable_lines
  from app.work_order_lines l
  where coalesce((select sum(i.accepted_qty) from app.qc_inspections i where i.work_order_line_id = l.id), 0)
      - coalesce((select sum(il.qty) from app.invoice_lines il where il.work_order_line_id = l.id), 0) > 0
    and l.work_order_id = p_work_order_id;
  if v_deliverable_lines = 0 then
    raise exception 'Nothing is ready to deliver: every QC-approved unit on this order is already on a delivery challan (or none has been approved yet).';
  end if;

  insert into app.wo_number_counters (fiscal_year_start, next_number) values (-v_fy, 2)
  on conflict (fiscal_year_start) do update set next_number = app.wo_number_counters.next_number + 1
  returning next_number - 1 into v_seq;
  v_number := 'DC/' || app.fiscal_year_label(v_today) || '/' || lpad(v_seq::text, 4, '0');

  insert into app.invoices (work_order_id, invoice_number, kind, gst_rate, supply_type, subtotal, grand_total)
  values (p_work_order_id, v_number, 'challan', 0, 'intra', 0, 0) returning id into v_id;

  for v_line in
    select l.id as work_order_line_id, l.description_snapshot as description, l.final_price as price,
           coalesce((select sum(i.accepted_qty) from app.qc_inspections i where i.work_order_line_id = l.id), 0)
             - coalesce((select sum(il.qty) from app.invoice_lines il where il.work_order_line_id = l.id), 0) as qty
    from app.work_order_lines l where l.work_order_id = p_work_order_id order by l.line_no
  loop
    continue when v_line.qty <= 0;
    v_value := v_value + v_line.qty * v_line.price;
    insert into app.invoice_lines (invoice_id, work_order_line_id, description, qty, price, amount)
    values (v_id, v_line.work_order_line_id, v_line.description, v_line.qty, v_line.price, v_line.qty * v_line.price);
  end loop;

  -- no tax on a challan: the recorded value is just the goods at the order price
  update app.invoices set subtotal = v_value, grand_total = v_value, generated_by = auth.uid() where id = v_id;
  return v_id;
end $$;

revoke execute on function app.generate_challan(uuid) from public, anon;
grant execute on function app.generate_challan(uuid) to authenticated;
grant execute on function app.generate_challan(uuid) to service_role;

-- ---------------------------------------------------------------- 5 + 6. decide_rejection (India date for "not in the past")
create or replace function app.decide_rejection(p_rejection_id uuid, p_action text, p_qty numeric, p_note text,
                                                p_new_price numeric default null, p_new_delivery_date date default null) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_rej app.qc_rejections; v_line app.work_order_lines; v_wo app.work_orders;
  v_open numeric; v_dec uuid; v_new_line uuid; v_line_no int; v_price numeric; v_summary text;
  v_new_date date;
begin
  if not app.current_role_in('finance', 'md', 'admin') then raise exception 'Only Finance or the MD may decide on a rejection.'; end if;
  if p_action not in ('scrap', 'reproduce') then raise exception 'Choose Scrap or Re-produce.'; end if;
  if nullif(btrim(p_note), '') is null then raise exception 'Please give a note explaining the decision.'; end if;
  if p_action = 'scrap' and (p_new_price is not null or p_new_delivery_date is not null) then
    raise exception 'A price or delivery date applies only to a re-produce decision.';
  end if;

  select * into v_rej from app.qc_rejections where id = p_rejection_id for update;
  if v_rej.id is null then raise exception 'Rejection not found.'; end if;
  if v_rej.status <> 'awaiting_decision' then raise exception 'This rejection has already been decided or withdrawn.'; end if;
  select * into v_line from app.work_order_lines where id = v_rej.work_order_line_id for update;
  select * into v_wo from app.work_orders where id = v_line.work_order_id for update;
  if v_wo.status in ('draft', 'pending_finance_approval', 'cancelled', 'completed') then
    raise exception 'A % Work Order cannot take this decision.', v_wo.status;
  end if;

  select v_rej.qty - coalesce(sum(qty), 0) into v_open from app.qc_rejection_decisions where rejection_id = v_rej.id;
  if p_qty is null or p_qty <= 0 or p_qty > v_open then
    raise exception 'Quantity must be between 0 and % (the units still awaiting a decision).', v_open;
  end if;
  if p_new_price is not null and p_new_price < 0 then raise exception 'Price cannot be negative.'; end if;
  v_new_date := p_new_delivery_date;
  if v_new_date is not null and v_new_date < app.today_ist() then raise exception 'The new delivery date cannot be in the past.'; end if;

  v_summary := case p_action when 'scrap' then format('QC decision: %s unit(s) of %s scrapped', p_qty, v_line.part_no_snapshot)
                              else format('QC decision: %s unit(s) of %s re-produced', p_qty, v_line.part_no_snapshot) end;

  perform set_config('app.bypass_edit_check', 'true', true);

  -- the order as it was, before this decision changes it
  insert into app.work_order_revisions (work_order_id, revision, snapshot, changed_by, change_summary)
  values (v_wo.id, v_wo.revision,
          to_jsonb(v_wo) || jsonb_build_object('lines',
            (select coalesce(jsonb_agg(to_jsonb(l.*) order by l.line_no), '[]') from app.work_order_lines l where l.work_order_id = v_wo.id)),
          auth.uid(), v_summary || ' — ' || btrim(p_note));

  update app.work_order_lines set short_closed_qty = short_closed_qty + p_qty where id = v_line.id;

  if p_action = 'reproduce' then
    v_price := coalesce(p_new_price, v_line.final_price);
    select coalesce(max(line_no), 0) + 1 into v_line_no from app.work_order_lines where work_order_id = v_wo.id;
    insert into app.work_order_lines (
      work_order_id, line_no, part_id, part_no_snapshot, description_snapshot, uom_snapshot, standard_weight_kg_snapshot,
      category_snapshot, standard_price_snapshot, final_price, qty, remarks, customer_ref, replaces_line_id)
    values (v_wo.id, v_line_no, v_line.part_id, v_line.part_no_snapshot, v_line.description_snapshot, v_line.uom_snapshot,
            v_line.standard_weight_kg_snapshot, v_line.category_snapshot, v_line.standard_price_snapshot, v_price, p_qty,
            format('Replacement for rejected units of line %s', v_line.line_no), v_line.customer_ref, v_line.id)
    returning id into v_new_line;
    insert into app.work_order_line_prices (work_order_line_id, customer_price)
      select v_new_line, customer_price from app.work_order_line_prices where work_order_line_id = v_line.id;
  end if;

  insert into app.qc_rejection_decisions (rejection_id, action, qty, note, replacement_line_id, new_price, new_delivery_date, decided_by)
  values (v_rej.id, p_action, p_qty, btrim(p_note), v_new_line, case when p_action = 'reproduce' then v_price end, v_new_date, auth.uid())
  returning id into v_dec;

  if p_qty = v_open then update app.qc_rejections set status = 'decided' where id = v_rej.id; end if;

  update app.work_orders
     set revision = revision + 1,
         delivery_date = coalesce(v_new_date, delivery_date),
         updated_by = auth.uid(), updated_at = now()
   where id = v_wo.id;

  perform app.recompute_work_order_status(v_wo.id);
  return v_dec;
end $$;

revoke execute on function app.decide_rejection(uuid, text, numeric, text, numeric, date) from public, anon;
grant execute on function app.decide_rejection(uuid, text, numeric, text, numeric, date) to authenticated;

-- ---------------------------------------------------------------- 5. update_work_order
-- Identical to the live body, except the quantity floor also counts units already written off.
create or replace function app.update_work_order(p_work_order_id uuid, p jsonb) returns integer
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_wo app.work_orders;
  v_released boolean;
  v_changes text[] := '{}';
  v_new_date date;
  v_new_ref text;
  v_new_sp uuid;
  v_l jsonb;
  v_line app.work_order_lines;
  v_qty numeric; v_price numeric; v_floor numeric; v_cprice numeric; v_old_cprice numeric;
begin
  if not app.current_role_in('md', 'admin') then raise exception 'Only the MD may edit a Work Order.'; end if;

  select * into v_wo from app.work_orders where id = p_work_order_id for update;
  if v_wo is null then raise exception 'Work order % not found', p_work_order_id; end if;
  if v_wo.status in ('draft', 'cancelled', 'completed') then
    raise exception 'A % Work Order cannot be edited here.', v_wo.status;
  end if;
  v_released := v_wo.status <> 'pending_finance_approval';   -- nothing has gone to the floor before approval

  -- validate + collect the changes first (nothing is written until every line has passed)
  if p ? 'delivery_date' then
    v_new_date := nullif(p->>'delivery_date', '')::date;
    if v_new_date is distinct from v_wo.delivery_date then v_changes := v_changes || format('delivery date %s -> %s', v_wo.delivery_date, v_new_date); end if;
  else v_new_date := v_wo.delivery_date; end if;
  if p ? 'doc_ref' then
    v_new_ref := nullif(btrim(p->>'doc_ref'), '');
    if v_new_ref is distinct from v_wo.doc_ref then v_changes := array_append(v_changes, 'document reference'); end if;
  else v_new_ref := v_wo.doc_ref; end if;
  if p ? 'sales_person_id' then
    v_new_sp := nullif(p->>'sales_person_id', '')::uuid;
    if v_new_sp is distinct from v_wo.sales_person_id then v_changes := array_append(v_changes, 'sales person'); end if;
  else v_new_sp := v_wo.sales_person_id; end if;

  for v_l in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    select * into v_line from app.work_order_lines where id = (v_l->>'id')::uuid and work_order_id = p_work_order_id;
    if v_line.id is null then raise exception 'Line % does not belong to this Work Order.', v_l->>'id'; end if;
    select cp.customer_price into v_old_cprice from app.work_order_line_prices cp where cp.work_order_line_id = v_line.id;
    v_qty := coalesce((v_l->>'qty')::numeric, v_line.qty);
    v_price := coalesce((v_l->>'final_price')::numeric, v_line.final_price);
    if v_l ? 'customer_price' then v_cprice := nullif(btrim(v_l->>'customer_price'), '')::numeric; else v_cprice := v_old_cprice; end if;
    if v_cprice < 0 then raise exception 'Line %: customer price cannot be negative.', v_line.part_no_snapshot; end if;
    if v_qty <= 0 then raise exception 'Line %: quantity must be above zero.', v_line.part_no_snapshot; end if;
    if v_price < 0 then raise exception 'Line %: price cannot be negative.', v_line.part_no_snapshot; end if;
    -- never below what has already been made, billed or written off
    select greatest(
      coalesce((select sum(o.qty) from app.production_output_lines o where o.work_order_line_id = v_line.id), 0),
      coalesce((select sum(il.qty) from app.invoice_lines il where il.work_order_line_id = v_line.id), 0),
      v_line.short_closed_qty) into v_floor;
    if v_qty < v_floor then
      raise exception 'Line %: quantity cannot go below %, which is already produced, billed or written off.', v_line.part_no_snapshot, v_floor;
    end if;
    if v_qty is distinct from v_line.qty then v_changes := v_changes || format('%s qty %s -> %s', v_line.part_no_snapshot, v_line.qty, v_qty); end if;
    if v_price is distinct from v_line.final_price then v_changes := v_changes || format('%s price %s -> %s', v_line.part_no_snapshot, v_line.final_price, v_price); end if;
    -- the figures are deliberately not written here: revisions are readable by every role
    if v_cprice is distinct from v_old_cprice then v_changes := v_changes || format('%s customer price changed', v_line.part_no_snapshot); end if;
  end loop;

  if cardinality(v_changes) = 0 then return v_wo.revision; end if;   -- nothing actually changed

  perform set_config('app.bypass_edit_check', 'true', true);

  if v_released then
    insert into app.work_order_revisions (work_order_id, revision, snapshot, changed_by, change_summary)
    values (v_wo.id, v_wo.revision,
            to_jsonb(v_wo) || jsonb_build_object('lines',
              (select coalesce(jsonb_agg(to_jsonb(l.*) order by l.line_no), '[]') from app.work_order_lines l where l.work_order_id = v_wo.id)),
            auth.uid(), 'MD edit: ' || array_to_string(v_changes, '; '));
  end if;

  for v_l in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    update app.work_order_lines
       set qty = coalesce((v_l->>'qty')::numeric, qty), final_price = coalesce((v_l->>'final_price')::numeric, final_price)
     where id = (v_l->>'id')::uuid;
    if v_l ? 'customer_price' then
      if nullif(btrim(v_l->>'customer_price'), '') is null then
        delete from app.work_order_line_prices where work_order_line_id = (v_l->>'id')::uuid;
      else
        insert into app.work_order_line_prices (work_order_line_id, customer_price)
        values ((v_l->>'id')::uuid, nullif(btrim(v_l->>'customer_price'), '')::numeric)
        on conflict (work_order_line_id) do update set customer_price = excluded.customer_price;
      end if;
    end if;
  end loop;

  update app.work_orders
     set delivery_date = v_new_date, doc_ref = v_new_ref, sales_person_id = v_new_sp,
         revision = case when v_released then revision + 1 else revision end,
         updated_by = auth.uid(), updated_at = now()
   where id = v_wo.id
  returning revision into v_wo.revision;

  return v_wo.revision;
end $$;

revoke execute on function app.update_work_order(uuid, jsonb) from public, anon;
grant execute on function app.update_work_order(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------- 8. least privilege
-- Read-only (their writes all come from security-definer functions or triggers).
revoke insert, update, delete on app.audit_events, app.completion_date_changes, app.finance_approvals,
  app.invoice_lines, app.invoices, app.status_history, app.work_order_revisions, app.qc_inspections from authenticated;
revoke all on app.wo_number_counters from authenticated;
-- Insert-only ledgers: a production entry, an output line or a QC submission is never edited or deleted.
revoke update, delete on app.production_entries, app.production_output_lines, app.qc_submissions from authenticated;
-- Users and notifications are read and updated, never inserted or deleted, by a signed-in user.
revoke insert, delete on app.users, app.notifications from authenticated;
revoke update on app.attachments from authenticated;
revoke delete on app.work_orders from authenticated;

-- ---------------------------------------------------------------- 9. indexes on foreign keys
create index if not exists ix_attachments_work_order on app.attachments (work_order_id);
create index if not exists ix_attachments_qc_inspection on app.attachments (qc_inspection_id);
create index if not exists ix_completion_changes_wo on app.completion_date_changes (work_order_id);
create index if not exists ix_delivery_locations_partner on app.delivery_locations (partner_id);
create index if not exists ix_delivery_locations_address on app.delivery_locations (address_id);
create index if not exists ix_invoice_lines_invoice on app.invoice_lines (invoice_id);
create index if not exists ix_invoice_lines_wo_line on app.invoice_lines (work_order_line_id);
create index if not exists ix_notifications_user on app.notifications (user_id);
create index if not exists ix_notifications_wo on app.notifications (work_order_id);
create index if not exists ix_partner_addresses_partner on app.partner_addresses (partner_id);
create index if not exists ix_partner_contacts_partner on app.partner_contacts (partner_id);
create index if not exists ix_parts_category on app.parts (category_id);
create index if not exists ix_production_entries_wo on app.production_entries (work_order_id);
create index if not exists ix_production_entries_shift on app.production_entries (shift_id);
create index if not exists ix_production_entries_supervisor on app.production_entries (supervisor_id);
create index if not exists ix_production_output_entry on app.production_output_lines (production_entry_id);
create index if not exists ix_production_output_line on app.production_output_lines (work_order_line_id);
create index if not exists ix_qc_inspections_line on app.qc_inspections (work_order_line_id);
create index if not exists ix_qc_rejections_inspection on app.qc_rejections (qc_inspection_id);
create index if not exists ix_qc_rejections_reason on app.qc_rejections (reason_id);
create index if not exists ix_qc_submissions_line on app.qc_submissions (work_order_line_id);
create index if not exists ix_status_history_wo on app.status_history (work_order_id);
create index if not exists ix_wo_lines_part on app.work_order_lines (part_id);
create index if not exists ix_wo_lines_replaces on app.work_order_lines (replaces_line_id);
create index if not exists ix_work_orders_category on app.work_orders (category_id);
create index if not exists ix_work_orders_location on app.work_orders (delivery_location_id);
create index if not exists ix_work_orders_sales_person on app.work_orders (sales_person_id);
create index if not exists ix_work_orders_status on app.work_orders (status);

notify pgrst, 'reload schema';

-- 020: Supervisor on every production entry (new Supervisors master) and a recorded reason whenever the
-- Planned Completion Date is changed.
--
-- 1. Supervisors master (Item Master > Supervisors tab). Same access as the other masters: everyone signed in
--    may read, Creator/MD/Admin may write. Nothing is deleted, a supervisor is deactivated.
-- 2. production_entries.supervisor_id: record_production now requires an active supervisor for every new
--    daily entry (older entries have none and stay as they were).
-- 3. Planned Completion Date (the existing expected_completion_date column, renamed on screen):
--    * every change is logged in completion_date_changes (before, after, who, when, WHY) — for Planner, MD and
--      Admin alike (before, only the Planner's changes were logged);
--    * changing a date that is already set REQUIRES a reason, enforced here in the database, so it cannot be
--      skipped by calling the API directly; the first time a date is set no reason is needed;
--    * the app uses app.set_completion_date(...), which carries the reason into the log;
--    * the date can no longer be cleared (the log needs a date to record).
create table if not exists app.supervisors (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  phone      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

alter table app.supervisors enable row level security;
drop policy if exists supervisors_select on app.supervisors;
create policy supervisors_select on app.supervisors for select to authenticated using (true);
drop policy if exists supervisors_write on app.supervisors;
create policy supervisors_write on app.supervisors for all to authenticated
  using (app.current_role_in('creator', 'md', 'admin'))
  with check (app.current_role_in('creator', 'md', 'admin'));

revoke all on app.supervisors from public, anon;
grant select, insert, update, delete on app.supervisors to authenticated;
grant all on app.supervisors to service_role;

alter table app.production_entries add column if not exists supervisor_id uuid references app.supervisors(id);

-- ---------------------------------------------------------------- the edit-guard trigger
-- Identical to 007's except: (a) completion-date changes are validated and logged for every role that may make
-- them, with the reason; (b) the Planner's "may change only the completion date" check now also covers Sales
-- Person and GSM, which were added after 007 and were missing from that list.
create or replace function app.enforce_work_order_edit() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_role app.user_role := app.current_role();
  v_business_changed boolean;
  v_reason text;
begin
  if current_setting('app.bypass_edit_check', true) = 'true' then
    return new;   -- internal system update (status recompute, create/approve/reject) — already validated there
  end if;

  if (old.status, old.wo_number, old.revision, old.created_by)
     is distinct from (new.status, new.wo_number, new.revision, new.created_by) then
    raise exception 'Status, Work Order number and revision change only through the app''s own actions, not by editing the record.';
  end if;

  if new.expected_completion_date is distinct from old.expected_completion_date then
    if v_role not in ('planner', 'md', 'admin') then
      raise exception 'Only the Production Planner sets the Planned Completion Date.';
    end if;
    if new.expected_completion_date is null then
      raise exception 'The Planned Completion Date cannot be cleared; choose a new date.';
    end if;
    v_reason := nullif(btrim(coalesce(current_setting('app.completion_reason', true), '')), '');
    if old.expected_completion_date is not null and v_reason is null then
      raise exception 'Please give a reason for changing the Planned Completion Date.';
    end if;
    insert into app.completion_date_changes (work_order_id, from_date, to_date, reason, changed_by)
      values (old.id, old.expected_completion_date, new.expected_completion_date, v_reason, auth.uid());
  end if;

  if v_role in ('md', 'admin') then
    null;   -- allowed; falls through to revisioning below
  elsif v_role = 'creator' then
    if old.status not in ('draft', 'pending_finance_approval') then
      raise exception 'Once Finance has approved a Work Order, only the MD may edit it.';
    end if;
  elsif v_role = 'planner' then
    if (old.partner_id, old.delivery_location_id, old.wo_date,
        old.delivery_date, old.doc_ref, old.sales_person_id, old.test_cert_required, old.inspection_report_required,
        old.gsm_required, old.gsm_inner, old.gsm_outer,
        old.additional_notes, old.packing_required, old.units_per_bundle, old.pallet_height_in,
        old.separate_vehicle_required, old.transport_notes)
       is distinct from
       (new.partner_id, new.delivery_location_id, new.wo_date,
        new.delivery_date, new.doc_ref, new.sales_person_id, new.test_cert_required, new.inspection_report_required,
        new.gsm_required, new.gsm_inner, new.gsm_outer,
        new.additional_notes, new.packing_required, new.units_per_bundle, new.pallet_height_in,
        new.separate_vehicle_required, new.transport_notes) then
      raise exception 'Production Planner may change only the Planned Completion Date.';
    end if;
    new.updated_by := auth.uid(); new.updated_at := now();
    return new;
  else
    raise exception 'Role % may not edit Work Orders', v_role;
  end if;

  -- Any business-field change after release opens a new revision, preserving the prior snapshot (§6).
  v_business_changed := (old.delivery_date, old.doc_ref, old.test_cert_required, old.inspection_report_required,
                          old.additional_notes, old.packing_required, old.units_per_bundle, old.pallet_height_in,
                          old.separate_vehicle_required, old.transport_notes)
                     is distinct from
                         (new.delivery_date, new.doc_ref, new.test_cert_required, new.inspection_report_required,
                          new.additional_notes, new.packing_required, new.units_per_bundle, new.pallet_height_in,
                          new.separate_vehicle_required, new.transport_notes);
  if v_business_changed and old.status not in ('draft', 'pending_finance_approval') then
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

-- ---------------------------------------------------------------- set / change the Planned Completion Date
create or replace function app.set_completion_date(p_work_order_id uuid, p_date date, p_reason text default null) returns void
language plpgsql security invoker set search_path = app, pg_temp as $$
declare v_status app.wo_status;
begin
  if not app.current_role_in('planner', 'md', 'admin') then
    raise exception 'Only the Production Planner (or MD) sets the Planned Completion Date.';
  end if;
  if p_date is null then raise exception 'Choose a date.'; end if;
  select status into v_status from app.work_orders where id = p_work_order_id;
  if v_status is null then raise exception 'Work order % not found', p_work_order_id; end if;
  if v_status not in ('created', 'in_production', 'qc_pending', 'partially_qc_approved', 'ready_for_dispatch') then
    raise exception 'A % Work Order has no Planned Completion Date to set.', v_status;
  end if;
  perform set_config('app.completion_reason', coalesce(btrim(p_reason), ''), true);
  update app.work_orders set expected_completion_date = p_date where id = p_work_order_id;
end $$;

revoke execute on function app.set_completion_date(uuid, date, text) from public, anon;
grant execute on function app.set_completion_date(uuid, date, text) to authenticated;

-- ---------------------------------------------------------------- record_production: Supervisor required
-- Identical to 012's, plus supervisor_id (an active supervisor from the master).
create or replace function app.record_production(p jsonb) returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_entry_id uuid;
  v_line record;
  v_produced_so_far numeric;
  v_qty numeric;
  v_wo_status app.wo_status;
  v_supervisor uuid := nullif(btrim(p->>'supervisor_id'), '')::uuid;
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

  if v_supervisor is null then raise exception 'Choose the Supervisor for this production entry.'; end if;
  if not exists (select 1 from app.supervisors where id = v_supervisor and is_active) then
    raise exception 'That Supervisor is not available; choose an active one.';
  end if;

  insert into app.production_entries (work_order_id, production_date, shift_id, labour_count, supervisor_id, planner_id)
  values ((p->>'work_order_id')::uuid, coalesce((p->>'production_date')::date, current_date),
          (p->>'shift_id')::uuid, (p->>'labour_count')::int, v_supervisor, auth.uid())
  returning id into v_entry_id;

  for v_line in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) as x(v) loop
    v_qty := (v_line.v->>'qty')::numeric;
    continue when v_qty is null or v_qty <= 0;

    perform 1 from app.work_order_lines where id = (v_line.v->>'work_order_line_id')::uuid for update;   -- serialise concurrent entries on this line

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

revoke execute on function app.record_production(jsonb) from public, anon;
grant execute on function app.record_production(jsonb) to authenticated;

-- ---------------------------------------------------------------- backup export allow-list
create or replace function app.export_table(p_table text) returns jsonb
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_rows jsonb;
begin
  if not app.current_role_in('md', 'admin') then
    raise exception 'Only MD or Admin may export data.';
  end if;
  if p_table not in (
    'users', 'categories', 'shifts', 'parts', 'business_partners', 'partner_addresses', 'partner_contacts',
    'delivery_locations', 'wo_number_counters', 'work_orders', 'work_order_lines', 'work_order_line_prices',
    'work_order_notes', 'work_order_revisions', 'status_history', 'completion_date_changes', 'finance_approvals',
    'production_entries', 'production_output_lines', 'qc_submissions', 'qc_inspections', 'attachments',
    'invoices', 'invoice_lines', 'notifications', 'audit_events', 'sales_persons', 'supervisors'
  ) then
    raise exception 'Unknown table: %', p_table;
  end if;

  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from app.%I t', p_table) into v_rows;
  return v_rows;
end $$;

revoke execute on function app.export_table(text) from public, anon;
grant execute on function app.export_table(text) to authenticated;

notify pgrst, 'reload schema';

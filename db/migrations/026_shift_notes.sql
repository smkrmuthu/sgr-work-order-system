-- 026: shift notes on a production entry.
--
-- A daily production entry (one shift) can carry notes written as separate points, like the Additional Notes on a
-- Work Order: "Machine 2 down 40 min", "New operator on the line". One row per point, saved together with the entry,
-- and kept permanently (like the rest of the entry, they are not edited afterwards). The per-line Note stays as it was.
create table if not exists app.production_entry_notes (
  id                  uuid primary key default gen_random_uuid(),
  production_entry_id uuid not null references app.production_entries(id) on delete cascade,
  position            int not null,
  note                text not null check (char_length(note) <= 500),
  created_at          timestamptz not null default now()
);
create index if not exists production_entry_notes_idx on app.production_entry_notes (production_entry_id, position);
alter table app.production_entry_notes enable row level security;
drop policy if exists production_entry_notes_select on app.production_entry_notes;
create policy production_entry_notes_select on app.production_entry_notes for select to authenticated using (true);
drop policy if exists production_entry_notes_insert on app.production_entry_notes;
create policy production_entry_notes_insert on app.production_entry_notes for insert to authenticated
  with check (app.current_role_in('planner', 'md', 'admin'));
revoke all on app.production_entry_notes from public, anon;
grant select, insert on app.production_entry_notes to authenticated;
grant all on app.production_entry_notes to service_role;

-- record_production: identical to 025's, plus the notes.
create or replace function app.record_production(p jsonb) returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_entry_id uuid;
  v_line record;
  v_produced_so_far numeric;
  v_reserved numeric;
  v_qty numeric;
  v_wo_status app.wo_status;
  v_supervisor uuid := nullif(btrim(p->>'supervisor_id'), '')::uuid;
  v_unit_g numeric;
  v_std_kg numeric;
  v_part text;
  v_max_pct numeric;
  v_min_pct numeric;
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

  -- Shift notes: separate points, one row each (blank ones dropped). Same shape as a Work Order's notes.
  insert into app.production_entry_notes (production_entry_id, position, note)
  select v_entry_id, row_number() over (order by ord), x.txt
  from jsonb_array_elements(coalesce(p->'notes', '[]'::jsonb)) with ordinality as t(n, ord)
  cross join lateral (
    select btrim(case jsonb_typeof(t.n) when 'string' then t.n #>> '{}' when 'object' then t.n->>'text' end) as txt
  ) x
  where x.txt is not null and x.txt <> '';

  for v_line in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) as x(v) loop
    v_qty := (v_line.v->>'qty')::numeric;
    continue when v_qty is null or v_qty <= 0;

    perform 1 from app.work_order_lines where id = (v_line.v->>'work_order_line_id')::uuid for update;   -- serialise concurrent entries on this line

    -- Weight of ONE unit, in grams, measured by the Planner. Required, and kept within the part's limits from the
    -- Item Master: at most max% above the standard weight (default 15%) and, if a minimum is set, at most min%
    -- below it. The standard weight is the order line's snapshot; the percentages are the Item Master's current ones.
    select l.part_no_snapshot, l.standard_weight_kg_snapshot, coalesce(p.weight_tol_max_pct, 15), p.weight_tol_min_pct
      into v_part, v_std_kg, v_max_pct, v_min_pct
      from app.work_order_lines l left join app.parts p on p.id = l.part_id
     where l.id = (v_line.v->>'work_order_line_id')::uuid;
    v_unit_g := nullif(btrim(v_line.v->>'unit_weight_g'), '')::numeric;
    if v_unit_g is null or v_unit_g <= 0 then
      raise exception '%', format('Line %s: enter the weight of one unit (in grams).', v_part);
    end if;
    if v_std_kg > 0 and v_unit_g > v_std_kg * 1000 * (1 + v_max_pct / 100) then
      raise exception '%', format('Line %s: one unit weighs %s g, more than %s%% above the standard %s g (limit %s g).',
        v_part, trim_scale(round(v_unit_g, 2)), trim_scale(round(v_max_pct, 2)), trim_scale(round(v_std_kg * 1000, 2)), trim_scale(round(v_std_kg * 1000 * (1 + v_max_pct / 100), 2)));
    end if;
    if v_std_kg > 0 and v_min_pct is not null and v_unit_g < v_std_kg * 1000 * (1 - v_min_pct / 100) then
      raise exception '%', format('Line %s: one unit weighs %s g, more than %s%% below the standard %s g (minimum %s g).',
        v_part, trim_scale(round(v_unit_g, 2)), trim_scale(round(v_min_pct, 2)), trim_scale(round(v_std_kg * 1000, 2)), trim_scale(round(v_std_kg * 1000 * (1 - v_min_pct / 100), 2)));
    end if;

    select coalesce(sum(o.qty), 0) into v_produced_so_far
      from app.production_output_lines o where o.work_order_line_id = (v_line.v->>'work_order_line_id')::uuid;

    -- Capacity of the line: what was ordered, less units already written off (short-closed) and units rejected
    -- at production that are still waiting for a decision (025).
    select coalesce(sum(r.qty - coalesce((select sum(d.qty) from app.qc_rejection_decisions d where d.rejection_id = r.id), 0)), 0)
      into v_reserved
      from app.qc_rejections r
     where r.work_order_line_id = (v_line.v->>'work_order_line_id')::uuid and r.source = 'production' and r.status = 'awaiting_decision';

    if v_produced_so_far + v_qty + v_reserved > (select l.qty - l.short_closed_qty from app.work_order_lines l where l.id = (v_line.v->>'work_order_line_id')::uuid) then
      raise exception 'Line %: % would take produced to %, above the ordered quantity.',
        (v_line.v->>'work_order_line_id')::uuid, v_qty, v_produced_so_far + v_qty;
    end if;

    insert into app.production_output_lines (production_entry_id, work_order_line_id, qty, unit_weight_g, actual_weight_kg, note)
    values (v_entry_id, (v_line.v->>'work_order_line_id')::uuid, v_qty, v_unit_g,
            round(v_qty * v_unit_g / 1000, 4), v_line.v->>'note');
  end loop;

  return v_entry_id;
end $$;

revoke execute on function app.record_production(jsonb) from public, anon;
grant execute on function app.record_production(jsonb) to authenticated;

-- backup export allow-list
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
    'invoices', 'invoice_lines', 'notifications', 'audit_events', 'sales_persons', 'supervisors',
    'qc_reject_reasons', 'qc_rejections', 'qc_rejection_decisions', 'production_entry_notes'
  ) then
    raise exception 'Unknown table: %', p_table;
  end if;

  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from app.%I t', p_table) into v_rows;
  return v_rows;
end $$;

revoke execute on function app.export_table(text) from public, anon;
grant execute on function app.export_table(text) to authenticated;

notify pgrst, 'reload schema';

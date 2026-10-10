-- 023: weight of ONE unit on every production entry line, and the 15% limit.
--
-- The Planner now types the weight of a single unit (in grams); the total weight is calculated by the database
-- (qty x unit weight / 1000, in kg) and stored in actual_weight_kg, so the two can never disagree. A unit heavier
-- than 15% above the part's standard weight is refused (the standard is the line's snapshot, e.g. 0.82 kg -> limit
-- 943 g). Only the upper limit applies for now. The weight is required for every new entry line.
-- Earlier entries keep their total and have no unit weight (null).
alter table app.production_output_lines add column if not exists unit_weight_g numeric(10,2);
alter table app.production_output_lines drop constraint if exists production_output_unit_weight_positive;
alter table app.production_output_lines add constraint production_output_unit_weight_positive
  check (unit_weight_g is null or unit_weight_g > 0);

-- record_production: identical to 020's, plus the unit weight (required, capped at +15% of standard).
create or replace function app.record_production(p jsonb) returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_entry_id uuid;
  v_line record;
  v_produced_so_far numeric;
  v_qty numeric;
  v_wo_status app.wo_status;
  v_supervisor uuid := nullif(btrim(p->>'supervisor_id'), '')::uuid;
  v_unit_g numeric;
  v_std_kg numeric;
  v_part text;
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

    -- Weight of ONE unit, in grams, measured by the Planner. Required, and never more than 15% above the part's
    -- standard weight (anything heavier is not accepted here; what to do with it, e.g. scrap, is decided separately).
    select l.part_no_snapshot, l.standard_weight_kg_snapshot into v_part, v_std_kg
      from app.work_order_lines l where l.id = (v_line.v->>'work_order_line_id')::uuid;
    v_unit_g := nullif(btrim(v_line.v->>'unit_weight_g'), '')::numeric;
    if v_unit_g is null or v_unit_g <= 0 then
      raise exception 'Line %: enter the weight of one unit (in grams).', v_part;
    end if;
    if v_std_kg > 0 and v_unit_g > v_std_kg * 1150 then
      raise exception 'Line %: one unit weighs % g, more than 15%% above the standard % g (limit % g).',
        v_part, round(v_unit_g, 2), round(v_std_kg * 1000, 2), round(v_std_kg * 1150, 2);
    end if;

    select coalesce(sum(o.qty), 0) into v_produced_so_far
      from app.production_output_lines o where o.work_order_line_id = (v_line.v->>'work_order_line_id')::uuid;

    if v_produced_so_far + v_qty > (select l.qty from app.work_order_lines l where l.id = (v_line.v->>'work_order_line_id')::uuid) then
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

notify pgrst, 'reload schema';

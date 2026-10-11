-- 024: the weight limits live in the Item Master, per part, instead of a fixed 15%.
--
-- Each part gets two limits (as a percentage of its standard weight):
--   * weight_tol_max_pct  how far ABOVE the standard one unit may weigh   (default 15, as before)
--   * weight_tol_min_pct  how far BELOW the standard one unit may weigh   (blank = no lower limit, as before)
-- record_production reads them when a Planner records a unit weight. Only MD/Admin may change them (a Creator can
-- still edit the rest of an item); every change is written to audit_events with the old and new values.
alter table app.parts
  add column if not exists weight_tol_max_pct numeric(5,2) not null default 15
    check (weight_tol_max_pct >= 0 and weight_tol_max_pct <= 100),
  add column if not exists weight_tol_min_pct numeric(5,2)
    check (weight_tol_min_pct is null or (weight_tol_min_pct >= 0 and weight_tol_min_pct <= 100));

create or replace function app.parts_weight_limits_guard() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  -- Only people signed in through the app are restricted (the SQL editor / service role have no auth.uid()).
  if tg_op = 'INSERT' then
    if auth.uid() is not null
       and (new.weight_tol_max_pct, new.weight_tol_min_pct) is distinct from (15::numeric, null::numeric)
       and not app.current_role_in('md', 'admin') then
      raise exception 'Only the MD or Admin may set an item''s weight limits.';
    end if;
    return new;
  end if;

  if (new.weight_tol_max_pct, new.weight_tol_min_pct) is distinct from (old.weight_tol_max_pct, old.weight_tol_min_pct) then
    if auth.uid() is not null and not app.current_role_in('md', 'admin') then
      raise exception 'Only the MD or Admin may change an item''s weight limits.';
    end if;
    insert into app.audit_events (table_name, record_id, action, actor_id, old_values, new_values)
    values ('parts', new.id, 'update', auth.uid(),
            jsonb_build_object('part_no', old.part_no, 'weight_tol_max_pct', old.weight_tol_max_pct, 'weight_tol_min_pct', old.weight_tol_min_pct),
            jsonb_build_object('part_no', new.part_no, 'weight_tol_max_pct', new.weight_tol_max_pct, 'weight_tol_min_pct', new.weight_tol_min_pct));
  end if;
  return new;
end $$;

drop trigger if exists parts_weight_limits_guard on app.parts;
create trigger parts_weight_limits_guard before insert or update on app.parts
  for each row execute function app.parts_weight_limits_guard();

-- record_production: identical to 023's, except the limits come from the Item Master.
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

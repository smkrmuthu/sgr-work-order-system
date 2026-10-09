-- 016: the MD's edit (app.update_work_order) can also change the Work Order's Sales Person.
-- Identical to 011's, plus the sales_person_id key (a change opens a revision like any other header change).
create or replace function app.update_work_order(p_work_order_id uuid, p jsonb) returns int
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
  v_qty numeric; v_price numeric; v_floor numeric;
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
    v_qty := coalesce((v_l->>'qty')::numeric, v_line.qty);
    v_price := coalesce((v_l->>'final_price')::numeric, v_line.final_price);
    if v_qty <= 0 then raise exception 'Line %: quantity must be above zero.', v_line.part_no_snapshot; end if;
    if v_price < 0 then raise exception 'Line %: price cannot be negative.', v_line.part_no_snapshot; end if;
    -- never below what has already been made or billed
    select greatest(
      coalesce((select sum(o.qty) from app.production_output_lines o where o.work_order_line_id = v_line.id), 0),
      coalesce((select sum(il.qty) from app.invoice_lines il where il.work_order_line_id = v_line.id), 0)) into v_floor;
    if v_qty < v_floor then
      raise exception 'Line %: quantity cannot go below %, which is already produced or billed.', v_line.part_no_snapshot, v_floor;
    end if;
    if v_qty is distinct from v_line.qty then v_changes := v_changes || format('%s qty %s -> %s', v_line.part_no_snapshot, v_line.qty, v_qty); end if;
    if v_price is distinct from v_line.final_price then v_changes := v_changes || format('%s price %s -> %s', v_line.part_no_snapshot, v_line.final_price, v_price); end if;
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
  end loop;

  update app.work_orders
     set delivery_date = v_new_date, doc_ref = v_new_ref, sales_person_id = v_new_sp,
         revision = case when v_released then revision + 1 else revision end,
         updated_by = auth.uid(), updated_at = now()
   where id = v_wo.id
  returning revision into v_wo.revision;

  return v_wo.revision;
end $$;

notify pgrst, 'reload schema';

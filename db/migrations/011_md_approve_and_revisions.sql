-- 011: (a) the MD may approve/reject like Finance, (b) every MD edit of a released order is ONE revision.
-- Safe to re-run.

-- ---------------------------------------------------------------- (a) who approves
-- Finance OR the MD (or Admin). The MD's Approve button was already in the app, but the database only
-- allowed Finance/Admin, so it would have been refused.
create or replace function app.approve_work_order(p_work_order_id uuid, p_comments text default null) returns app.work_orders
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_wo app.work_orders;
begin
  if not app.current_role_in('finance', 'md', 'admin') then raise exception 'Only Finance or the MD may approve a Work Order.'; end if;

  select * into v_wo from app.work_orders where id = p_work_order_id for update;
  if v_wo is null then raise exception 'Work order % not found', p_work_order_id; end if;
  if v_wo.status <> 'pending_finance_approval' then
    raise exception 'Work order % is not awaiting Finance approval.', v_wo.wo_number;
  end if;

  insert into app.finance_approvals (work_order_id, action, comments, actor)
    values (p_work_order_id, 'approved', p_comments, auth.uid());

  perform set_config('app.bypass_edit_check', 'true', true);
  update app.work_orders set status = 'created', updated_by = auth.uid(), updated_at = now()
   where id = p_work_order_id
  returning * into v_wo;

  return v_wo;
end $$;

create or replace function app.reject_work_order(p_work_order_id uuid, p_reason text) returns app.work_orders
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_wo app.work_orders;
begin
  if not app.current_role_in('finance', 'md', 'admin') then raise exception 'Only Finance or the MD may reject a Work Order.'; end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to reject a Work Order.';
  end if;

  select * into v_wo from app.work_orders where id = p_work_order_id for update;
  if v_wo is null then raise exception 'Work order % not found', p_work_order_id; end if;
  if v_wo.status <> 'pending_finance_approval' then
    raise exception 'Work order % is not awaiting Finance approval.', v_wo.wo_number;
  end if;

  insert into app.finance_approvals (work_order_id, action, comments, actor)
    values (p_work_order_id, 'rejected', p_reason, auth.uid());

  perform set_config('app.bypass_edit_check', 'true', true);
  update app.work_orders set status = 'draft', updated_by = auth.uid(), updated_at = now()
   where id = p_work_order_id
  returning * into v_wo;

  return v_wo;
end $$;

-- ---------------------------------------------------------------- (b) one MD edit = one revision
-- Editing the header and the lines used to be separate writes, and a change to only a quantity or price
-- (no header field) opened no revision at all. This does the whole edit atomically: snapshot the order as it
-- was, apply everything, bump the revision once, and record what changed.
--   p = { "delivery_date": "2026-11-01", "doc_ref": "...", "lines": [ { "id": "<line uuid>", "qty": 10, "final_price": 42.5 } ] }
-- Every key is optional; lines not listed are untouched. Returns the revision after the edit.
create or replace function app.update_work_order(p_work_order_id uuid, p jsonb) returns int
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_wo app.work_orders;
  v_released boolean;
  v_changes text[] := '{}';
  v_new_date date;
  v_new_ref text;
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
     set delivery_date = v_new_date, doc_ref = v_new_ref,
         revision = case when v_released then revision + 1 else revision end,
         updated_by = auth.uid(), updated_at = now()
   where id = v_wo.id
  returning revision into v_wo.revision;

  return v_wo.revision;
end $$;

-- After release, an MD's changes to a line go through update_work_order only (so they are always a revision).
-- Before release (draft / waiting for Finance) direct edits stay allowed, exactly as in 007.
drop policy if exists work_order_lines_write on app.work_order_lines;
create policy work_order_lines_write on app.work_order_lines for all to authenticated
  using (
    exists (select 1 from app.work_orders w where w.id = work_order_lines.work_order_id
              and w.status in ('draft', 'pending_finance_approval')
              and (app.current_role_in('md', 'admin')
                   or (app.current_role_in('creator') and w.created_by = auth.uid())))
  )
  with check (
    exists (select 1 from app.work_orders w where w.id = work_order_lines.work_order_id
              and w.status in ('draft', 'pending_finance_approval')
              and (app.current_role_in('md', 'admin')
                   or (app.current_role_in('creator') and w.created_by = auth.uid())))
  );

revoke execute on function app.update_work_order(uuid, jsonb) from public, anon;
grant execute on function app.update_work_order(uuid, jsonb) to authenticated, service_role;
grant execute on function app.approve_work_order(uuid, text) to authenticated;
grant execute on function app.reject_work_order(uuid, text) to authenticated;

notify pgrst, 'reload schema';

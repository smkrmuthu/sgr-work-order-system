-- 018: make Customer Price readable ONLY by Creator, MD, Admin and Finance — enforced in the database.
--
-- 017 stored customer_price on app.work_order_lines, which every signed-in role can read (Planner and QC need
-- the rest of the line), and the UI merely hid the column. Anyone could still read it by calling the API
-- directly. Postgres can hide a row (RLS) but not a column per app role (every login is the one `authenticated`
-- DB role), so the price moves to its own table with its own policy. A Planner/QC login now gets zero rows.
--
-- Three more leaks closed here, because the price was being copied into tables everyone can read:
--   * work_order_revisions.snapshot contained each line row (to_jsonb(line)) -> now lacks the price;
--   * work_order_revisions.change_summary said "... customer price 10 -> 12" -> now says "customer price changed";
--   * existing revisions that already carry either are scrubbed below.
-- Trade-off: a price change is recorded as "changed", not old -> new (the old value can no longer sit in a
-- table every role can read). The current price is always in work_order_line_prices.

create table if not exists app.work_order_line_prices (
  work_order_line_id uuid primary key references app.work_order_lines(id) on delete cascade,
  customer_price numeric not null check (customer_price >= 0)
);

alter table app.work_order_line_prices enable row level security;

drop policy if exists work_order_line_prices_select on app.work_order_line_prices;
create policy work_order_line_prices_select on app.work_order_line_prices for select to authenticated
  using (app.current_role_in('creator', 'md', 'admin', 'finance'));

-- Writes: exactly who may write the line itself (007): MD/Admin, or the Creator on their own draft/pending order.
drop policy if exists work_order_line_prices_write on app.work_order_line_prices;
create policy work_order_line_prices_write on app.work_order_line_prices for all to authenticated
  using (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and exists (
          select 1 from app.work_order_lines l join app.work_orders w on w.id = l.work_order_id
          where l.id = work_order_line_prices.work_order_line_id
            and w.status in ('draft', 'pending_finance_approval') and w.created_by = auth.uid()))
  )
  with check (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and exists (
          select 1 from app.work_order_lines l join app.work_orders w on w.id = l.work_order_id
          where l.id = work_order_line_prices.work_order_line_id
            and w.status in ('draft', 'pending_finance_approval') and w.created_by = auth.uid()))
  );

revoke all on app.work_order_line_prices from public, anon;
grant select, insert, update, delete on app.work_order_line_prices to authenticated;
grant all on app.work_order_line_prices to service_role;

-- Move the existing prices across, then drop the column everyone could read.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'app' and table_name = 'work_order_lines' and column_name = 'customer_price') then
    insert into app.work_order_line_prices (work_order_line_id, customer_price)
    select id, customer_price from app.work_order_lines where customer_price is not null
    on conflict (work_order_line_id) do nothing;
    alter table app.work_order_lines drop column customer_price;
  end if;
end $$;

-- Scrub prices already copied into revision history.
update app.work_order_revisions
   set change_summary = regexp_replace(change_summary, 'customer price [^;]*', 'customer price changed', 'g')
 where change_summary like '%customer price %' and change_summary not like '%customer price changed%';

update app.work_order_revisions r
   set snapshot = jsonb_set(r.snapshot, '{lines}',
         (select coalesce(jsonb_agg(e - 'customer_price'), '[]'::jsonb) from jsonb_array_elements(r.snapshot->'lines') e))
 where jsonb_typeof(r.snapshot->'lines') = 'array'
   and exists (select 1 from jsonb_array_elements(r.snapshot->'lines') e where e ? 'customer_price');

-- save_draft: identical to 017's, except the price goes to work_order_line_prices.
create or replace function app.save_draft(p_id uuid, p jsonb) returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
begin
  insert into app.work_orders as w (
    id, status, partner_id, delivery_location_id, delivery_location_snapshot, wo_date, delivery_date,
    doc_ref, sales_person_id, test_cert_required, inspection_report_required, packing_required,
    units_per_bundle, pallet_height_in, separate_vehicle_required, transport_notes, created_by, updated_by
  ) values (
    v_id, 'draft', (p->>'partner_id')::uuid, (p->>'delivery_location_id')::uuid, p->'delivery_location_snapshot',
    coalesce((p->>'wo_date')::date, current_date), (p->>'delivery_date')::date, p->>'doc_ref', (p->>'sales_person_id')::uuid,
    coalesce((p->>'test_cert_required')::boolean, false), coalesce((p->>'inspection_report_required')::boolean, false),
    coalesce((p->>'packing_required')::boolean, true), (p->>'units_per_bundle')::int,
    (p->>'pallet_height_in')::numeric, coalesce((p->>'separate_vehicle_required')::boolean, false),
    p->>'transport_notes', auth.uid(), auth.uid()
  )
  on conflict (id) do update set
    partner_id = excluded.partner_id, delivery_location_id = excluded.delivery_location_id,
    delivery_location_snapshot = excluded.delivery_location_snapshot, wo_date = excluded.wo_date,
    delivery_date = excluded.delivery_date, doc_ref = excluded.doc_ref, sales_person_id = excluded.sales_person_id,
    test_cert_required = excluded.test_cert_required, inspection_report_required = excluded.inspection_report_required,
    packing_required = excluded.packing_required,
    units_per_bundle = excluded.units_per_bundle, pallet_height_in = excluded.pallet_height_in,
    separate_vehicle_required = excluded.separate_vehicle_required, transport_notes = excluded.transport_notes,
    updated_by = auth.uid(), updated_at = now()
  where w.status in ('draft', 'pending_finance_approval')
    and (w.created_by = auth.uid() or app.current_role_in('md', 'admin'));

  -- Lines and notes are rewritten below; if the order is no longer editable by this caller, RLS refuses
  -- the insert and the whole call fails (rather than silently doing nothing). Deleting the lines also
  -- deletes their prices (ON DELETE CASCADE).
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

  insert into app.work_order_line_prices (work_order_line_id, customer_price)
  select ln.id, nullif(btrim(t.l->>'customer_price'), '')::numeric
  from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) with ordinality as t(l, ord)
  join app.work_order_lines ln on ln.work_order_id = v_id and ln.line_no = t.ord
  where nullif(btrim(t.l->>'customer_price'), '') is not null;

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

-- update_work_order: identical to 017's, except the price lives in work_order_line_prices and the revision
-- summary says "customer price changed" without the figures.
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
    -- never below what has already been made or billed
    select greatest(
      coalesce((select sum(o.qty) from app.production_output_lines o where o.work_order_line_id = v_line.id), 0),
      coalesce((select sum(il.qty) from app.invoice_lines il where il.work_order_line_id = v_line.id), 0)) into v_floor;
    if v_qty < v_floor then
      raise exception 'Line %: quantity cannot go below %, which is already produced or billed.', v_line.part_no_snapshot, v_floor;
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

-- The MD/Admin backup export must include the new table.
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
    'invoices', 'invoice_lines', 'notifications', 'audit_events', 'sales_persons'
  ) then
    raise exception 'Unknown table: %', p_table;
  end if;

  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from app.%I t', p_table) into v_rows;
  return v_rows;
end $$;

revoke execute on function app.export_table(text) from public, anon;
grant execute on function app.export_table(text) to authenticated;

notify pgrst, 'reload schema';

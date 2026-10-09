-- 015: Sales Person on the Work Order (dropdown next to Document Reference on New Work Order).
-- Nullable, so existing orders are untouched.
alter table app.work_orders add column if not exists sales_person_id uuid references app.sales_persons(id);

-- save_draft: identical to 012's, plus sales_person_id.
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

notify pgrst, 'reload schema';

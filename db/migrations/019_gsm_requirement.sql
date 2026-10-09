-- 019: GSM on the Work Order, and retire "Inspection Report Required" and "Pallet Height".
--
-- GSM (paper weight): a Work Order can say GSM is required, and then carries two figures, Inner and Outer.
-- Both are needed before the order can be created (a draft may still be incomplete), and are cleared if GSM
-- is switched off. Inspection Report Required and Pallet Height are no longer on the form; their columns stay
-- (old orders keep their values, nothing is lost) but save_draft no longer writes them.
alter table app.work_orders
  add column if not exists gsm_required boolean not null default false,
  add column if not exists gsm_inner numeric(7,2) check (gsm_inner is null or gsm_inner > 0),
  add column if not exists gsm_outer numeric(7,2) check (gsm_outer is null or gsm_outer > 0);

alter table app.work_orders drop constraint if exists work_orders_gsm_complete;
alter table app.work_orders add constraint work_orders_gsm_complete
  check (not gsm_required or status = 'draft' or (gsm_inner is not null and gsm_outer is not null));

-- save_draft: identical to 018's, minus inspection report / pallet height, plus GSM.
create or replace function app.save_draft(p_id uuid, p jsonb) returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
begin
  insert into app.work_orders as w (
    id, status, partner_id, delivery_location_id, delivery_location_snapshot, wo_date, delivery_date,
    doc_ref, sales_person_id, test_cert_required, gsm_required, gsm_inner, gsm_outer, packing_required,
    units_per_bundle, separate_vehicle_required, transport_notes, created_by, updated_by
  ) values (
    v_id, 'draft', (p->>'partner_id')::uuid, (p->>'delivery_location_id')::uuid, p->'delivery_location_snapshot',
    coalesce((p->>'wo_date')::date, current_date), (p->>'delivery_date')::date, p->>'doc_ref', (p->>'sales_person_id')::uuid,
    coalesce((p->>'test_cert_required')::boolean, false), coalesce((p->>'gsm_required')::boolean, false),
    case when coalesce((p->>'gsm_required')::boolean, false) then nullif(btrim(p->>'gsm_inner'), '')::numeric end,
    case when coalesce((p->>'gsm_required')::boolean, false) then nullif(btrim(p->>'gsm_outer'), '')::numeric end,
    coalesce((p->>'packing_required')::boolean, true), (p->>'units_per_bundle')::int,
    coalesce((p->>'separate_vehicle_required')::boolean, false),
    p->>'transport_notes', auth.uid(), auth.uid()
  )
  on conflict (id) do update set
    partner_id = excluded.partner_id, delivery_location_id = excluded.delivery_location_id,
    delivery_location_snapshot = excluded.delivery_location_snapshot, wo_date = excluded.wo_date,
    delivery_date = excluded.delivery_date, doc_ref = excluded.doc_ref, sales_person_id = excluded.sales_person_id,
    test_cert_required = excluded.test_cert_required, gsm_required = excluded.gsm_required,
    gsm_inner = excluded.gsm_inner, gsm_outer = excluded.gsm_outer,
    packing_required = excluded.packing_required,
    units_per_bundle = excluded.units_per_bundle,
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

notify pgrst, 'reload schema';

-- 022: Category on the Work Order header.
--
-- The order now carries a Category (from the Category master, Item Master > Categories). It is optional, is stored
-- on the order, and on the form it also narrows the Part # list to that category. Lines keep their own category
-- snapshot, so an order may still mix categories (leave the header category blank, or add the other part anyway).
-- Not part of the MD's in-place edit (like the Vendor, it is fixed once the order is created).
alter table app.work_orders add column if not exists category_id uuid references app.categories(id);

-- save_draft: identical to 019's, plus category_id.
create or replace function app.save_draft(p_id uuid, p jsonb) returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
begin
  insert into app.work_orders as w (
    id, status, partner_id, delivery_location_id, delivery_location_snapshot, wo_date, delivery_date,
    doc_ref, sales_person_id, category_id, test_cert_required, gsm_required, gsm_inner, gsm_outer, packing_required,
    units_per_bundle, separate_vehicle_required, transport_notes, created_by, updated_by
  ) values (
    v_id, 'draft', (p->>'partner_id')::uuid, (p->>'delivery_location_id')::uuid, p->'delivery_location_snapshot',
    coalesce((p->>'wo_date')::date, current_date), (p->>'delivery_date')::date, p->>'doc_ref', (p->>'sales_person_id')::uuid, (p->>'category_id')::uuid,
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
    delivery_date = excluded.delivery_date, doc_ref = excluded.doc_ref, sales_person_id = excluded.sales_person_id, category_id = excluded.category_id,
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

-- The edit guard: identical to 020's, except the Planner's "may change only the completion date" list now
-- includes category_id, so a Planner cannot change it through the API.
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
        old.delivery_date, old.doc_ref, old.sales_person_id, old.category_id, old.test_cert_required, old.inspection_report_required,
        old.gsm_required, old.gsm_inner, old.gsm_outer,
        old.additional_notes, old.packing_required, old.units_per_bundle, old.pallet_height_in,
        old.separate_vehicle_required, old.transport_notes)
       is distinct from
       (new.partner_id, new.delivery_location_id, new.wo_date,
        new.delivery_date, new.doc_ref, new.sales_person_id, new.category_id, new.test_cert_required, new.inspection_report_required,
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


notify pgrst, 'reload schema';

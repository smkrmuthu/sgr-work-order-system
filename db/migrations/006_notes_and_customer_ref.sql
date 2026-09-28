-- 006: (a) a Customer Reference on every Work Order line, (b) Additional Notes as separate points.
-- Safe to re-run.

-- ---------------------------------------------------------------- (a) customer reference per line
-- Snapshotted from the Item Master (parts.customer_ref) when the line is added, like the other
-- part fields, and editable on the line — so a later Item Master edit never rewrites an old order.
alter table app.work_order_lines add column if not exists customer_ref text;

-- ---------------------------------------------------------------- (b) notes as individual points
-- One row per note instead of one free-text paragraph (work_orders.additional_notes is now unused and
-- kept only so nothing already stored is lost). `icon` is empty for now: it is where the symbol/logo
-- chosen from a note's content will go later, without another schema change.
create table if not exists app.work_order_notes (
  id             uuid primary key default gen_random_uuid(),
  work_order_id  uuid not null references app.work_orders(id) on delete cascade,
  position       int  not null default 1,
  note           text not null check (btrim(note) <> ''),
  icon           text,
  created_at     timestamptz not null default now()
);
create index if not exists work_order_notes_wo_idx on app.work_order_notes (work_order_id, position);

alter table app.work_order_notes enable row level security;

drop policy if exists work_order_notes_select on app.work_order_notes;
create policy work_order_notes_select on app.work_order_notes for select to authenticated using (true);

-- Same rule as line items: MD/Admin any time; a Creator only on their own draft.
drop policy if exists work_order_notes_write on app.work_order_notes;
create policy work_order_notes_write on app.work_order_notes for all to authenticated
  using (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and exists (
          select 1 from app.work_orders w
          where w.id = work_order_notes.work_order_id and w.status = 'draft' and w.created_by = auth.uid()))
  )
  with check (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and exists (
          select 1 from app.work_orders w
          where w.id = work_order_notes.work_order_id and w.status = 'draft' and w.created_by = auth.uid()))
  );

-- 005_grants.sql only covered tables that existed when it ran.
revoke all on app.work_order_notes from anon;
grant select, insert, update, delete on app.work_order_notes to authenticated;

-- Keep anything already typed into the old paragraph box: one note per non-empty line.
insert into app.work_order_notes (work_order_id, position, note)
select w.id, row_number() over (partition by w.id order by ord), btrim(t.line)
from app.work_orders w
cross join lateral regexp_split_to_table(w.additional_notes, E'\\r?\\n') with ordinality as t(line, ord)
where w.additional_notes is not null and btrim(t.line) <> ''
  and not exists (select 1 from app.work_order_notes n where n.work_order_id = w.id);

-- ---------------------------------------------------------------- save_draft: lines + notes
-- Payload additions: lines[].customer_ref (falls back to the Item Master's), and
-- notes: [ "plain text" | { "text": "...", "icon": "..." } ]  (blank entries are dropped).
create or replace function app.save_draft(p_id uuid, p jsonb) returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
begin
  insert into app.work_orders as w (
    id, status, partner_id, delivery_location_id, delivery_location_snapshot, wo_date, delivery_date,
    doc_ref, test_cert_required, inspection_report_required, packing_required,
    units_per_bundle, pallet_height_in, separate_vehicle_required, transport_notes, created_by, updated_by
  ) values (
    v_id, 'draft', (p->>'partner_id')::uuid, (p->>'delivery_location_id')::uuid, p->'delivery_location_snapshot',
    coalesce((p->>'wo_date')::date, current_date), (p->>'delivery_date')::date, p->>'doc_ref',
    coalesce((p->>'test_cert_required')::boolean, false), coalesce((p->>'inspection_report_required')::boolean, false),
    coalesce((p->>'packing_required')::boolean, true), (p->>'units_per_bundle')::int,
    (p->>'pallet_height_in')::numeric, coalesce((p->>'separate_vehicle_required')::boolean, false),
    p->>'transport_notes', auth.uid(), auth.uid()
  )
  on conflict (id) do update set
    partner_id = excluded.partner_id, delivery_location_id = excluded.delivery_location_id,
    delivery_location_snapshot = excluded.delivery_location_snapshot, wo_date = excluded.wo_date,
    delivery_date = excluded.delivery_date, doc_ref = excluded.doc_ref,
    test_cert_required = excluded.test_cert_required, inspection_report_required = excluded.inspection_report_required,
    packing_required = excluded.packing_required,
    units_per_bundle = excluded.units_per_bundle, pallet_height_in = excluded.pallet_height_in,
    separate_vehicle_required = excluded.separate_vehicle_required, transport_notes = excluded.transport_notes,
    updated_by = auth.uid(), updated_at = now()
  where w.status = 'draft' and w.created_by = auth.uid();   -- re-saving someone else's draft is a no-op, not an error

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

-- create or replace keeps the existing execute grant from 005_grants.sql, but restate it so a fresh
-- install that somehow ran 006 first still ends up correct.
revoke execute on function app.save_draft(uuid, jsonb) from public, anon;
grant execute on function app.save_draft(uuid, jsonb) to authenticated;

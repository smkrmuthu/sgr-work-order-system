-- 025: QC rejection workflow — a rejected unit gets a reason, an owner and a decision.
--
-- Before: QC accepted some units and "held" the rest; nothing recorded why, nobody decided what happens, and held
-- units could only be reopened for re-inspection.
-- Now:
--  1. When QC accepts fewer units than are awaiting, the rest become a REJECTION with a reason (from a managed list)
--     and a comment (photos attach to the inspection as before). The Planner can also record units as "rejected at
--     production" (e.g. over the weight limit) — they skip QC and go to the same queue.
--  2. Finance or MD decides, per quantity (it can be split): SCRAP or RE-PRODUCE. Nobody else can.
--       SCRAP       the units are written off; the order's required quantity drops by that much (short-close), so
--                   the order can still complete, and the units can never be billed.
--       RE-PRODUCE  the units are written off AND a replacement line for the same quantity is added to the order,
--                   with its own selling price (default: the original's) and, optionally, a new delivery date for
--                   the order. Production, QC and billing then treat it like any other line.
--     Every decision opens a numbered revision of the order (who, when, why) and is recorded permanently.
--  3. Until a rejection is decided the order cannot complete (its units still count as required).
-- The tables have no write policies: they change only through the functions below.

-- ---------------------------------------------------------------- reasons master
create table if not exists app.qc_reject_reasons (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
alter table app.qc_reject_reasons enable row level security;
drop policy if exists qc_reject_reasons_select on app.qc_reject_reasons;
create policy qc_reject_reasons_select on app.qc_reject_reasons for select to authenticated using (true);
drop policy if exists qc_reject_reasons_write on app.qc_reject_reasons;
create policy qc_reject_reasons_write on app.qc_reject_reasons for all to authenticated
  using (app.current_role_in('creator', 'md', 'admin')) with check (app.current_role_in('creator', 'md', 'admin'));
revoke all on app.qc_reject_reasons from public, anon;
grant select, insert, update, delete on app.qc_reject_reasons to authenticated;
grant all on app.qc_reject_reasons to service_role;
insert into app.qc_reject_reasons (name) values
  ('Overweight'), ('Underweight'), ('Dimension out of tolerance'), ('Print / finish defect'), ('Damaged'), ('Other')
on conflict (name) do nothing;

-- ---------------------------------------------------------------- lines: written-off quantity, replacement link
alter table app.work_order_lines add column if not exists short_closed_qty numeric(12,2) not null default 0;
alter table app.work_order_lines drop constraint if exists work_order_lines_short_closed_check;
alter table app.work_order_lines add constraint work_order_lines_short_closed_check
  check (short_closed_qty >= 0 and short_closed_qty <= qty);
alter table app.work_order_lines add column if not exists replaces_line_id uuid references app.work_order_lines(id);

-- ---------------------------------------------------------------- rejections and decisions
create table if not exists app.qc_rejections (
  id                 uuid primary key default gen_random_uuid(),
  work_order_line_id uuid not null references app.work_order_lines(id) on delete cascade,
  source             text not null check (source in ('qc', 'production')),
  qc_inspection_id   uuid references app.qc_inspections(id) on delete set null,
  qty                numeric(12,2) not null check (qty > 0),
  reason_id          uuid not null references app.qc_reject_reasons(id),
  comment            text,
  unit_weight_g      numeric(10,2),
  status             text not null default 'awaiting_decision' check (status in ('awaiting_decision', 'decided', 'withdrawn')),
  recorded_by        uuid references app.users(id),
  recorded_at        timestamptz not null default now()
);
create index if not exists qc_rejections_line_idx on app.qc_rejections (work_order_line_id);
create index if not exists qc_rejections_status_idx on app.qc_rejections (status);

create table if not exists app.qc_rejection_decisions (
  id                  uuid primary key default gen_random_uuid(),
  rejection_id        uuid not null references app.qc_rejections(id) on delete cascade,
  action              text not null check (action in ('scrap', 'reproduce')),
  qty                 numeric(12,2) not null check (qty > 0),
  note                text not null,
  replacement_line_id uuid references app.work_order_lines(id),
  new_price           numeric check (new_price is null or new_price >= 0),
  new_delivery_date   date,
  decided_by          uuid references app.users(id),
  decided_at          timestamptz not null default now()
);
create index if not exists qc_rejection_decisions_idx on app.qc_rejection_decisions (rejection_id);

alter table app.qc_rejections enable row level security;
drop policy if exists qc_rejections_select on app.qc_rejections;
create policy qc_rejections_select on app.qc_rejections for select to authenticated using (true);
alter table app.qc_rejection_decisions enable row level security;
drop policy if exists qc_rejection_decisions_select on app.qc_rejection_decisions;
create policy qc_rejection_decisions_select on app.qc_rejection_decisions for select to authenticated using (true);
revoke all on app.qc_rejections, app.qc_rejection_decisions from public, anon;
grant select on app.qc_rejections, app.qc_rejection_decisions to authenticated;
grant all on app.qc_rejections, app.qc_rejection_decisions to service_role;

-- ---------------------------------------------------------------- QC inspection: rejected units need a reason
drop function if exists app.record_qc_inspection(uuid, numeric, text);
create or replace function app.record_qc_inspection(p_work_order_line_id uuid, p_accepted_qty numeric, p_comments text, p_reason_id uuid default null)
returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_sent numeric; v_approved numeric; v_held numeric; v_awaiting numeric; v_id uuid; v_rejected numeric;
begin
  if not app.current_role_in('qc', 'md', 'admin') then raise exception 'Only QC (or MD) may record an inspection.'; end if;
  perform 1 from app.work_order_lines where id = p_work_order_line_id for update;   -- serialise concurrent inspections of this line
  select coalesce(sum(qty), 0) into v_sent from app.qc_submissions where work_order_line_id = p_work_order_line_id;
  select coalesce(sum(accepted_qty), 0), coalesce(sum(held_qty), 0) into v_approved, v_held
    from app.qc_inspections where work_order_line_id = p_work_order_line_id;
  v_awaiting := v_sent - v_approved - v_held;
  if v_awaiting <= 0 then raise exception 'Nothing is awaiting inspection for this line.'; end if;
  if p_accepted_qty < 0 or p_accepted_qty > v_awaiting then
    raise exception 'Accepted quantity must be between 0 and %.', v_awaiting;
  end if;
  v_rejected := v_awaiting - p_accepted_qty;
  if v_rejected > 0 and not exists (select 1 from app.qc_reject_reasons where id = p_reason_id and is_active) then
    raise exception 'Choose the reason for rejecting the % unit(s).', v_rejected;
  end if;

  insert into app.qc_inspections (work_order_line_id, accepted_qty, held_qty, comments, inspector_id)
  values (p_work_order_line_id, p_accepted_qty, v_rejected, p_comments, auth.uid())
  returning id into v_id;

  if v_rejected > 0 then
    insert into app.qc_rejections (work_order_line_id, source, qc_inspection_id, qty, reason_id, comment, recorded_by)
    values (p_work_order_line_id, 'qc', v_id, v_rejected, p_reason_id, p_comments, auth.uid());
  end if;
  return v_id;
end $$;
revoke execute on function app.record_qc_inspection(uuid, numeric, text, uuid) from public, anon;
grant execute on function app.record_qc_inspection(uuid, numeric, text, uuid) to authenticated;

-- ---------------------------------------------------------------- QC can withdraw a rejection nobody has acted on
create or replace function app.reopen_held(p_work_order_line_id uuid) returns numeric
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_qty numeric;
begin
  if not app.current_role_in('qc', 'md', 'admin') then raise exception 'Only QC (or MD) may reopen rejected quantity.'; end if;
  perform 1 from app.work_order_lines where id = p_work_order_line_id for update;
  select coalesce(sum(r.qty), 0) into v_qty from app.qc_rejections r
   where r.work_order_line_id = p_work_order_line_id and r.source = 'qc' and r.status = 'awaiting_decision'
     and not exists (select 1 from app.qc_rejection_decisions d where d.rejection_id = r.id);
  if v_qty <= 0 then raise exception 'Nothing here can be reopened: it is either not rejected, or Finance/MD has already decided.'; end if;
  -- A zeroing inspection row moves the quantity back to "awaiting" without ever deleting the original record.
  insert into app.qc_inspections (work_order_line_id, accepted_qty, held_qty, comments, inspector_id)
  values (p_work_order_line_id, 0, -v_qty, 'Rejection withdrawn; reopened for re-inspection', auth.uid());
  update app.qc_rejections r set status = 'withdrawn'
   where r.work_order_line_id = p_work_order_line_id and r.source = 'qc' and r.status = 'awaiting_decision'
     and not exists (select 1 from app.qc_rejection_decisions d where d.rejection_id = r.id);
  perform app.recompute_work_order_status((select work_order_id from app.work_order_lines where id = p_work_order_line_id));
  return v_qty;
end $$;
revoke execute on function app.reopen_held(uuid) from public, anon;
grant execute on function app.reopen_held(uuid) to authenticated;

-- ---------------------------------------------------------------- the Planner rejects units at production
create or replace function app.record_production_reject(
  p_work_order_line_id uuid, p_qty numeric, p_unit_weight_g numeric, p_reason_id uuid, p_comment text default null) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_line app.work_order_lines; v_status app.wo_status; v_produced numeric; v_reserved numeric; v_id uuid;
begin
  if not app.current_role_in('planner', 'md', 'admin') then
    raise exception 'Only the Production Planner (or MD) may reject units at production.';
  end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Enter how many units are rejected.'; end if;
  if not exists (select 1 from app.qc_reject_reasons where id = p_reason_id and is_active) then
    raise exception 'Choose the reason for the rejection.';
  end if;

  select * into v_line from app.work_order_lines where id = p_work_order_line_id for update;
  if v_line.id is null then raise exception 'Line not found.'; end if;
  select status into v_status from app.work_orders where id = v_line.work_order_id;
  if v_status in ('draft', 'pending_finance_approval', 'cancelled', 'completed') then
    raise exception 'This Work Order is % and cannot record production.', v_status;
  end if;

  select coalesce(sum(qty), 0) into v_produced from app.production_output_lines where work_order_line_id = v_line.id;
  select coalesce(sum(r.qty - coalesce((select sum(d.qty) from app.qc_rejection_decisions d where d.rejection_id = r.id), 0)), 0)
    into v_reserved from app.qc_rejections r
   where r.work_order_line_id = v_line.id and r.source = 'production' and r.status = 'awaiting_decision';
  if v_produced + v_reserved + p_qty > v_line.qty - v_line.short_closed_qty then
    raise exception 'Line %: % rejected units would go above the quantity still to be made.', v_line.part_no_snapshot, p_qty;
  end if;

  insert into app.qc_rejections (work_order_line_id, source, qty, reason_id, comment, unit_weight_g, recorded_by)
  values (v_line.id, 'production', p_qty, p_reason_id, nullif(btrim(p_comment), ''), p_unit_weight_g, auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function app.record_production_reject(uuid, numeric, numeric, uuid, text) from public, anon;
grant execute on function app.record_production_reject(uuid, numeric, numeric, uuid, text) to authenticated;

-- ---------------------------------------------------------------- Finance / MD decide
create or replace function app.decide_rejection(
  p_rejection_id uuid, p_action text, p_qty numeric, p_note text,
  p_new_price numeric default null, p_new_delivery_date date default null) returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_rej app.qc_rejections; v_line app.work_order_lines; v_wo app.work_orders;
  v_open numeric; v_dec uuid; v_new_line uuid; v_line_no int; v_price numeric; v_summary text;
  v_new_date date;
begin
  if not app.current_role_in('finance', 'md', 'admin') then raise exception 'Only Finance or the MD may decide on a rejection.'; end if;
  if p_action not in ('scrap', 'reproduce') then raise exception 'Choose Scrap or Re-produce.'; end if;
  if nullif(btrim(p_note), '') is null then raise exception 'Please give a note explaining the decision.'; end if;
  if p_action = 'scrap' and (p_new_price is not null or p_new_delivery_date is not null) then
    raise exception 'A price or delivery date applies only to a re-produce decision.';
  end if;

  select * into v_rej from app.qc_rejections where id = p_rejection_id for update;
  if v_rej.id is null then raise exception 'Rejection not found.'; end if;
  if v_rej.status <> 'awaiting_decision' then raise exception 'This rejection has already been decided or withdrawn.'; end if;
  select * into v_line from app.work_order_lines where id = v_rej.work_order_line_id for update;
  select * into v_wo from app.work_orders where id = v_line.work_order_id for update;
  if v_wo.status in ('draft', 'pending_finance_approval', 'cancelled', 'completed') then
    raise exception 'A % Work Order cannot take this decision.', v_wo.status;
  end if;

  select v_rej.qty - coalesce(sum(qty), 0) into v_open from app.qc_rejection_decisions where rejection_id = v_rej.id;
  if p_qty is null or p_qty <= 0 or p_qty > v_open then
    raise exception 'Quantity must be between 0 and % (the units still awaiting a decision).', v_open;
  end if;
  if p_new_price is not null and p_new_price < 0 then raise exception 'Price cannot be negative.'; end if;
  v_new_date := p_new_delivery_date;
  if v_new_date is not null and v_new_date < current_date then raise exception 'The new delivery date cannot be in the past.'; end if;

  v_summary := case p_action when 'scrap' then format('QC decision: %s unit(s) of %s scrapped', p_qty, v_line.part_no_snapshot)
                              else format('QC decision: %s unit(s) of %s re-produced', p_qty, v_line.part_no_snapshot) end;

  perform set_config('app.bypass_edit_check', 'true', true);

  -- the order as it was, before this decision changes it
  insert into app.work_order_revisions (work_order_id, revision, snapshot, changed_by, change_summary)
  values (v_wo.id, v_wo.revision,
          to_jsonb(v_wo) || jsonb_build_object('lines',
            (select coalesce(jsonb_agg(to_jsonb(l.*) order by l.line_no), '[]') from app.work_order_lines l where l.work_order_id = v_wo.id)),
          auth.uid(), v_summary || ' — ' || btrim(p_note));

  update app.work_order_lines set short_closed_qty = short_closed_qty + p_qty where id = v_line.id;

  if p_action = 'reproduce' then
    v_price := coalesce(p_new_price, v_line.final_price);
    select coalesce(max(line_no), 0) + 1 into v_line_no from app.work_order_lines where work_order_id = v_wo.id;
    insert into app.work_order_lines (
      work_order_id, line_no, part_id, part_no_snapshot, description_snapshot, uom_snapshot, standard_weight_kg_snapshot,
      category_snapshot, standard_price_snapshot, final_price, qty, remarks, customer_ref, replaces_line_id)
    values (v_wo.id, v_line_no, v_line.part_id, v_line.part_no_snapshot, v_line.description_snapshot, v_line.uom_snapshot,
            v_line.standard_weight_kg_snapshot, v_line.category_snapshot, v_line.standard_price_snapshot, v_price, p_qty,
            format('Replacement for rejected units of line %s', v_line.line_no), v_line.customer_ref, v_line.id)
    returning id into v_new_line;
    insert into app.work_order_line_prices (work_order_line_id, customer_price)
      select v_new_line, customer_price from app.work_order_line_prices where work_order_line_id = v_line.id;
  end if;

  insert into app.qc_rejection_decisions (rejection_id, action, qty, note, replacement_line_id, new_price, new_delivery_date, decided_by)
  values (v_rej.id, p_action, p_qty, btrim(p_note), v_new_line, case when p_action = 'reproduce' then v_price end, v_new_date, auth.uid())
  returning id into v_dec;

  if p_qty = v_open then update app.qc_rejections set status = 'decided' where id = v_rej.id; end if;

  update app.work_orders
     set revision = revision + 1,
         delivery_date = coalesce(v_new_date, delivery_date),
         updated_by = auth.uid(), updated_at = now()
   where id = v_wo.id;

  perform app.recompute_work_order_status(v_wo.id);
  return v_dec;
end $$;
revoke execute on function app.decide_rejection(uuid, text, numeric, text, numeric, date) from public, anon;
grant execute on function app.decide_rejection(uuid, text, numeric, text, numeric, date) to authenticated;

-- ---------------------------------------------------------------- status + completion use the REQUIRED quantity
create or replace function app.recompute_work_order_status(p_work_order_id uuid) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_status app.wo_status;
  v_ordered numeric; v_produced numeric; v_submitted numeric; v_accepted numeric;
begin
  select status into v_status from app.work_orders where id = p_work_order_id;
  if v_status in ('draft', 'pending_finance_approval', 'completed', 'cancelled') then return; end if;

  -- what must still be delivered: ordered, less units written off by a scrap/re-produce decision (025)
  select coalesce(sum(l.qty - l.short_closed_qty), 0) into v_ordered from app.work_order_lines l where l.work_order_id = p_work_order_id;
  select coalesce(sum(o.qty), 0) into v_produced from app.production_output_lines o
    join app.work_order_lines l on l.id = o.work_order_line_id where l.work_order_id = p_work_order_id;
  select coalesce(sum(s.qty), 0) into v_submitted from app.qc_submissions s
    join app.work_order_lines l on l.id = s.work_order_line_id where l.work_order_id = p_work_order_id;
  select coalesce(sum(i.accepted_qty), 0) into v_accepted from app.qc_inspections i
    join app.work_order_lines l on l.id = i.work_order_line_id where l.work_order_id = p_work_order_id;

  v_status := case
    when v_produced = 0 then 'created'
    when v_accepted >= v_ordered and v_ordered > 0 then 'ready_for_dispatch'
    when v_accepted > 0 then 'partially_qc_approved'
    when v_submitted > 0 then 'qc_pending'
    else 'in_production'
  end;

  perform set_config('app.bypass_edit_check', 'true', true);
  update app.work_orders set status = v_status where id = p_work_order_id and status is distinct from v_status;
end $$;


create or replace function app.mark_invoice_dispatched(p_invoice_id uuid) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_wo uuid;
  v_dispatched timestamptz;
  v_all_billed boolean;
  v_open int;
begin
  if not app.current_role_in('md', 'admin') then raise exception 'Only MD may mark an invoice as dispatched.'; end if;

  select work_order_id, dispatched_at into v_wo, v_dispatched from app.invoices where id = p_invoice_id for update;
  if v_wo is null then raise exception 'Invoice not found.'; end if;
  if v_dispatched is not null then raise exception 'This invoice has already been dispatched.'; end if;

  update app.invoices set dispatched_at = now(), dispatched_by = auth.uid() where id = p_invoice_id;

  -- Fully billed (every ordered unit invoiced) and nothing left waiting at the gate -> the order is done.
  select coalesce(bool_and(coalesce(b.q, 0) >= l.qty - l.short_closed_qty), false) into v_all_billed
  from app.work_order_lines l
  left join (select work_order_line_id, sum(qty) q from app.invoice_lines group by work_order_line_id) b
         on b.work_order_line_id = l.id
  where l.work_order_id = v_wo;
  select count(*) into v_open from app.invoices where work_order_id = v_wo and dispatched_at is null;

  if v_all_billed and v_open = 0 then
    perform set_config('app.bypass_edit_check', 'true', true);
    update app.work_orders set status = 'completed', updated_by = auth.uid(), updated_at = now()
     where id = v_wo and status <> 'completed';
  end if;
end $$;


-- production guard (record_production): capacity now excludes written-off and pending-rejected units
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
revoke execute on function app.mark_invoice_dispatched(uuid) from public, anon;
grant execute on function app.mark_invoice_dispatched(uuid) to authenticated;

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
    'qc_reject_reasons', 'qc_rejections', 'qc_rejection_decisions'
  ) then
    raise exception 'Unknown table: %', p_table;
  end if;

  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from app.%I t', p_table) into v_rows;
  return v_rows;
end $$;

revoke execute on function app.export_table(text) from public, anon;
grant execute on function app.export_table(text) to authenticated;

revoke execute on function app.export_table(text) from public, anon;
grant execute on function app.export_table(text) to authenticated;

notify pgrst, 'reload schema';

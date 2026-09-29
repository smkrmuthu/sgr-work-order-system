-- SGR Work Order Management System — Phase 1 production schema
-- Implements the data model in docs/architecture/v1.3 §8, in a dedicated `app` schema so it never
-- collides with the smkrmuthu/sgrApp UI prototype's `public` schema on the same Supabase project.
--
-- Run once, in order: 001_schema.sql -> 002_rls.sql -> 003_functions.sql -> 004_seed.sql
-- Safe to re-run: every statement is idempotent (create-if-not-exists / drop-then-create).

create schema if not exists app;

-- ---------------------------------------------------------------- enums
do $$ begin
  create type app.user_role as enum ('creator', 'md', 'planner', 'qc', 'finance', 'admin');
exception when duplicate_object then null; end $$;

do $$ begin
  -- v1.3 §7. No GM/JMD chain, no MD sign-off gate (confirmed 28 Sep 2026): a Work Order goes
  -- straight from Created to the production floor. UPDATED 28 Sep 2026: a Finance approval gate
  -- was added between the two — a created Work Order now sits in 'pending_finance_approval' until
  -- Finance approves it (-> 'created', unlocking production) or rejects it (-> 'draft', back to the
  -- Creator to fix and resubmit). See app.approve_work_order() / app.reject_work_order().
  create type app.wo_status as enum (
    'draft', 'pending_finance_approval', 'created', 'in_production', 'qc_pending',
    'partially_qc_approved', 'ready_for_dispatch', 'completed', 'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type app.supply_type as enum ('intra', 'inter');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- users / roles
-- One row per login (mirrors auth.users); role drives every RLS policy below.
create table if not exists app.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  role        app.user_role not null default 'creator',
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- master data (§4, §5, Appendices A-D)
create table if not exists app.categories (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,          -- e.g. CAT-001
  name        text not null,
  description text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists app.shifts (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,          -- 1..4
  name        text not null,                 -- Morning / Evening / Night / General
  start_time  time not null,
  end_time    time not null,                 -- may be < start_time (overnight shift)
  is_active   boolean not null default true
);

create table if not exists app.parts (
  id                  uuid primary key default gen_random_uuid(),
  part_no             text not null unique,
  description         text not null,
  uom                 text not null default 'NOS',
  standard_weight_kg  numeric(12,4) not null default 0,   -- basis (per piece vs other) still open, v1.3 §13
  category_id         uuid references app.categories(id),
  price               numeric(12,2) not null default 0,
  remarks             text,
  customer_ref        text,
  is_active           boolean not null default true,
  created_at          timestamptz not null default now()
);

-- One shared partner master; PartnerRole flags support supplier/vendor/customer (§5, §14).
create table if not exists app.business_partners (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  name         text not null,
  gstin        text,
  is_customer  boolean not null default true,
  is_supplier  boolean not null default false,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create table if not exists app.partner_contacts (
  id          uuid primary key default gen_random_uuid(),
  partner_id  uuid not null references app.business_partners(id) on delete cascade,
  name        text not null,
  phone       text,
  email       text,
  is_primary  boolean not null default false
);

create table if not exists app.partner_addresses (
  id          uuid primary key default gen_random_uuid(),
  partner_id  uuid not null references app.business_partners(id) on delete cascade,
  kind        text not null default 'delivery' check (kind in ('billing', 'delivery')),
  line1       text not null,
  city        text,
  is_primary  boolean not null default false
);

-- Selectable on a Work Order; snapshotted onto it (§3.1) so a later address edit never rewrites history.
create table if not exists app.delivery_locations (
  id          uuid primary key default gen_random_uuid(),
  partner_id  uuid not null references app.business_partners(id) on delete cascade,
  address_id  uuid references app.partner_addresses(id),
  label       text not null,
  is_active   boolean not null default true
);

-- ---------------------------------------------------------------- work orders (§3, §6, §7)
create table if not exists app.work_orders (
  id                          uuid primary key default gen_random_uuid(),
  wo_number                   text unique,              -- null while status='draft'; assigned atomically at Create
  revision                    int not null default 0,
  status                      app.wo_status not null default 'draft',

  partner_id                  uuid references app.business_partners(id),
  delivery_location_id        uuid references app.delivery_locations(id),
  delivery_location_snapshot  jsonb,                     -- point-in-time address snapshot (§3.1)

  wo_date                     date not null default current_date,
  delivery_date               date,
  doc_ref                     text,
  expected_completion_date    date,                      -- set/changed by Planner (§4)

  test_cert_required          boolean not null default false,
  inspection_report_required  boolean not null default false,
  additional_notes            text,
  packing_required            boolean not null default true,
  units_per_bundle            int,
  pallet_height_in            numeric(6,2),
  separate_vehicle_required   boolean not null default false,
  transport_notes             text,

  created_by                  uuid references app.users(id),
  created_at                  timestamptz not null default now(),
  updated_by                  uuid references app.users(id),
  updated_at                  timestamptz not null default now()
);

create index if not exists work_orders_status_idx on app.work_orders (status);
create index if not exists work_orders_partner_idx on app.work_orders (partner_id);
create index if not exists work_orders_wo_number_idx on app.work_orders (wo_number);

-- Append-only: one row per MD edit that changes a business field, holding the PRIOR snapshot (§6).
create table if not exists app.work_order_revisions (
  id              uuid primary key default gen_random_uuid(),
  work_order_id   uuid not null references app.work_orders(id) on delete cascade,
  revision        int not null,
  snapshot        jsonb not null,          -- the row (and its lines) before this revision's edit
  change_summary  text,
  changed_by      uuid references app.users(id),
  changed_at      timestamptz not null default now(),
  unique (work_order_id, revision)
);

-- Line items, each a master snapshot at selection time (§3.2) plus the MD-editable final_price.
create table if not exists app.work_order_lines (
  id                          uuid primary key default gen_random_uuid(),
  work_order_id               uuid not null references app.work_orders(id) on delete cascade,
  line_no                     int not null default 1,
  part_id                     uuid references app.parts(id),

  part_no_snapshot            text not null,
  description_snapshot        text not null,
  uom_snapshot                text not null,
  standard_weight_kg_snapshot numeric(12,4) not null default 0,
  category_snapshot           text,
  standard_price_snapshot     numeric(12,2) not null default 0,

  final_price                 numeric(12,2) not null default 0,   -- MD may change post-create (§6)
  qty                         numeric(12,2) not null default 0,
  remarks                     text,

  created_at                  timestamptz not null default now()
);

create index if not exists work_order_lines_wo_idx on app.work_order_lines (work_order_id);

-- Append-only status trail, surfaced as each role's queue (§7).
create table if not exists app.status_history (
  id             uuid primary key default gen_random_uuid(),
  work_order_id  uuid not null references app.work_orders(id) on delete cascade,
  from_status    app.wo_status,
  to_status      app.wo_status not null,
  changed_by     uuid references app.users(id),
  changed_at     timestamptz not null default now(),
  note           text
);

-- Prior Expected Completion Date changes (§4: "stores prior date, new date, user, time, reason").
create table if not exists app.completion_date_changes (
  id             uuid primary key default gen_random_uuid(),
  work_order_id  uuid not null references app.work_orders(id) on delete cascade,
  from_date      date,
  to_date        date not null,
  reason         text,
  changed_by     uuid references app.users(id),
  changed_at     timestamptz not null default now()
);

-- Append-only Finance approval trail (added 28 Sep 2026). One row per decision; the Work Order's
-- current gate state is just its status ('pending_finance_approval' / rejected-back-to-'draft').
create table if not exists app.finance_approvals (
  id             uuid primary key default gen_random_uuid(),
  work_order_id  uuid not null references app.work_orders(id) on delete cascade,
  action         text not null check (action in ('approved', 'rejected')),
  comments       text,                      -- required (enforced in the RPC) when action = 'rejected'
  actor          uuid references app.users(id),
  created_at     timestamptz not null default now()
);
create index if not exists finance_approvals_wo_idx on app.finance_approvals (work_order_id);

-- ---------------------------------------------------------------- production (§4)
create table if not exists app.production_entries (
  id              uuid primary key default gen_random_uuid(),
  work_order_id   uuid not null references app.work_orders(id) on delete cascade,
  production_date date not null default current_date,
  shift_id        uuid references app.shifts(id),
  labour_count    int,
  planner_id      uuid references app.users(id),
  created_at      timestamptz not null default now()
);

create table if not exists app.production_output_lines (
  id                    uuid primary key default gen_random_uuid(),
  production_entry_id   uuid not null references app.production_entries(id) on delete cascade,
  work_order_line_id    uuid not null references app.work_order_lines(id) on delete cascade,
  qty                   numeric(12,2) not null,
  actual_weight_kg      numeric(12,4) not null default 0,
  note                  text
);

-- Cumulative "sent to QC" per line (Planner's Send-to-QC action, §4: "partial daily output can be
-- sent separately"). Kept as a running total rather than per-batch for Phase 1 (documented in README).
create table if not exists app.qc_submissions (
  id                    uuid primary key default gen_random_uuid(),
  work_order_line_id    uuid not null references app.work_order_lines(id) on delete cascade,
  qty                   numeric(12,2) not null,
  submitted_by          uuid references app.users(id),
  submitted_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------- QC (§5)
-- outcome is qty-based, not boolean: accepted_qty advances to Ready for Dispatch; held_qty is
-- "inspected but not accepted, not lost, not silently counted as ready" — see README for why
-- (§5's own warning, with no rejection/rework workflow defined yet).
create table if not exists app.qc_inspections (
  id                    uuid primary key default gen_random_uuid(),
  work_order_line_id    uuid not null references app.work_order_lines(id) on delete cascade,
  accepted_qty          numeric(12,2) not null default 0,
  held_qty              numeric(12,2) not null default 0,
  comments              text,
  inspector_id          uuid references app.users(id),
  inspected_at          timestamptz not null default now()
);

create table if not exists app.attachments (
  id               uuid primary key default gen_random_uuid(),
  work_order_id    uuid references app.work_orders(id) on delete cascade,
  qc_inspection_id uuid references app.qc_inspections(id) on delete cascade,
  file_name        text not null,
  storage_key      text not null,          -- Supabase Storage object path; bytes never touch this table
  content_type     text,
  uploaded_by      uuid references app.users(id),
  uploaded_at      timestamptz not null default now(),
  check (work_order_id is not null or qc_inspection_id is not null)
);

-- ---------------------------------------------------------------- invoicing (§6)
create table if not exists app.invoices (
  id              uuid primary key default gen_random_uuid(),
  work_order_id   uuid not null references app.work_orders(id),
  invoice_number  text not null unique,
  invoice_date    date not null default current_date,
  gst_rate        numeric(5,2) not null,
  supply_type     app.supply_type not null,
  subtotal        numeric(14,2) not null,
  cgst            numeric(14,2) not null default 0,
  sgst            numeric(14,2) not null default 0,
  igst            numeric(14,2) not null default 0,
  grand_total     numeric(14,2) not null,
  generated_by    uuid references app.users(id),
  generated_at    timestamptz not null default now()
);

create table if not exists app.invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references app.invoices(id) on delete cascade,
  work_order_line_id uuid references app.work_order_lines(id),
  description   text not null,
  qty           numeric(12,2) not null,
  price         numeric(12,2) not null,
  amount        numeric(14,2) not null
);

-- ---------------------------------------------------------------- notifications + audit
create table if not exists app.notifications (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references app.users(id),      -- null = broadcast to everyone (status changes, §9)
  work_order_id  uuid references app.work_orders(id) on delete cascade,
  message        text not null,
  is_read        boolean not null default false,
  created_at     timestamptz not null default now()
);

create table if not exists app.audit_events (
  id           uuid primary key default gen_random_uuid(),
  table_name   text not null,
  record_id    uuid not null,
  action       text not null,             -- insert / update / delete
  actor_id     uuid references app.users(id),
  occurred_at  timestamptz not null default now(),
  old_values   jsonb,
  new_values   jsonb
);
create index if not exists audit_events_record_idx on app.audit_events (table_name, record_id);
-- Row-Level Security: this is where "hiding a button isn't access control" (v1.3 §9) is actually
-- enforced. Every table below denies everything by default; a policy re-opens exactly what a role
-- needs. Fine-grained business rules that RLS can't express cleanly (e.g. "Planner may change only
-- the Expected Completion Date") are enforced by triggers in 003_functions.sql, not by the client.

-- ---------------------------------------------------------------- helpers
-- is_active = false is treated as "no role" everywhere: a deactivated login (Users page, added
-- 28 Sep 2026) keeps signing in successfully (Supabase Auth doesn't know about app.users), but every
-- RLS policy and RBAC check below is built on these two functions, so it reads/writes nothing.
create or replace function app.current_role() returns app.user_role
language sql stable security definer set search_path = app, pg_temp as $$
  select role from app.users where id = auth.uid() and is_active
$$;

create or replace function app.current_role_in(variadic roles app.user_role[]) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select coalesce((select role = any(roles) from app.users where id = auth.uid() and is_active), false)
$$;

-- ---------------------------------------------------------------- users
alter table app.users enable row level security;

drop policy if exists users_select on app.users;
create policy users_select on app.users for select to authenticated using (true);   -- names shown across the app

-- UPDATED 28 Sep 2026: MD may manage users too, not just Admin (matches the prototype's MD-manages-
-- users behaviour) — the actual safety rails (can't remove the last MD/Admin, can't self-delete) live
-- in the manage-app-users Edge Function, which is also the only way to CREATE a login (needs the
-- service_role key). This policy only covers editing an existing app.users row (role, is_active, name).
drop policy if exists users_update_admin on app.users;
drop policy if exists users_update_md_admin on app.users;
create policy users_update_md_admin on app.users for update to authenticated
  using (app.current_role_in('md', 'admin')) with check (app.current_role_in('md', 'admin'));

-- A user may rename themself, nothing else: role and is_active must come out unchanged, so nobody
-- can promote or reactivate themself through this policy (that's users_update_md_admin's job, above).
drop policy if exists users_update_own_name on app.users;
create policy users_update_own_name on app.users for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = (select role from app.users where id = auth.uid())
    and is_active = (select is_active from app.users where id = auth.uid())
  );

-- Every new login gets a profile row automatically (role defaults to 'creator'; admin promotes it).
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  insert into app.users (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- ---------------------------------------------------------------- master data
-- Read: everyone signed in. Write: Creator, MD or Admin (confirmed: "both Master Creator and MD can
-- have control", no separate master-data approval step, BusinessQuestions.docx).
do $$
declare t text;
begin
  foreach t in array array['categories', 'shifts', 'parts', 'business_partners', 'partner_contacts',
                            'partner_addresses', 'delivery_locations'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('drop policy if exists %1$I_select on app.%1$I', t);
    execute format('create policy %1$I_select on app.%1$I for select to authenticated using (true)', t);
    execute format('drop policy if exists %1$I_write on app.%1$I', t);
    execute format(
      'create policy %1$I_write on app.%1$I for all to authenticated
         using (app.current_role_in(''creator'', ''md'', ''admin''))
         with check (app.current_role_in(''creator'', ''md'', ''admin''))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- work orders
alter table app.work_orders enable row level security;

drop policy if exists work_orders_select on app.work_orders;
create policy work_orders_select on app.work_orders for select to authenticated using (true);

drop policy if exists work_orders_insert on app.work_orders;
create policy work_orders_insert on app.work_orders for insert to authenticated
  with check (app.current_role_in('creator', 'md'));

-- Coarse "who may touch this row at all"; 003_functions.sql's trigger enforces exactly which
-- columns each role may change (e.g. Planner: only expected_completion_date).
drop policy if exists work_orders_update on app.work_orders;
create policy work_orders_update on app.work_orders for update to authenticated
  using (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and status = 'draft' and created_by = auth.uid())
    or app.current_role_in('planner')
  )
  with check (true);   -- the BEFORE UPDATE trigger raises an exception for a disallowed column change

-- No delete policy anywhere on work_orders: deactivate/cancel via status, never hard-delete (§8 principle).

-- (This line was missing originally, so the policies below were defined but never enforced — see 007.)
alter table app.work_order_lines enable row level security;

drop policy if exists work_order_lines_select on app.work_order_lines;
create policy work_order_lines_select on app.work_order_lines for select to authenticated using (true);

drop policy if exists work_order_lines_write on app.work_order_lines;
create policy work_order_lines_write on app.work_order_lines for all to authenticated
  using (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and exists (
          select 1 from app.work_orders w
          where w.id = work_order_lines.work_order_id and w.status = 'draft' and w.created_by = auth.uid()))
  )
  with check (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and exists (
          select 1 from app.work_orders w
          where w.id = work_order_lines.work_order_id and w.status = 'draft' and w.created_by = auth.uid()))
  );

-- History / audit tables: read for everyone signed in, no direct client write. Only the
-- SECURITY DEFINER trigger functions in 003_functions.sql (running with elevated rights) insert here.
do $$
declare t text;
begin
  foreach t in array array['work_order_revisions', 'status_history', 'completion_date_changes',
                            'finance_approvals', 'audit_events'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('drop policy if exists %1$I_select on app.%1$I', t);
    execute format('create policy %1$I_select on app.%1$I for select to authenticated using (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- production (§4)
alter table app.production_entries enable row level security;
drop policy if exists production_entries_select on app.production_entries;
create policy production_entries_select on app.production_entries for select to authenticated using (true);
drop policy if exists production_entries_write on app.production_entries;
create policy production_entries_write on app.production_entries for insert to authenticated
  with check (app.current_role_in('planner', 'md', 'admin'));

alter table app.production_output_lines enable row level security;
drop policy if exists production_output_lines_select on app.production_output_lines;
create policy production_output_lines_select on app.production_output_lines for select to authenticated using (true);
drop policy if exists production_output_lines_write on app.production_output_lines;
create policy production_output_lines_write on app.production_output_lines for insert to authenticated
  with check (app.current_role_in('planner', 'md', 'admin'));

alter table app.qc_submissions enable row level security;
drop policy if exists qc_submissions_select on app.qc_submissions;
create policy qc_submissions_select on app.qc_submissions for select to authenticated using (true);
drop policy if exists qc_submissions_write on app.qc_submissions;
create policy qc_submissions_write on app.qc_submissions for insert to authenticated
  with check (app.current_role_in('planner', 'md', 'admin'));

-- ---------------------------------------------------------------- QC (§5)
alter table app.qc_inspections enable row level security;
drop policy if exists qc_inspections_select on app.qc_inspections;
create policy qc_inspections_select on app.qc_inspections for select to authenticated using (true);
drop policy if exists qc_inspections_write on app.qc_inspections;
create policy qc_inspections_write on app.qc_inspections for insert to authenticated
  with check (app.current_role_in('qc', 'md', 'admin'));

alter table app.attachments enable row level security;
drop policy if exists attachments_select on app.attachments;
create policy attachments_select on app.attachments for select to authenticated using (true);
drop policy if exists attachments_write on app.attachments;
create policy attachments_write on app.attachments for insert to authenticated
  with check (app.current_role_in('creator', 'md', 'planner', 'qc', 'admin'));

-- ---------------------------------------------------------------- invoicing (§6)
-- No client insert policy: rows are written only by app.generate_invoice() (003_functions.sql),
-- so a generated invoice always uses the server-computed final-price snapshot.
alter table app.invoices enable row level security;
drop policy if exists invoices_select on app.invoices;
create policy invoices_select on app.invoices for select to authenticated using (true);

alter table app.invoice_lines enable row level security;
drop policy if exists invoice_lines_select on app.invoice_lines;
create policy invoice_lines_select on app.invoice_lines for select to authenticated using (true);

-- ---------------------------------------------------------------- notifications (§9)
-- No client insert policy: only the status-change trigger (SECURITY DEFINER) creates notifications,
-- so a user can never forge one. A user may only mark their own as read.
alter table app.notifications enable row level security;
drop policy if exists notifications_select on app.notifications;
create policy notifications_select on app.notifications for select to authenticated
  using (user_id = auth.uid() or user_id is null);
drop policy if exists notifications_update on app.notifications;
create policy notifications_update on app.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Business logic that must be atomic and server-enforced (never trust the client for these): WO
-- numbering, revisioning, column-level edit rules per role, status recomputation, invoicing.
-- These are this app's "API" in the sense NestJS controllers would otherwise have been (v1.3 §9).

-- ---------------------------------------------------------------- WO numbering (§3.1, §10: unique, never reused)
-- One counter per Indian financial year (Apr-Mar), so numbers read NNN/2026-27 and restart each FY.
-- DECISION TO CONFIRM WITH BUSINESS: this starts a NEW system at 1 each FY. If SGR wants Work Order
-- numbers to continue the paper/prototype system's existing count instead of restarting, change the
-- starting `next_number` in app.wo_number_counters for the current FY once, before go-live.
create table if not exists app.wo_number_counters (
  fiscal_year_start int primary key,
  next_number        int not null default 1
);

create or replace function app.fiscal_year_label(for_date date) returns text
language sql immutable as $$
  select (case when extract(month from for_date) < 4
               then extract(year from for_date)::int - 1
               else extract(year from for_date)::int end)::text
         || '-' ||
         lpad(((case when extract(month from for_date) < 4
                     then extract(year from for_date)::int
                     else extract(year from for_date)::int + 1 end) % 100)::text, 2, '0')
$$;

create or replace function app.next_wo_number(for_date date default current_date) returns text
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  fy int := case when extract(month from for_date) < 4
                 then extract(year from for_date)::int - 1
                 else extract(year from for_date)::int end;
  n int;
begin
  insert into app.wo_number_counters (fiscal_year_start, next_number) values (fy, 2)
  on conflict (fiscal_year_start) do update set next_number = app.wo_number_counters.next_number + 1
  returning next_number - 1 into n;
  return n || '/' || app.fiscal_year_label(for_date);
end $$;

-- ---------------------------------------------------------------- create / update Work Orders
-- Draft: the Creator's own, freely re-savable, never numbered. payload shape mirrors work_orders'
-- editable columns plus a `lines` array (see README for the exact JSON shape and a worked example).
create or replace function app.save_draft(p_id uuid, p jsonb) returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
begin
  insert into app.work_orders as w (
    id, status, partner_id, delivery_location_id, delivery_location_snapshot, wo_date, delivery_date,
    doc_ref, test_cert_required, inspection_report_required, additional_notes, packing_required,
    units_per_bundle, pallet_height_in, separate_vehicle_required, transport_notes, created_by, updated_by
  ) values (
    v_id, 'draft', (p->>'partner_id')::uuid, (p->>'delivery_location_id')::uuid, p->'delivery_location_snapshot',
    coalesce((p->>'wo_date')::date, current_date), (p->>'delivery_date')::date, p->>'doc_ref',
    coalesce((p->>'test_cert_required')::boolean, false), coalesce((p->>'inspection_report_required')::boolean, false),
    p->>'additional_notes', coalesce((p->>'packing_required')::boolean, true), (p->>'units_per_bundle')::int,
    (p->>'pallet_height_in')::numeric, coalesce((p->>'separate_vehicle_required')::boolean, false),
    p->>'transport_notes', auth.uid(), auth.uid()
  )
  on conflict (id) do update set
    partner_id = excluded.partner_id, delivery_location_id = excluded.delivery_location_id,
    delivery_location_snapshot = excluded.delivery_location_snapshot, wo_date = excluded.wo_date,
    delivery_date = excluded.delivery_date, doc_ref = excluded.doc_ref,
    test_cert_required = excluded.test_cert_required, inspection_report_required = excluded.inspection_report_required,
    additional_notes = excluded.additional_notes, packing_required = excluded.packing_required,
    units_per_bundle = excluded.units_per_bundle, pallet_height_in = excluded.pallet_height_in,
    separate_vehicle_required = excluded.separate_vehicle_required, transport_notes = excluded.transport_notes,
    updated_by = auth.uid(), updated_at = now()
  where w.status = 'draft' and w.created_by = auth.uid();   -- re-saving someone else's draft is a no-op, not an error

  delete from app.work_order_lines where work_order_id = v_id;
  insert into app.work_order_lines (
    work_order_id, line_no, part_id, part_no_snapshot, description_snapshot, uom_snapshot,
    standard_weight_kg_snapshot, category_snapshot, standard_price_snapshot, final_price, qty, remarks
  )
  select v_id, ord, (l->>'part_id')::uuid, prt.part_no, prt.description, prt.uom, prt.standard_weight_kg,
         cat.name, prt.price, prt.price, coalesce((l->>'qty')::numeric, 0), l->>'remarks'
  from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) with ordinality as t(l, ord)
  join app.parts prt on prt.id = (l->>'part_id')::uuid
  left join app.categories cat on cat.id = prt.category_id;

  return v_id;
end $$;

-- Promotes a draft to a real, numbered Work Order and sends it to Finance for approval (UPDATED
-- 28 Sep 2026: a created Work Order no longer goes straight to the production floor — it sits in
-- 'pending_finance_approval' until app.approve_work_order() releases it). Validates §10's minimum bar.
create or replace function app.create_work_order(p_id uuid) returns app.work_orders
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_wo app.work_orders;
  v_line_count int;
begin
  select * into v_wo from app.work_orders where id = p_id for update;
  if v_wo is null then raise exception 'Work order % not found', p_id; end if;
  if v_wo.status <> 'draft' then raise exception 'Work order % is not a draft', p_id; end if;
  if v_wo.created_by <> auth.uid() and not app.current_role_in('md', 'admin') then
    raise exception 'Only the creator or MD may create this work order';
  end if;
  if v_wo.partner_id is null then raise exception 'Select a Business Partner before creating.'; end if;
  if v_wo.delivery_location_id is null then raise exception 'Select a Delivery Location before creating.'; end if;
  if v_wo.delivery_date is null then raise exception 'Enter a Delivery Date before creating.'; end if;
  select count(*) into v_line_count from app.work_order_lines where work_order_id = p_id;
  if v_line_count = 0 then raise exception 'Add at least one line item before creating.'; end if;

  perform set_config('app.bypass_edit_check', 'true', true);
  -- status_history + the notification are NOT inserted here: the work_orders_status_log AFTER
  -- UPDATE trigger (below) fires on this same UPDATE and logs both generically for every status
  -- change, wherever it originates. Inserting them here too would double them up.
  -- coalesce(wo_number, ...): a Work Order rejected by Finance comes back here as a draft and keeps
  -- its original number on resubmission rather than burning a second one from the counter.
  update app.work_orders
     set wo_number = coalesce(wo_number, app.next_wo_number(current_date)),
         status = 'pending_finance_approval', updated_by = auth.uid(), updated_at = now()
   where id = p_id
  returning * into v_wo;

  return v_wo;
end $$;

-- ---------------------------------------------------------------- Finance approval (added 28 Sep 2026)
-- A created Work Order is held here until Finance reviews it. Approve releases it to the production
-- floor exactly as 'created' always has (no other behaviour changes); reject sends it back to the
-- Creator as an editable draft, with a reason, rather than a dead end.
create or replace function app.approve_work_order(p_work_order_id uuid, p_comments text default null) returns app.work_orders
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_wo app.work_orders;
begin
  if not app.current_role_in('finance', 'admin') then raise exception 'Only Finance may approve a Work Order.'; end if;

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
  if not app.current_role_in('finance', 'admin') then raise exception 'Only Finance may reject a Work Order.'; end if;
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
  -- Back to 'draft': the Creator can fix and resubmit through the exact same create_work_order()
  -- path, which reuses this same wo_number rather than assigning a new one.
  update app.work_orders set status = 'draft', updated_by = auth.uid(), updated_at = now()
   where id = p_work_order_id
  returning * into v_wo;

  return v_wo;
end $$;

revoke all on function app.approve_work_order(uuid, text) from public, anon;
grant execute on function app.approve_work_order(uuid, text) to authenticated;
revoke all on function app.reject_work_order(uuid, text) from public, anon;
grant execute on function app.reject_work_order(uuid, text) to authenticated;

-- ---------------------------------------------------------------- MD edits -> automatic revisioning (§6)
-- Column-level enforcement RLS can't express: Planner may change ONLY expected_completion_date;
-- Creator only while status='draft'; MD may change any business field, which opens a new revision.
create or replace function app.enforce_work_order_edit() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_role app.user_role := app.current_role();
  v_business_changed boolean;
begin
  if current_setting('app.bypass_edit_check', true) = 'true' then
    return new;   -- internal system update (status recompute, create_work_order) — already validated above
  end if;

  if v_role in ('md', 'admin') then
    -- allowed; falls through to revisioning below
    null;
  elsif v_role = 'creator' then
    if old.status <> 'draft' then raise exception 'Only MD may edit a Work Order once it is created.'; end if;
  elsif v_role = 'planner' then
    -- Planner may change ONLY expected_completion_date. Reject (never silently discard) any other
    -- attempted change, so a client that saves back a whole loaded row fails loudly, not quietly.
    if (old.wo_number, old.revision, old.status, old.partner_id, old.delivery_location_id, old.wo_date,
        old.delivery_date, old.doc_ref, old.test_cert_required, old.inspection_report_required,
        old.additional_notes, old.packing_required, old.units_per_bundle, old.pallet_height_in,
        old.separate_vehicle_required, old.transport_notes)
       is distinct from
       (new.wo_number, new.revision, new.status, new.partner_id, new.delivery_location_id, new.wo_date,
        new.delivery_date, new.doc_ref, new.test_cert_required, new.inspection_report_required,
        new.additional_notes, new.packing_required, new.units_per_bundle, new.pallet_height_in,
        new.separate_vehicle_required, new.transport_notes) then
      raise exception 'Production Planner may change only the Expected Completion Date.';
    end if;
    if new.expected_completion_date is distinct from old.expected_completion_date then
      insert into app.completion_date_changes (work_order_id, from_date, to_date, changed_by)
        values (old.id, old.expected_completion_date, new.expected_completion_date, auth.uid());
    end if;
    new.updated_by := auth.uid(); new.updated_at := now();
    return new;
  else
    raise exception 'Role % may not edit Work Orders', v_role;
  end if;

  -- MD path: any business-field change opens a new revision, preserving the prior snapshot (§6).
  v_business_changed := (old.delivery_date, old.doc_ref, old.test_cert_required, old.inspection_report_required,
                          old.additional_notes, old.packing_required, old.units_per_bundle, old.pallet_height_in,
                          old.separate_vehicle_required, old.transport_notes)
                     is distinct from
                         (new.delivery_date, new.doc_ref, new.test_cert_required, new.inspection_report_required,
                          new.additional_notes, new.packing_required, new.units_per_bundle, new.pallet_height_in,
                          new.separate_vehicle_required, new.transport_notes);
  if v_business_changed and old.status <> 'draft' then
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

drop trigger if exists work_orders_edit_guard on app.work_orders;
create trigger work_orders_edit_guard before update on app.work_orders
  for each row execute function app.enforce_work_order_edit();

-- Any status change gets one status_history row, whoever/whatever caused it.
create or replace function app.log_status_change() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  if new.status is distinct from old.status then
    insert into app.status_history (work_order_id, from_status, to_status, changed_by)
      values (new.id, old.status, new.status, auth.uid());
    insert into app.notifications (user_id, work_order_id, message)
      values (null, new.id, 'Work Order ' || coalesce(new.wo_number, '(draft)') || ' is now ' || new.status || '.');
  end if;
  return new;
end $$;

drop trigger if exists work_orders_status_log on app.work_orders;
create trigger work_orders_status_log after update on app.work_orders
  for each row execute function app.log_status_change();

-- ---------------------------------------------------------------- status recompute (§7)
-- DOCUMENTED CHOICE (exact rule is explicitly open in v1.3 §4/§10/§13 — revisit with business):
--   no production yet            -> in_production stays 'created'
--   produced, nothing submitted to QC in full -> 'in_production'
--   something submitted, not fully inspected  -> 'qc_pending'
--   some inspected (accepted or held), not all ordered qty accepted -> 'partially_qc_approved'
--   all ordered qty accepted                  -> 'ready_for_dispatch'
-- 'draft', 'pending_finance_approval', 'completed' and 'cancelled' are set explicitly, never
-- recomputed from production/QC activity (there shouldn't be any yet for the first two — see
-- app.record_production()'s guard — but this stays explicit rather than relying on that alone).
create or replace function app.recompute_work_order_status(p_work_order_id uuid) returns void
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_status app.wo_status;
  v_ordered numeric; v_produced numeric; v_submitted numeric; v_accepted numeric;
begin
  select status into v_status from app.work_orders where id = p_work_order_id;
  if v_status in ('draft', 'pending_finance_approval', 'completed', 'cancelled') then return; end if;

  select coalesce(sum(l.qty), 0) into v_ordered from app.work_order_lines l where l.work_order_id = p_work_order_id;
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

create or replace function app.recompute_status_from_output_line() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_wo_id uuid;
begin
  select work_order_id into v_wo_id from app.work_order_lines where id = new.work_order_line_id;
  perform app.recompute_work_order_status(v_wo_id);
  return new;
end $$;
drop trigger if exists production_output_status on app.production_output_lines;
create trigger production_output_status after insert on app.production_output_lines
  for each row execute function app.recompute_status_from_output_line();

create or replace function app.recompute_status_from_qc() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_wo_id uuid;
begin
  select work_order_id into v_wo_id from app.work_order_lines where id = new.work_order_line_id;
  perform app.recompute_work_order_status(v_wo_id);
  return new;
end $$;
drop trigger if exists qc_submission_status on app.qc_submissions;
create trigger qc_submission_status after insert on app.qc_submissions
  for each row execute function app.recompute_status_from_qc();
drop trigger if exists qc_inspection_status on app.qc_inspections;
create trigger qc_inspection_status after insert on app.qc_inspections
  for each row execute function app.recompute_status_from_qc();

-- ---------------------------------------------------------------- production entry (§4)
-- One call: the daily header + its output lines, in one transaction, with the over-production guard
-- (§10: "Prevent over-production or require an explicit, audited override" — Phase 1 default: prevent).
create or replace function app.record_production(p jsonb) returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare
  v_entry_id uuid;
  v_line record;
  v_produced_so_far numeric;
  v_qty numeric;
  v_wo_status app.wo_status;
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

  insert into app.production_entries (work_order_id, production_date, shift_id, labour_count, planner_id)
  values ((p->>'work_order_id')::uuid, coalesce((p->>'production_date')::date, current_date),
          (p->>'shift_id')::uuid, (p->>'labour_count')::int, auth.uid())
  returning id into v_entry_id;

  for v_line in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) as x(v) loop
    v_qty := (v_line.v->>'qty')::numeric;
    continue when v_qty is null or v_qty <= 0;

    select coalesce(sum(o.qty), 0) into v_produced_so_far
      from app.production_output_lines o where o.work_order_line_id = (v_line.v->>'work_order_line_id')::uuid;

    if v_produced_so_far + v_qty > (select l.qty from app.work_order_lines l where l.id = (v_line.v->>'work_order_line_id')::uuid) then
      raise exception 'Line %: % would take produced to %, above the ordered quantity.',
        (v_line.v->>'work_order_line_id')::uuid, v_qty, v_produced_so_far + v_qty;
    end if;

    insert into app.production_output_lines (production_entry_id, work_order_line_id, qty, actual_weight_kg, note)
    values (v_entry_id, (v_line.v->>'work_order_line_id')::uuid, v_qty,
            coalesce((v_line.v->>'actual_weight_kg')::numeric, 0), v_line.v->>'note');
  end loop;

  return v_entry_id;
end $$;

-- Sends everything produced-but-not-yet-sent for a line to QC in one action (§4: partial output can
-- be sent separately, so this is called once per line, not once per Work Order).
create or replace function app.send_line_to_qc(p_work_order_line_id uuid) returns numeric
language plpgsql security invoker set search_path = app, pg_temp as $$
declare v_produced numeric; v_sent numeric; v_amount numeric;
begin
  if not app.current_role_in('planner', 'md', 'admin') then
    raise exception 'Only the Production Planner (or MD) may send output to QC.';
  end if;
  select coalesce(sum(qty), 0) into v_produced from app.production_output_lines where work_order_line_id = p_work_order_line_id;
  select coalesce(sum(qty), 0) into v_sent from app.qc_submissions where work_order_line_id = p_work_order_line_id;
  v_amount := v_produced - v_sent;
  if v_amount <= 0 then raise exception 'Nothing new to send to QC for this line.'; end if;
  insert into app.qc_submissions (work_order_line_id, qty, submitted_by) values (p_work_order_line_id, v_amount, auth.uid());
  return v_amount;
end $$;

-- ---------------------------------------------------------------- QC inspection (§5)
-- One inspection decides ALL of a line's currently-awaiting quantity: accepted_qty advances toward
-- Ready for Dispatch, the remainder becomes Held (never silently accepted, never silently dropped —
-- §5's own warning, since Phase 1 has no reject/rework workflow yet). Held is recoverable via
-- app.reopen_held(), not a dead end.
create or replace function app.record_qc_inspection(p_work_order_line_id uuid, p_accepted_qty numeric, p_comments text)
returns uuid
language plpgsql security invoker set search_path = app, pg_temp as $$
declare v_sent numeric; v_approved numeric; v_held numeric; v_awaiting numeric; v_id uuid;
begin
  if not app.current_role_in('qc', 'md', 'admin') then raise exception 'Only QC (or MD) may record an inspection.'; end if;
  select coalesce(sum(qty), 0) into v_sent from app.qc_submissions where work_order_line_id = p_work_order_line_id;
  select coalesce(sum(accepted_qty), 0), coalesce(sum(held_qty), 0) into v_approved, v_held
    from app.qc_inspections where work_order_line_id = p_work_order_line_id;
  v_awaiting := v_sent - v_approved - v_held;
  if v_awaiting <= 0 then raise exception 'Nothing is awaiting inspection for this line.'; end if;
  if p_accepted_qty < 0 or p_accepted_qty > v_awaiting then
    raise exception 'Accepted quantity must be between 0 and %.', v_awaiting;
  end if;

  insert into app.qc_inspections (work_order_line_id, accepted_qty, held_qty, comments, inspector_id)
  values (p_work_order_line_id, p_accepted_qty, v_awaiting - p_accepted_qty, p_comments, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Brings previously-Held quantity back into the awaiting-inspection pool.
create or replace function app.reopen_held(p_work_order_line_id uuid) returns numeric
language plpgsql security invoker set search_path = app, pg_temp as $$
declare v_held numeric;
begin
  if not app.current_role_in('qc', 'md', 'admin') then raise exception 'Only QC (or MD) may reopen held quantity.'; end if;
  select coalesce(sum(held_qty), 0) into v_held from app.qc_inspections where work_order_line_id = p_work_order_line_id;
  if v_held <= 0 then raise exception 'Nothing is held for this line.'; end if;
  -- A zeroing inspection row moves held back to "awaiting" without ever deleting the original record.
  insert into app.qc_inspections (work_order_line_id, accepted_qty, held_qty, comments, inspector_id)
  values (p_work_order_line_id, 0, -v_held, 'Reopened for re-inspection', auth.uid());
  perform app.recompute_work_order_status((select work_order_id from app.work_order_lines where id = p_work_order_line_id));
  return v_held;
end $$;

-- ---------------------------------------------------------------- invoicing (§6)
-- OPEN DECISION (v1.3 §13): invoice quantity basis. Phase 1 default: QC-approved quantity once any
-- exists for a line, else ordered quantity (matches the Phase 1 wireframe) — confirm with business.
create or replace function app.generate_invoice(p_work_order_id uuid, p_gst_rate numeric, p_supply_type app.supply_type)
returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_invoice_id uuid;
  v_number text;
  v_subtotal numeric := 0;
  v_line record;
  v_qty numeric;
  v_amount numeric;
  v_cgst numeric := 0; v_sgst numeric := 0; v_igst numeric := 0; v_total numeric;
  v_seq int;
  v_status app.wo_status;
begin
  if not app.current_role_in('md', 'admin') then raise exception 'Only MD may generate an invoice.'; end if;

  select status into v_status from app.work_orders where id = p_work_order_id;
  if v_status is null then raise exception 'Work order % not found', p_work_order_id; end if;
  if v_status in ('draft', 'pending_finance_approval') then
    raise exception 'Cannot generate an invoice before this Work Order is created and approved by Finance.';
  end if;

  insert into app.wo_number_counters (fiscal_year_start, next_number) values (-1, 2)
  on conflict (fiscal_year_start) do update set next_number = app.wo_number_counters.next_number + 1
  returning next_number - 1 into v_seq;
  v_number := 'INV/' || app.fiscal_year_label(current_date) || '/' || lpad(v_seq::text, 4, '0');

  insert into app.invoices (work_order_id, invoice_number, gst_rate, supply_type, subtotal, grand_total)
  values (p_work_order_id, v_number, p_gst_rate, p_supply_type, 0, 0) returning id into v_invoice_id;

  for v_line in select l.*, coalesce((select sum(accepted_qty) from app.qc_inspections where work_order_line_id = l.id), 0) as qc_qty
                from app.work_order_lines l where l.work_order_id = p_work_order_id loop
    v_qty := case when v_line.qc_qty > 0 then v_line.qc_qty else v_line.qty end;
    v_amount := v_qty * v_line.final_price;
    v_subtotal := v_subtotal + v_amount;
    insert into app.invoice_lines (invoice_id, work_order_line_id, description, qty, price, amount)
    values (v_invoice_id, v_line.id, v_line.description_snapshot, v_qty, v_line.final_price, v_amount);
  end loop;

  if p_supply_type = 'intra' then
    v_cgst := round(v_subtotal * p_gst_rate / 200, 2); v_sgst := v_cgst;
  else
    v_igst := round(v_subtotal * p_gst_rate / 100, 2);
  end if;
  v_total := v_subtotal + v_cgst + v_sgst + v_igst;

  update app.invoices set subtotal = v_subtotal, cgst = v_cgst, sgst = v_sgst, igst = v_igst,
                          grand_total = v_total, generated_by = auth.uid()
  where id = v_invoice_id;

  return v_invoice_id;
end $$;

revoke all on function app.generate_invoice(uuid, numeric, app.supply_type) from public, anon;
grant execute on function app.generate_invoice(uuid, numeric, app.supply_type) to authenticated;
-- Reference/master data from docs/architecture v1.3 Appendices A-D (SGR Master.xlsx + the earlier
-- prototype screenshot). Safe to re-run. Business/transactional data (work orders, production, QC,
-- invoices) is deliberately NOT seeded here — that starts empty in every environment.

insert into app.categories (code, name, description) values
  ('CAT-001', 'Edge Board', 'Paper-based protective edge and corner boards.'),
  ('CAT-002', 'Carton box', 'Corrugated cartons for packing and shipment.'),
  ('CAT-003', 'Paper Slitting E-CORE', 'Paper cores produced for slitting operations.'),
  ('CAT-004', 'Pyro', 'Pyro')                       -- transcribed as-is from SGR Master.xlsx; reads as a placeholder
on conflict (code) do update set name = excluded.name, description = excluded.description;

insert into app.shifts (code, name, start_time, end_time) values
  ('1', 'Morning',  '06:00', '14:00'),
  ('2', 'Evening',  '14:00', '22:00'),
  ('3', 'Night',    '22:00', '06:00'),               -- overnight: end_time < start_time, by design
  ('4', 'General',  '08:00', '18:00')
on conflict (code) do update set name = excluded.name, start_time = excluded.start_time, end_time = excluded.end_time;

-- Parts: rows 1-5 from the prototype screenshot, rows 6-7 from SGR Master.xlsx's "Item master" sheet.
-- CONFLICT FLAGGED IN docs/architecture v1.3, APPENDIX B: two numbering conventions (EB0806xxxxx vs
-- EB1005xxxxx) — both seeded so nothing is silently dropped; resolve with business before go-live.
-- Row 7 (EB1005000120)'s category is "Pyro" in the source despite its "EB" part-number prefix.
with c as (select id, name from app.categories)
insert into app.parts (part_no, description, uom, standard_weight_kg, category_id, price, remarks, customer_ref)
select v.part_no, v.description, v.uom, v.weight, c.id, v.price, v.remarks, v.customer_ref
from (values
  ('EB080600002', 'EB 80 x 80 x 6 x 840 mm',   'NOS', 6.42, 'Edge Board',            18.50, 'Brown kraft',  null),
  ('EB080600003', 'EB 80 x 80 x 6 x 990 mm',   'NOS', 7.56, 'Edge Board',            21.25, 'Brown kraft',  null),
  ('EB075600011', 'EB 75 x 75 x 6 x 1219 mm',  'NOS', 7.11, 'Edge Board',            24.00, 'As per PO',    'PUR-VB0RD48-PKG'),
  ('CB1200450',   '5-ply carton box - 450 x 320 x 280 mm', 'NOS', 0.82, 'Carton box', 42.00, '5-ply export', 'APA-CB-450'),
  ('EC075020',    'Paper Slitting E-CORE - 75 mm', 'NOS', 1.18, 'Paper Slitting E-CORE', 36.50, 'Heavy duty', null),
  ('EB1005000181','EB 100 x 100 x 5 x 380 mm', 'NOS', 0.25, 'Edge Board',            50.00, null,           null),
  ('EB1005000120','EB 120 x 10 x 2.5 x 380 mm','NOS', 0.40, 'Pyro',                  35.00, null,           null)
) as v(part_no, description, uom, weight, category_name, price, remarks, customer_ref)
join c on c.name = v.category_name
on conflict (part_no) do update set description = excluded.description, uom = excluded.uom,
  standard_weight_kg = excluded.standard_weight_kg, category_id = excluded.category_id,
  price = excluded.price, remarks = excluded.remarks, customer_ref = excluded.customer_ref;

-- Vendors: SAMPLE STRUCTURE ONLY (docs/architecture v1.3, Appendix D) — "ABC Ltd" / "XYZ Ltd" /
-- "MNX Ltd" and their GSTINs are placeholder values from SGR Master.xlsx, not real business records.
-- Replace with real vendor data before go-live; this exists to prove one vendor -> many contacts ->
-- many delivery locations works end to end.
insert into app.business_partners (code, name, gstin, is_customer, is_supplier) values
  ('ABC01', 'ABC Ltd', '33ABCDE1234F1Z1', true, false),
  ('XYX01', 'XYZ Ltd', '33ABCDE1234F1Z2', true, false),
  ('MXN01', 'MNX Ltd', '33ABCDE1234F1Z3', true, false)
on conflict (code) do update set name = excluded.name, gstin = excluded.gstin;

with p as (select id, code from app.business_partners)
insert into app.partner_contacts (partner_id, name, phone, email, is_primary)
select p.id, v.name, v.phone, v.email, v.is_primary
from (values
  ('ABC01', 'Arvind',  '90000 00001', 'arvind@abc.com', true),
  ('ABC01', 'Anand',   '90000 00002', 'anand@abc.com',  false),
  ('ABC01', 'Akash',   '90000 00003', 'akash@abc.com',  false),
  ('XYX01', 'Velan',   '80000 00001', 'Velan@xyz.com',  true),
  ('XYX01', 'Murugan', '80000 00002', 'mur@xyz.com',    false),
  ('MXN01', 'Ganga',   '70000 00001', 'ganga@mnx.com',  true)
) as v(partner_code, name, phone, email, is_primary)
join p on p.code = v.partner_code
where not exists (
  select 1 from app.partner_contacts pc where pc.partner_id = p.id and pc.email = v.email
);

with p as (select id, code from app.business_partners)
insert into app.partner_addresses (partner_id, kind, line1, city, is_primary)
select p.id, 'delivery', v.line1, v.city, v.is_primary
from (values
  ('ABC01', '1, First St',    'Chennai',     true),
  ('ABC01', '2, Second St',   'Cochin',      false),
  ('ABC01', '3, Third St',    'Coimbatore',  false),
  ('XYX01', '23, Mount Rd',   'Chennai',     true),
  ('XYX01', '12, River Road', 'Salem',       false),
  ('MXN01', '123, Last St',   'Madurai',     true)
) as v(partner_code, line1, city, is_primary)
join p on p.code = v.partner_code
where not exists (
  select 1 from app.partner_addresses pa where pa.partner_id = p.id and pa.line1 = v.line1
);

insert into app.delivery_locations (partner_id, address_id, label)
select pa.partner_id, pa.id, (select name from app.business_partners where id = pa.partner_id) || ' - ' || pa.city
from app.partner_addresses pa
where not exists (select 1 from app.delivery_locations dl where dl.address_id = pa.id);
-- Privileges for the Data API roles. RLS (002_rls.sql) decides WHICH ROWS a signed-in user may touch;
-- this file decides whether the API roles may reach the `app` schema at all. Without it every request
-- fails with "permission denied for schema app". Safe to re-run.
--
-- Model: `anon` (a signed-out visitor) gets nothing in `app`. `authenticated` gets table access that
-- RLS then narrows, and execute rights ONLY on the functions the app calls (or that RLS/`reopen_held`
-- run as the signed-in user). Everything else — the trigger functions, next_wo_number, fiscal_year_label —
-- stays internal, whatever the dashboard's per-function toggles say.

grant usage on schema app to authenticated;
revoke all on schema app from anon;

-- Tables
revoke all on all tables in schema app from anon;
grant select, insert, update, delete on all tables in schema app to authenticated;

-- The WO number counter is touched only by SECURITY DEFINER functions (which run as the table owner and
-- bypass RLS); with RLS on and no policy, a signed-in user cannot read or move it directly.
alter table app.wo_number_counters enable row level security;

-- Functions: nothing by default...
revoke execute on all functions in schema app from public, anon, authenticated;
alter default privileges in schema app revoke execute on functions from public, anon;

-- ...then only what a signed-in user must be able to run.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'
      and p.proname in (
        'current_role', 'current_role_in',                        -- evaluated inside every RLS policy
        'save_draft', 'create_work_order', 'approve_work_order', 'reject_work_order',
        'record_production', 'send_line_to_qc', 'record_qc_inspection', 'reopen_held',
        'generate_invoice',
        'recompute_work_order_status'                             -- called directly by reopen_held (SECURITY INVOKER)
      )
  loop
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
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
-- 007: the Creator may edit their own Work Order — every field, the vendor, the line items (part #, qty,
-- customer ref) and the notes — until Finance approves it. Safe to re-run.
--
--   draft                     editable  (new, or bounced back by a Finance rejection)
--   pending_finance_approval  editable  (created, waiting for Finance)   <- new in this migration
--   created and later         MD/Admin only, as before (and each MD edit still opens a new revision)
--
-- Nothing has gone to the floor before approval, so edits at these two stages are not "revisions".

-- ---------------------------------------------------------------- SECURITY FIX: RLS was never switched on for line items
-- 002_rls.sql defined policies for app.work_order_lines but never ran ALTER TABLE ... ENABLE ROW LEVEL
-- SECURITY on it, so they were not enforced: any signed-in user could edit or delete any order's lines
-- (quantities, prices). Enabling it applies the policies below (and the existing select-for-everyone one).
alter table app.work_order_lines enable row level security;

-- ---------------------------------------------------------------- who may touch the rows (RLS)
drop policy if exists work_orders_update on app.work_orders;
create policy work_orders_update on app.work_orders for update to authenticated
  using (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and status in ('draft', 'pending_finance_approval') and created_by = auth.uid())
    or app.current_role_in('planner')
  )
  with check (true);   -- the BEFORE UPDATE trigger below rejects a disallowed change

drop policy if exists work_order_lines_write on app.work_order_lines;
create policy work_order_lines_write on app.work_order_lines for all to authenticated
  using (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and exists (
          select 1 from app.work_orders w
          where w.id = work_order_lines.work_order_id
            and w.status in ('draft', 'pending_finance_approval') and w.created_by = auth.uid()))
  )
  with check (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and exists (
          select 1 from app.work_orders w
          where w.id = work_order_lines.work_order_id
            and w.status in ('draft', 'pending_finance_approval') and w.created_by = auth.uid()))
  );

drop policy if exists work_order_notes_write on app.work_order_notes;
create policy work_order_notes_write on app.work_order_notes for all to authenticated
  using (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and exists (
          select 1 from app.work_orders w
          where w.id = work_order_notes.work_order_id
            and w.status in ('draft', 'pending_finance_approval') and w.created_by = auth.uid()))
  )
  with check (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and exists (
          select 1 from app.work_orders w
          where w.id = work_order_notes.work_order_id
            and w.status in ('draft', 'pending_finance_approval') and w.created_by = auth.uid()))
  );

-- ---------------------------------------------------------------- which columns may change (trigger)
-- Same rules as 003, plus two things:
--  1. status / wo_number / revision / created_by can no longer be changed by a direct UPDATE from anyone.
--     Only the app's own functions change them (they set app.bypass_edit_check). Before this, a Creator
--     could have set their own order's status straight to 'created' and skipped Finance.
--  2. A Creator may edit while the order is a draft OR waiting for Finance; edits at those two stages
--     do not open a revision.
create or replace function app.enforce_work_order_edit() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_role app.user_role := app.current_role();
  v_business_changed boolean;
begin
  if current_setting('app.bypass_edit_check', true) = 'true' then
    return new;   -- internal system update (status recompute, create/approve/reject) — already validated there
  end if;

  if (old.status, old.wo_number, old.revision, old.created_by)
     is distinct from (new.status, new.wo_number, new.revision, new.created_by) then
    raise exception 'Status, Work Order number and revision change only through the app''s own actions, not by editing the record.';
  end if;

  if v_role in ('md', 'admin') then
    null;   -- allowed; falls through to revisioning below
  elsif v_role = 'creator' then
    if old.status not in ('draft', 'pending_finance_approval') then
      raise exception 'Once Finance has approved a Work Order, only the MD may edit it.';
    end if;
    if new.expected_completion_date is distinct from old.expected_completion_date then
      raise exception 'Only the Production Planner sets the Expected Completion Date.';
    end if;
  elsif v_role = 'planner' then
    if (old.partner_id, old.delivery_location_id, old.wo_date,
        old.delivery_date, old.doc_ref, old.test_cert_required, old.inspection_report_required,
        old.additional_notes, old.packing_required, old.units_per_bundle, old.pallet_height_in,
        old.separate_vehicle_required, old.transport_notes)
       is distinct from
       (new.partner_id, new.delivery_location_id, new.wo_date,
        new.delivery_date, new.doc_ref, new.test_cert_required, new.inspection_report_required,
        new.additional_notes, new.packing_required, new.units_per_bundle, new.pallet_height_in,
        new.separate_vehicle_required, new.transport_notes) then
      raise exception 'Production Planner may change only the Expected Completion Date.';
    end if;
    if new.expected_completion_date is distinct from old.expected_completion_date then
      insert into app.completion_date_changes (work_order_id, from_date, to_date, changed_by)
        values (old.id, old.expected_completion_date, new.expected_completion_date, auth.uid());
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

-- ---------------------------------------------------------------- save_draft: also covers a waiting order
-- Identical to 006 except the header UPDATE now also applies while the order is pending Finance approval.
-- The status is never touched here: a pending order stays pending after an edit.
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
  where w.status in ('draft', 'pending_finance_approval') and w.created_by = auth.uid();

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
-- 008: let Supabase's server-side admin role (`service_role`) reach the `app` schema. Safe to re-run.
--
-- The manage-app-users Edge Function uses the service_role key to look up the caller's row in app.users
-- and to create/update/delete logins. service_role bypasses row-level security, but it still needs plain
-- Postgres privileges, and 005_grants.sql only granted them to `authenticated`. Without this the lookup was
-- refused and the Users page said "Only MD or Admin can manage users" even to the MD.
--
-- service_role is a server-only key that never reaches a browser, so full access is appropriate.

grant usage on schema app to service_role;
grant all on all tables in schema app to service_role;
grant all on all sequences in schema app to service_role;
grant execute on all functions in schema app to service_role;

alter default privileges in schema app grant all on tables to service_role;
alter default privileges in schema app grant all on sequences to service_role;
alter default privileges in schema app grant execute on functions to service_role;
-- 009: file uploads for QC inspections (test reports, certificates, scans — photos come later).
-- Safe to re-run.
--
-- The file bytes live in a PRIVATE Supabase Storage bucket; app.attachments (already in 001) holds one
-- row per file: which Work Order and inspection it belongs to, its original name, and its storage path.
-- Nothing is public: the app opens files through short-lived signed links.

-- ---------------------------------------------------------------- who may add attachment rows
-- QC (and MD/Admin) attach files to an inspection. Files that belong to a Work Order but not to an
-- inspection may be added by the Creator, MD, Planner or Admin. Nobody can edit or delete a row: a file
-- attached to an inspection stays on record.
drop policy if exists attachments_write on app.attachments;
create policy attachments_write on app.attachments for insert to authenticated
  with check (
    app.current_role_in('qc', 'md', 'admin')
    or (qc_inspection_id is null and app.current_role_in('creator', 'planner'))
  );

-- ---------------------------------------------------------------- the storage bucket + its rules
-- Guarded so the migration still runs where Supabase Storage doesn't exist (the local test database
-- creates a minimal stand-in for it).
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present — skipping the qc-attachments bucket';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'qc-attachments', 'qc-attachments', false, 10485760,   -- 10 MB per file
    array[
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf', 'text/plain', 'text/csv',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
  )
  on conflict (id) do update
    set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

  -- Anyone active and signed in can read (same as the attachment rows themselves) ...
  execute 'drop policy if exists qc_files_read on storage.objects';
  execute $p$create policy qc_files_read on storage.objects for select to authenticated
             using (bucket_id = 'qc-attachments' and app.current_role() is not null)$p$;

  -- ... only QC / MD / Admin can upload, and nobody can overwrite or delete.
  execute 'drop policy if exists qc_files_upload on storage.objects';
  execute $p$create policy qc_files_upload on storage.objects for insert to authenticated
             with check (bucket_id = 'qc-attachments' and app.current_role_in('qc', 'md', 'admin'))$p$;
end $$;
-- 010: billing against finished goods, and dispatch. Safe to re-run.
--
--   Finished Goods       QC-approved quantity that has not been billed yet  -> MD/Admin creates the invoice
--   Ready for Dispatch   an invoice that exists but has not left the gate    -> MD/Admin marks it dispatched
--
-- (1) generate_invoice now bills only what is QC-approved AND not already billed, per line. Before this it
--     billed the whole QC-approved quantity every time it ran, so a second click billed the same goods again,
--     and it fell back to the ORDERED quantity when nothing was approved, i.e. it could bill goods that had not
--     passed QC. Finished goods means QC-approved goods, so that fallback is gone.
-- (2) Each invoice records when it was dispatched, and when every ordered unit has been billed and every
--     invoice dispatched, the Work Order is completed.

alter table app.invoices add column if not exists dispatched_at timestamptz;
alter table app.invoices add column if not exists dispatched_by uuid references app.users(id);
create index if not exists invoices_undispatched_idx on app.invoices (work_order_id) where dispatched_at is null;

-- ---------------------------------------------------------------- create an invoice for what is ready to bill
create or replace function app.generate_invoice(p_work_order_id uuid, p_gst_rate numeric, p_supply_type app.supply_type)
returns uuid
language plpgsql security definer set search_path = app, pg_temp as $$
declare
  v_invoice_id uuid;
  v_number text;
  v_subtotal numeric := 0;
  v_line record;
  v_amount numeric;
  v_cgst numeric := 0; v_sgst numeric := 0; v_igst numeric := 0; v_total numeric;
  v_seq int;
  v_status app.wo_status;
  v_billable_lines int;
begin
  if not app.current_role_in('md', 'admin') then raise exception 'Only MD may generate an invoice.'; end if;

  select status into v_status from app.work_orders where id = p_work_order_id for update;   -- serialises two people billing at once
  if v_status is null then raise exception 'Work order % not found', p_work_order_id; end if;
  if v_status in ('draft', 'pending_finance_approval', 'cancelled') then
    raise exception 'Cannot generate an invoice before this Work Order is created and approved by Finance.';
  end if;

  -- What is ready to bill, per line: QC-approved minus already invoiced (only lines with something left).
  -- Counted first, so a refused request never takes an invoice number.
  select count(*) into v_billable_lines
  from app.work_order_lines l
  where coalesce((select sum(i.accepted_qty) from app.qc_inspections i where i.work_order_line_id = l.id), 0)
      - coalesce((select sum(il.qty) from app.invoice_lines il where il.work_order_line_id = l.id), 0) > 0
    and l.work_order_id = p_work_order_id;
  if v_billable_lines = 0 then
    raise exception 'Nothing is ready to bill: every QC-approved unit on this order has already been invoiced (or none has been approved yet).';
  end if;

  -- (the invoice number is taken only after the checks, so a refused request never burns a number)
  insert into app.wo_number_counters (fiscal_year_start, next_number) values (-1, 2)
  on conflict (fiscal_year_start) do update set next_number = app.wo_number_counters.next_number + 1
  returning next_number - 1 into v_seq;
  v_number := 'INV/' || app.fiscal_year_label(current_date) || '/' || lpad(v_seq::text, 4, '0');

  insert into app.invoices (work_order_id, invoice_number, gst_rate, supply_type, subtotal, grand_total)
  values (p_work_order_id, v_number, p_gst_rate, p_supply_type, 0, 0) returning id into v_invoice_id;

  for v_line in
    select l.id as work_order_line_id, l.description_snapshot as description, l.final_price as price,
           coalesce((select sum(i.accepted_qty) from app.qc_inspections i where i.work_order_line_id = l.id), 0)
             - coalesce((select sum(il.qty) from app.invoice_lines il where il.work_order_line_id = l.id), 0) as qty
    from app.work_order_lines l where l.work_order_id = p_work_order_id order by l.line_no
  loop
    continue when v_line.qty <= 0;
    v_amount := v_line.qty * v_line.price;
    v_subtotal := v_subtotal + v_amount;
    insert into app.invoice_lines (invoice_id, work_order_line_id, description, qty, price, amount)
    values (v_invoice_id, v_line.work_order_line_id, v_line.description, v_line.qty, v_line.price, v_amount);
  end loop;

  if p_supply_type = 'intra' then
    v_cgst := round(v_subtotal * p_gst_rate / 200, 2); v_sgst := v_cgst;
  else
    v_igst := round(v_subtotal * p_gst_rate / 100, 2);
  end if;
  v_total := v_subtotal + v_cgst + v_sgst + v_igst;

  update app.invoices set subtotal = v_subtotal, cgst = v_cgst, sgst = v_sgst, igst = v_igst,
                          grand_total = v_total, generated_by = auth.uid()
  where id = v_invoice_id;

  return v_invoice_id;
end $$;

-- ---------------------------------------------------------------- the goods have left
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
  select coalesce(bool_and(coalesce(b.q, 0) >= l.qty), false) into v_all_billed
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

revoke execute on function app.generate_invoice(uuid, numeric, app.supply_type) from public, anon;
grant execute on function app.generate_invoice(uuid, numeric, app.supply_type) to authenticated;
revoke execute on function app.mark_invoice_dispatched(uuid) from public, anon;
grant execute on function app.mark_invoice_dispatched(uuid) to authenticated;
grant execute on function app.generate_invoice(uuid, numeric, app.supply_type) to service_role;
grant execute on function app.mark_invoice_dispatched(uuid) to service_role;

-- Make the API pick up the new column and function straight away.
notify pgrst, 'reload schema';
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

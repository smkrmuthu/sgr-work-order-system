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

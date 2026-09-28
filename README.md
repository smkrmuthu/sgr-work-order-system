# SGR Work Order Management System

Production Phase-1 build of SGR Moulds India's Work Order lifecycle — Work
Order creation, MD edits/invoicing, Production Planner scheduling, and QC
inspection — as a separate, versioned system from the earlier
[`sgrApp`](https://github.com/smkrmuthu/sgrApp) UI prototype.

## Why a new repo

The prototype proved out the UX and business rules with `localStorage` +
a thin Supabase layer in the `public` schema. This repo is the real thing:
a properly modeled database with server-enforced authorization (Row-Level
Security, not just hidden buttons), atomic business rules as database
functions, full audit history, and a typed contract designed to be reused
by a future mobile app. It intentionally shares the same Supabase project
as the prototype (to avoid a second account/bill) but lives entirely in
its own `app` schema — the two systems cannot see or affect each other's
data.

## Architecture

```
sgr-work-order-system/
├── apps/web/            Next.js 16 (App Router) + TypeScript + Tailwind v4
│                        Static export (output: 'export') — no Node server
│                        to run or scale; calls Supabase directly from the
│                        browser, same trust model as the prototype.
├── packages/types/      @sgr/types — hand-authored TS types for every
│                        table + RPC payload. This is the "mobile
│                        scalability" story: a future React Native app
│                        imports this same package and talks to the same
│                        schema-qualified REST/RPC surface — no separate
│                        API to build or version for it.
├── db/migrations/       The database IS the API. Four idempotent SQL
│                        files, run once in order (see docs/SETUP.md):
│   001_schema.sql         tables, enums
│   002_rls.sql            Row-Level Security — the real authorization
│                           boundary, enforced by Postgres itself
│   003_functions.sql      WO numbering, draft/create, RBAC-by-column
│                           triggers, production/QC/invoice business
│                           logic, all as SECURITY DEFINER functions
│                           called through Supabase's auto REST API
│   004_seed.sql           starter categories/shifts/parts + sample
│                           vendors
├── db/tests/             A real embedded Postgres (PGlite) runs every
│                        migration and asserts RLS/RBAC/business-rule
│                        behaviour end to end — `npm run db:test`, CI-wired
├── supabase/functions/  The one server-only exception (see below):
│   manage-app-users/      create/edit/deactivate/delete a login — needs
│                           the service_role key, so it can't live in the
│                           browser. MD/Admin only.
├── docs/SETUP.md        Step-by-step: apply the migrations, expose the
│                        schema, deploy the function, wire up env vars,
│                        run the app
└── .github/workflows/   CI (typecheck/build/db:test) + deploy to GitHub
                         Pages on every push to main
```

### Why no hand-built API service

At Phase-1 scale (5 users, roughly 100 Work Orders/month) a separate
Express/NestJS API would add a service to deploy, scale, and keep in sync
with the schema for no real benefit — Supabase already generates a REST
API from the schema (PostgREST) and Postgres functions cover every
multi-step business rule (creating a WO with an atomic financial-year
number, recording production with an over-production guard, splitting QC
results into accepted/held, generating a GST invoice). The one thing that
genuinely can't run in the browser — creating a login, which needs the
service_role key — is a single Supabase Edge Function
(`supabase/functions/manage-app-users`), the same pattern the prototype
already uses for its own `manage-users` function (deliberately a
different name, so the two never collide on the shared Supabase project).

### Key design decisions

- **RLS is the authorization boundary, not the UI.** Every table denies
  by default; policies grant exactly what each role (`creator`, `planner`,
  `qc`, `finance`, `md`, `admin`) needs. The nav hides tabs a role can't
  use, but that's convenience — hitting a hidden URL directly still hits
  the same server-enforced policies.
- **Column-level RBAC via triggers.** RLS is row-level only, so
  `app.enforce_work_order_edit()` (a `BEFORE UPDATE` trigger) additionally
  checks *which columns* changed: a Production Planner may change only
  `expected_completion_date` — any other change is rejected outright
  (loudly, not silently discarded), an MD/admin edit after `created`
  auto-bumps `revision` and snapshots the pre-edit row into
  `work_order_revisions`.
- **No MD sign-off gate** (confirmed 28 Sep 2026): the MD never has to
  separately release a Work Order.
- **Finance approval gate** (added 28 Sep 2026): a created Work Order
  instead sits in `pending_finance_approval` — a new status between
  `draft` and `created` — until Finance reviews it. `app.approve_work_order()`
  releases it to the production floor (-> `created`, unlocking
  `app.record_production()`, which otherwise rejects it); `app.reject_work_order()`
  sends it back to the Creator as an editable `draft` with a required
  reason, keeping its original `wo_number` for resubmission. Every
  decision is appended to `app.finance_approvals` (read-only to clients,
  written only by those two `SECURITY DEFINER` functions).
- **QC held-quantity model:** inspections split into `accepted_qty` /
  `held_qty` rather than a binary pass/fail, since there's no formal
  reject/rework workflow yet — held quantity is never silently counted as
  accepted or dispatch-ready, and can be reopened back into the awaiting
  pool via `app.reopen_held()`.
- **Append-only history everywhere it matters:** `work_order_revisions`,
  `status_history`, `completion_date_changes`, `finance_approvals`,
  `audit_events` are insert-only (from triggers, or from the handful of
  `SECURITY DEFINER` RPCs); clients can read them but never write or
  delete them.
- **User management (added 28 Sep 2026):** MD and Admin can add, edit,
  deactivate or delete a login from the **Users** page, via the
  `manage-app-users` Edge Function (creating a login needs the
  service_role key). Deactivating someone (`is_active = false`) isn't
  cosmetic: `app.current_role()`/`app.current_role_in()` — the single
  choke point every RLS policy and RBAC check is built on — treat an
  inactive user as having no role at all, and a deactivated person can't
  even reactivate themself (only another active MD/Admin can). There must
  always be at least one active MD and one active Admin; nobody can
  delete their own login.

## Live app

**https://smkrmuthu.github.io/sgr-work-order-system/** — deployed
automatically by [.github/workflows/deploy.yml](.github/workflows/deploy.yml)
on every push to `main` (build → `db:test` → static export → GitHub
Pages). It won't do anything useful until the database steps below have
been run at least once against the live Supabase project.

## Getting started

See [docs/SETUP.md](docs/SETUP.md) for applying the database migrations
and running the app locally. Once the DB is set up:

```bash
npm install
npm run dev       # http://localhost:3000
npm run typecheck
npm run build     # static export to apps/web/out/
```

## Status

Database layer (schema, RLS, business-logic functions) is written and
verified with an embedded-Postgres test suite (48 assertions covering
every role's permissions, WO numbering under concurrency, the
over-production guard, QC accept/hold/reopen, and both intra- and
inter-state GST invoice math). The frontend is scaffolded end-to-end
(login, Work Orders list/create/detail, Production Planner, QC) and
builds/renders cleanly. **Not yet done:** the migrations haven't been run
against the live Supabase project — that's the first step in
`docs/SETUP.md` — so nothing has been exercised against real data yet.

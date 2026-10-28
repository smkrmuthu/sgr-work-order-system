# Project notes — read this first in a new session

A hand-off for anyone (a person, or a Claude session on another computer) picking this project up. It says what the
system is, how it is deployed, the rules that were agreed with the owner, and what is still open. The README covers
the architecture; `docs/SETUP.md` lists every migration in order. Last updated: 28 Oct 2026 (migrations 001–027).

**Never put passwords, API keys or the Supabase `service_role` key in this repo or in chat.** The service key lives
only in the GitHub Actions secret `SUPABASE_SERVICE_ROLE_KEY` (used by the nightly backup) and the Edge Function's
environment. Test logins are created by the owner and must not be used or shared by an assistant.

## 1. What it is, and where it lives

SGR Moulds India's Work Order Management System: an order goes from creation, through Finance approval, production,
QC, billing and dispatch.

| Thing | Where |
|---|---|
| Live app | https://sgr.oneuptech.co (Cloudflare, project `sgr-work`) |
| Code | github.com/smkrmuthu/sgr-work-order-system, branch `main` |
| Database / auth / files | Supabase project `zuvmolgdmhbgqonzpjcg`, schema `app` |
| Users function | Supabase Edge Function `manage-app-users` (Verify JWT must stay **off**; its CORS list includes the live domain) |
| Old copy | GitHub Pages still builds from the same code, but the Cloudflare domain is the real one |
| Earlier prototype | a separate repo, `sgrApp` (public schema, localStorage). Not part of this system |

Stack: Next.js 16 static export (`output: 'export'`, no server), Tailwind v4, Supabase (Postgres + RLS + Storage +
Edge Function). The browser talks to Supabase directly. `packages/types/database.ts` is hand-maintained and must be
updated whenever a table or function payload changes.

## 2. Working on it

```bash
npm install
npm run dev          # local site
npm run typecheck
npm run build        # must pass before pushing
npm run db:test      # runs EVERY migration against an embedded Postgres (PGlite) and checks the rules (260+ checks)
npm run db:combine   # regenerates db/all_migrations_combined.sql after adding a migration
```

**The owner also commits straight to GitHub** (Vendor Master, Sales Persons and others). Always `git pull` first.

### Migrations
- Files `db/migrations/NNN_name.sql`, numbered, **never edit an old one**: add a new file.
- They are **not applied automatically**. After pushing, the owner runs the new file in the Supabase SQL Editor.
  Say so clearly every time; the new screen fails until it is run.
- When a function changes, the new migration restates the **whole latest body** of the function (copy from the last
  file that defined it) and keeps every earlier safeguard. Check `grep -n "create or replace function app.<name>"`.
- Add the new file to the `MIGRATIONS` list in `db/tests/run.mjs`, add tests for the rule, and a line to `docs/SETUP.md`.
- Run `npm run db:combine` and commit `db/all_migrations_combined.sql` (all migrations in one paste-able script for a fresh
  database). It is generated, never hand-edited, and `npm run db:test` fails if it is out of date.
- New tables: enable RLS (a test fails if any app table lacks it), give `authenticated` only what it needs, and add the
  table to the allow-list in `app.export_table` plus `apps/web/lib/backup.ts` and `scripts/db-backup.mjs`.
- Hiding a button is not access control. Anything sensitive is enforced in the database (RLS, or a `security definer`
  function that checks the role itself).

### Deploy
- Push to `main`. Cloudflare "Workers Builds" builds `npm run build` and serves `apps/web/out` (`wrangler.toml`).
- It **occasionally misses a push**. If the live site has not changed after ~10 minutes, push an empty commit.
- GitHub Actions: `ci.yml` (checks), `deploy.yml` (GitHub Pages), `db-backup.yml` (nightly backup).
- Routes use query strings (`/work-orders/detail?id=…`), not path segments, because the site is a static export.

## 3. Roles

`creator` (Work Order Master Creator), `md` (Managing Director), `finance`, `planner` (Production Planner), `qc`,
`admin`. A deactivated user has no role at all.

| Role | Tabs | Landing page |
|---|---|---|
| MD, Admin | everything | Dashboard |
| Creator | Work Orders, Item Master, Vendor Master | Work Orders |
| Finance | Work Orders, Finance Approval, Rejections, Finished Goods, Dispatch | Work Orders |
| Planner | Dashboard, Production Planner, Finished Goods, Dispatch | Dashboard |
| QC | QC, Rejections (view), Finished Goods, Dispatch | QC |

Planner and QC do **not** get the Work Orders tab and only ever see approved orders.

## 4. Business rules that were agreed (do not change without asking)

**Order lifecycle:** Draft → Pending Finance Approval → Created → In Production → QC Pending → Partially QC Approved →
Ready for Dispatch → Completed (or Cancelled). Status changes only through app functions, never by editing the row.
- The Creator edits their own order until Finance approves it. After that only the MD edits, and each MD edit opens a
  numbered **revision** (old values kept, with a summary of what changed).
- Delivery Date is compulsory to create an order (form and database).
- Order header also carries Sales Person, GSM (optional: Inner and Outer figures, both required if ticked),
  Category (optional; also narrows the Part # list on the form), and one or more **Sales Order files** (PDF/JPG).
- "Inspection Report Required" and "Pallet Height" were removed from the form (columns kept for old data).

**Customer Price** is per order line, entered by the Creator. Only Creator, MD, Admin and Finance may see it, enforced in
the database (own table `work_order_line_prices`). Revision summaries deliberately say "customer price changed"
without figures. Sales Order files follow the same four-role rule.

**Planned Completion Date** (Planner sets it): the first date needs no reason; every later change needs a reason.
All changes are logged (old, new, reason, who, when) and shown on the Planner page and the order page.

**Production entry (one shift):** needs a Supervisor (from the Supervisors master, Item Master tab), shift, labour count,
and for each line a quantity and the **weight of one unit in grams**. The database calculates the total weight. A unit
may weigh at most *max%* above the part's standard weight (default 15%) and, if set, at most *min%* below it; the limits
are per item in the Item Master, only MD/Admin can change them, and every change is audited. Shift notes are separate
points, kept permanently.

**QC rejection:** when QC accepts fewer units than are awaiting, a reason is required (managed list, Item Master tab).
Rejected units wait in the Rejections queue. **Finance or the MD** (either one) decides, per quantity, with a note:
- **Scrap:** units written off, never billed, the order needs that many fewer to complete.
- **Re-produce:** units written off AND a replacement line is added to the same order (own price, default the
  original's, optional new order delivery date). Every decision opens an order revision.
- The Planner can reject over-weight units at production instead of being blocked; they go to the same queue.
- QC can withdraw a rejection only until someone has decided on it. Decisions are permanent.

**Delivery Challan (replaced the invoice, migration 028):** Finished Goods creates a numbered, price-free Delivery Challan
(MD/Admin only) for QC-accepted units not yet on a document; it then waits in Ready for Dispatch. Rejected or scrapped
units are never on a challan. An order completes when everything still required is on a dispatched challan. Tax
invoices are raised outside the app; old invoices stay viewable by price roles. Challans live in the `invoices` tables
(`kind = 'challan'`) and still record the goods' value for the MD's dashboard, but never display it.

**Prices on screen:** Production (Planner) and QC logins see no price anywhere (order page columns, Finished Goods,
Dispatch, Rejections). This is a display rule (`apps/web/lib/priceAccess.ts`); only Customer Price is withheld by the
database. Making all prices database-level is possible but needs prices moved out of the order-line table.

## 5. Gotchas learned the hard way
- Supabase fires the sign-in event again when a browser tab regains focus. `apps/web/lib/auth.tsx` must not treat a
  repeat event for the same user as a new sign-in (it once wiped the open page). Keep that behaviour.
- Pages start fresh when you navigate away and back (no remembered selection yet, see open items).
- PostgREST caps a query at 1000 rows; a few pages read everything (dashboard, backup uses paging).
- The Edge Function checks the caller's role itself; its CORS origin list must include any new domain.
- PostgREST embedded selects (e.g. `qc_rejections` → `decisions:qc_rejection_decisions(...)`) are only exercised in a
  real browser; the PGlite tests do not run PostgREST, so check new embeds on the live site.

## 6. Open items
- QC and Production Planner could remember the last selected order when you come back (offered, not decided).
- MD cannot yet add a sales order file from the order detail page (only the Creator on the form).
- Sales order files themselves are not in the Backup page (only their records), same as QC files.
- Planner cannot add Supervisors (Item Master is Creator/MD/Admin only).
- Planner and QC are limited to approved orders in the app only; the database still lets them read unapproved ones
  through the API (not sensitive). A database rule could enforce it.
- Dashboard reads are subject to the 1000-row cap. QC photo capture and note icons are not built.
- Order with every unit scrapped and none replaced stays open until the MD cancels it (not automated).
- To verify by sign-in: a Planner/QC login must show no Customer Price columns; Creator/MD must still see theirs.

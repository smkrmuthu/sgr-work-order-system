# Setup

This app reuses the **same Supabase project** as the SGR prototype
(`sgrApp`), but lives in its own Postgres schema (`app`) so the two are
fully isolated — different tables, different RLS policies, different REST
endpoints. Nothing you do here can affect the prototype's `public` schema.

Project: `https://zuvmolgdmhbgqonzpjcg.supabase.co`

## 1. Run the migrations

Open the Supabase dashboard → **SQL Editor** → New query, and run these thirteen
files **in order**, pasting each one's full contents and clicking Run:

1. `db/migrations/001_schema.sql` — schema, enums, tables
2. `db/migrations/002_rls.sql` — Row-Level Security policies (the real
   authorization boundary — every table is locked down by role)
3. `db/migrations/003_functions.sql` — WO numbering, save/create draft,
   RBAC-enforcing triggers, production/QC/invoice RPCs
4. `db/migrations/004_seed.sql` — starter categories, shifts, parts, and
   3 sample vendors so the app isn't empty on first login
5. `db/migrations/005_grants.sql` — lets the signed-in API role reach the
   `app` schema (without it: "permission denied for schema app") and locks
   internal functions such as `next_wo_number` away from direct calls
6. `db/migrations/006_notes_and_customer_ref.sql` — a Customer Reference on
   each Work Order line, and Additional Notes stored as separate points
   (one row each, with room for an icon later)
7. `db/migrations/007_creator_edit_before_approval.sql` — the Creator can edit
   their own Work Order until Finance approves it, **and a security fix**:
   row-level security was never switched on for the line-items table, so
   any signed-in user could change any order's quantities and prices
8. `db/migrations/008_service_role_grants.sql` — lets the Users function (which
   runs with Supabase's admin key) read the `app` schema; without it the Users
   page says "Only MD or Admin can manage users" even to the MD
9. `db/migrations/009_qc_files.sql` — file uploads on QC inspections: creates the
   private `qc-attachments` storage bucket (10 MB per file; images, PDF, Excel,
   Word, CSV, text) and who may add/read files
10. `db/migrations/010_billing_and_dispatch.sql` — the Finished Goods and Ready for
    Dispatch tabs: invoices bill only QC-approved goods not yet billed (no
    double-billing), and an invoice can be marked dispatched. Adds one new
    function, `mark_invoice_dispatched` — if your Data API has per-function
    toggles, switch it on (Integrations → Data API → Exposed functions)
11. `db/migrations/011_md_approve_and_revisions.sql` — the MD can approve/reject like
    Finance (the database previously refused it), and every MD edit of a released
    order is exactly one revision (a quantity-only change used to open none). Adds
    `update_work_order` — switch it on under Exposed functions too
12. `db/migrations/012_review_fixes.sql` — fixes from the first code review:
    row-level locking so two people can no longer double-record the same QC
    acceptance/production/QC-submission at once; a way to actually cancel a
    Work Order (`cancelled` had become unreachable by anyone, even MD);
    quantities must be above zero to create a Work Order; the GST rate is
    now bounds-checked; and MD/Admin's `save_draft` header write now applies
    to any Creator's draft, not just their own
13. `db/migrations/013_backup_export_rpc.sql` — **security fix**: the Backup
    page (Database Backup & Rebuild) had no real access control, only a
    hidden nav link — since RLS deliberately keeps most tables broadly
    readable for everyday multi-role use, any signed-in login could reach
    it directly and download the full database. All 25 of its table reads
    now go through `app.export_table`, which checks MD/Admin itself and
    can't be bypassed the way a hidden link can. Switch this new function
    on under Exposed functions too
14. `db/migrations/014_sales_persons.sql`, `015_work_order_sales_person.sql`,
    `016_update_work_order_sales_person.sql` — Sales Person master and the
    Sales Person on each Work Order
15. `db/migrations/017_line_customer_price.sql` — Customer Price per line
16. `db/migrations/018_customer_price_restricted.sql` — **security fix**:
    Customer Price moves to its own table
    (`work_order_line_prices`) that only Creator, MD, Admin and Finance can
    read, so Planner/QC can't get it through the API. It also removes the
    price from revision history (existing entries are scrubbed; a price
    change is now logged as "customer price changed" without figures)
17. `db/migrations/019_gsm_requirement.sql` — GSM Required (with Inner and
    Outer figures) on the Work Order; Inspection Report Required and Pallet
    Height are retired from the form (old values stay in the database)
18. `db/migrations/020_supervisors_and_completion_reason.sql` — Supervisors
    master (Item Master → Supervisors) and a required Supervisor on every
    production entry; every change to the Planned Completion Date is logged
    with a required reason (enforced in the database). Add at least one
    supervisor before the Planner records production
19. `db/migrations/021_sales_order_file_and_delivery_date.sql` — Sales Order
    file upload (PDF/JPG, private `sales-order-files` bucket, visible only to
    Creator/MD/Admin/Finance) and Delivery Date required on every created order

All of them are safe to re-run (`create table if not exists`, `drop policy if
exists` + recreate, etc.) if you need to reapply one after a fix.

## 2. Expose the `app` schema to the API

By default PostgREST (Supabase's auto-REST-API) only serves `public`.
Go to **Integrations → Data API → Settings** and do all three of these,
then Save (without them, requests from the web app 404 or return nothing):

1. **Exposed schemas** — add `app`.
2. **Exposed tables** — turn on **every** table under `app` (all of them;
   exposing the schema alone does not expose its tables).
3. **Exposed functions** — turn on the `app` functions (the dashboard
   toggles are only the outer layer). What a signed-in user may actually
   *execute* is set precisely by `005_grants.sql`: the 9 functions the web
   app calls, plus `current_role`, `current_role_in` and
   `recompute_work_order_status`. Internal ones such as `next_wo_number` and
   the trigger functions stay locked even if their toggle is on.

## 3. Create logins for the 6 roles

**One-time only** (once step 3b below is deployed, do this from the app's
**Users** page instead — see there).

The prototype already has `md@sgr.com`, `prod@sgr.com`, `qa@sgr.com` as
Supabase Auth users — but this app's `app.users` table is separate from the
prototype's user table, and a new-user trigger only fires for **brand-new**
sign-ups. For accounts that already exist in Supabase Auth, insert their
`app.users` row by hand once, e.g. in the SQL Editor:

```sql
insert into app.users (id, email, full_name, role)
select id, email, email, 'md'
from auth.users where email = 'md@sgr.com'
on conflict (id) do update set role = excluded.role;
```

Repeat per person with the right `role` (`creator`, `planner`, `qc`,
`finance`, `md`, `admin`). Give at least one person `md` or `admin` — they
run step 3b below and everyone else from then on. For anyone brand new —
including a new **Finance** login, e.g. `finance@sgr.com` — just have them
sign up in the app and then run one
`update app.users set role = 'finance' where email = '...'` to assign their
role (new sign-ups default to `creator`).

## 3b. Deploy the Users function

The **Users** page (MD/Admin only — add logins, change roles, deactivate or
delete someone) needs one Edge Function, because creating a login requires
Supabase's admin key, which must never be placed in a website.

1. Dashboard → **Edge Functions** → **Deploy a new function** → **Via
   Editor**.
2. Name it exactly `manage-app-users` (not `manage-users` — that name is
   already used by the prototype's own function on this same project;
   using a different name keeps the two completely separate).
3. Replace the sample code with the full contents of
   [`supabase/functions/manage-app-users/index.ts`](../supabase/functions/manage-app-users/index.ts),
   then click **Deploy function** (takes 10–30 seconds). You don't enter
   any keys — Supabase supplies the admin key to the function itself.

**Updating it later:** Edge Functions → `manage-app-users` → open the code,
paste the new version, Deploy.

**Note on "Verify JWT":** Supabase's built-in login check only understands
its older signing keys and rejects logins on newer projects
(`UNAUTHORIZED_LEGACY_JWT` / "Invalid JWT") before the function's own code
even runs. The app works around this by sending the public key in the
normal header and the person's login separately (`x-user-token`), verified
inside the function itself — you don't need to change any Verify JWT
setting.

Once deployed, sign in as an MD or Admin: a **Users** tab appears next to
Work Orders. Rules built in: nobody can delete their own login, and there
must always be at least one active MD and one active Admin.

## 4. Point the web app at the project

`apps/web/.env.local` (git-ignored, already filled in in this checkout)
needs:

```
NEXT_PUBLIC_SUPABASE_URL=https://zuvmolgdmhbgqonzpjcg.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_ClscppU0a-LutkRhS13oWw_6IWqkGjk
```

Both values are safe to ship in the browser bundle — RLS is what actually
protects the data, not secrecy of these values.

## 4b. Turn on the automated database backup

`.github/workflows/db-backup.yml` runs every 2 days and uploads a full
`.sql`/`.json` backup as a workflow artifact (Actions tab → the run →
Artifacts, kept 90 days). It needs one secret that is **not** safe to ship
anywhere, unlike the values above:

1. Supabase dashboard → **Project Settings → API Keys** → copy the
   **`service_role`** **secret** key (not the publishable/anon one above —
   this one bypasses Row-Level Security entirely, which is exactly why the
   backup job needs it and why the app itself never uses it).
2. GitHub → this repo → **Settings → Secrets and variables → Actions →
   New repository secret**. Name it exactly `SUPABASE_SERVICE_ROLE_KEY` and
   paste the key as the value.

Never put this key in a workflow file, in `.env.local`, or anywhere in
`apps/web` — it's server-side-only, the same rule the `manage-app-users`
Edge Function already follows. Without this secret the backup workflow
now **fails loudly** (a red ✗ in the Actions tab) rather than silently
uploading an empty backup, which is what it did before this was fixed —
so a failed run here means the secret is missing or wrong, not that
nothing is being backed up.

You can trigger a run immediately instead of waiting 2 days: **Actions →
Automated Database Backup (Every 2 Days) → Run workflow**.

## 5. Run it

```bash
npm install
npm run dev
```

Open http://localhost:3000, sign in, and you should land on **Work
Orders**. What you see in the nav depends on your role (Work Orders: all
roles · Finance Approval: finance/md/admin · Production Planner:
planner/md/admin · QC: qc/md/admin · Users: md/admin) — that's a
convenience, not the security boundary; RLS enforces the same rules
server-side even if someone hits a hidden URL directly.

A newly-created Work Order now sits in **Pending Finance Approval** —
production can't start until Finance approves it (or it's rejected back to
the Creator as a draft to fix and resubmit) — see `README.md` for the
full lifecycle.

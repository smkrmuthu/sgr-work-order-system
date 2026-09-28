# Setup

This app reuses the **same Supabase project** as the SGR prototype
(`sgrApp`), but lives in its own Postgres schema (`app`) so the two are
fully isolated — different tables, different RLS policies, different REST
endpoints. Nothing you do here can affect the prototype's `public` schema.

Project: `https://zuvmolgdmhbgqonzpjcg.supabase.co`

## 1. Run the migrations

Open the Supabase dashboard → **SQL Editor** → New query, and run these five
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

All five are safe to re-run (`create table if not exists`, `drop policy if
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

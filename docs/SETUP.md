# Setup

This app reuses the **same Supabase project** as the SGR prototype
(`sgrApp`), but lives in its own Postgres schema (`app`) so the two are
fully isolated — different tables, different RLS policies, different REST
endpoints. Nothing you do here can affect the prototype's `public` schema.

Project: `https://zuvmolgdmhbgqonzpjcg.supabase.co`

## 1. Run the migrations

Open the Supabase dashboard → **SQL Editor** → New query, and run these four
files **in order**, pasting each one's full contents and clicking Run:

1. `db/migrations/001_schema.sql` — schema, enums, tables
2. `db/migrations/002_rls.sql` — Row-Level Security policies (the real
   authorization boundary — every table is locked down by role)
3. `db/migrations/003_functions.sql` — WO numbering, save/create draft,
   RBAC-enforcing triggers, production/QC/invoice RPCs
4. `db/migrations/004_seed.sql` — starter categories, shifts, parts, and
   3 sample vendors so the app isn't empty on first login

All four are safe to re-run (`create table if not exists`, `drop policy if
exists` + recreate, etc.) if you need to reapply one after a fix.

## 2. Expose the `app` schema to the API

By default PostgREST (Supabase's auto-REST-API) only serves `public`.
Go to **Project Settings → Data API → Exposed schemas** and add `app` to
the list, then save. Without this step every request from the web app will
404.

## 3. Create logins for the 5 roles

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

Repeat per person with the right `role` (`creator`, `planner`, `qc`, `md`,
`admin`). For anyone brand new, just have them sign up in the app and then
run one `update app.users set role = '...' where email = '...'` to assign
their role (new sign-ups default to `creator`).

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
roles · Production Planner: planner/md/admin · QC: qc/md/admin) — that's a
convenience, not the security boundary; RLS enforces the same rules
server-side even if someone hits a hidden URL directly.

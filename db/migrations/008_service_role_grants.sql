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

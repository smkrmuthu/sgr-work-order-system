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

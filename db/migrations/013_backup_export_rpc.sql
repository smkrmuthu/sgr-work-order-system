-- 013: close the Backup page's real access-control gap.
--
-- The page's "MD/Admin Only" label was cosmetic — it only hid the nav link. The actual data came from
-- 25 plain `supabase.from(table).select('*')` calls, and RLS deliberately keeps most of these tables
-- readable by every signed-in role (Planner, QC, Finance, Creator all need to read work_orders,
-- business_partners, invoices, etc. for their own screens) — so any authenticated login could already
-- read almost everything piecemeal, and the Backup page just turned that into one convenient full-database
-- download with no role check of its own anywhere.
--
-- Fix: route every table the Backup page reads through this one SECURITY DEFINER function instead of a
-- direct table select. It re-checks md/admin itself (so it can't be bypassed by calling the same network
-- request directly, the way a hidden nav link can), and validates the table name against an explicit
-- allow-list before using it in `format('%I', ...)`, so it's never handed an unvalidated identifier even
-- though the allow-list check alone already rules out anything unexpected.
create or replace function app.export_table(p_table text) returns jsonb
language plpgsql security definer set search_path = app, pg_temp as $$
declare v_rows jsonb;
begin
  if not app.current_role_in('md', 'admin') then
    raise exception 'Only MD or Admin may export data.';
  end if;
  if p_table not in (
    'users', 'categories', 'shifts', 'parts', 'business_partners', 'partner_addresses', 'partner_contacts',
    'delivery_locations', 'wo_number_counters', 'work_orders', 'work_order_lines', 'work_order_notes',
    'work_order_revisions', 'status_history', 'completion_date_changes', 'finance_approvals',
    'production_entries', 'production_output_lines', 'qc_submissions', 'qc_inspections', 'attachments',
    'invoices', 'invoice_lines', 'notifications', 'audit_events'
  ) then
    raise exception 'Unknown table: %', p_table;
  end if;

  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from app.%I t', p_table) into v_rows;
  return v_rows;
end $$;

revoke execute on function app.export_table(text) from public, anon;
grant execute on function app.export_table(text) to authenticated;

notify pgrst, 'reload schema';

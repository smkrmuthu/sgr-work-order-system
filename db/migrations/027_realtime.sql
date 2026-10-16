-- 027: live updates. Adds the tables the screens show to Supabase's Realtime publication, so a change made by
-- one user reaches everyone else's open screen without a page refresh (apps/web/lib/useLiveRefresh.ts).
-- Realtime respects Row-Level Security: each person only receives changes to rows they are allowed to read.
-- Safe to run more than once. Without this the app still refreshes itself every 30 seconds.
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach t in array array[
    'work_orders', 'work_order_lines', 'work_order_line_prices', 'work_order_notes', 'finance_approvals',
    'status_history', 'completion_date_changes', 'production_entries', 'production_output_lines',
    'production_entry_notes', 'qc_submissions', 'qc_inspections', 'qc_rejections', 'qc_rejection_decisions',
    'invoices', 'invoice_lines', 'business_partners', 'parts'
  ] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'app' and tablename = t) then
      execute format('alter publication supabase_realtime add table app.%I', t);
    end if;
  end loop;
end $$;

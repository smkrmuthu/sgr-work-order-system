-- Row-Level Security: this is where "hiding a button isn't access control" (v1.3 §9) is actually
-- enforced. Every table below denies everything by default; a policy re-opens exactly what a role
-- needs. Fine-grained business rules that RLS can't express cleanly (e.g. "Planner may change only
-- the Expected Completion Date") are enforced by triggers in 003_functions.sql, not by the client.

-- ---------------------------------------------------------------- helpers
-- is_active = false is treated as "no role" everywhere: a deactivated login (Users page, added
-- 28 Sep 2026) keeps signing in successfully (Supabase Auth doesn't know about app.users), but every
-- RLS policy and RBAC check below is built on these two functions, so it reads/writes nothing.
create or replace function app.current_role() returns app.user_role
language sql stable security definer set search_path = app, pg_temp as $$
  select role from app.users where id = auth.uid() and is_active
$$;

create or replace function app.current_role_in(variadic roles app.user_role[]) returns boolean
language sql stable security definer set search_path = app, pg_temp as $$
  select coalesce((select role = any(roles) from app.users where id = auth.uid() and is_active), false)
$$;

-- ---------------------------------------------------------------- users
alter table app.users enable row level security;

drop policy if exists users_select on app.users;
create policy users_select on app.users for select to authenticated using (true);   -- names shown across the app

-- UPDATED 28 Sep 2026: MD may manage users too, not just Admin (matches the prototype's MD-manages-
-- users behaviour) — the actual safety rails (can't remove the last MD/Admin, can't self-delete) live
-- in the manage-app-users Edge Function, which is also the only way to CREATE a login (needs the
-- service_role key). This policy only covers editing an existing app.users row (role, is_active, name).
drop policy if exists users_update_admin on app.users;
drop policy if exists users_update_md_admin on app.users;
create policy users_update_md_admin on app.users for update to authenticated
  using (app.current_role_in('md', 'admin')) with check (app.current_role_in('md', 'admin'));

-- A user may rename themself, nothing else: role and is_active must come out unchanged, so nobody
-- can promote or reactivate themself through this policy (that's users_update_md_admin's job, above).
drop policy if exists users_update_own_name on app.users;
create policy users_update_own_name on app.users for update to authenticated
  using (id = auth.uid())
  with check (
    id = auth.uid()
    and role = (select role from app.users where id = auth.uid())
    and is_active = (select is_active from app.users where id = auth.uid())
  );

-- Every new login gets a profile row automatically (role defaults to 'creator'; admin promotes it).
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = app, pg_temp as $$
begin
  insert into app.users (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- ---------------------------------------------------------------- master data
-- Read: everyone signed in. Write: Creator, MD or Admin (confirmed: "both Master Creator and MD can
-- have control", no separate master-data approval step, BusinessQuestions.docx).
do $$
declare t text;
begin
  foreach t in array array['categories', 'shifts', 'parts', 'business_partners', 'partner_contacts',
                            'partner_addresses', 'delivery_locations'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('drop policy if exists %1$I_select on app.%1$I', t);
    execute format('create policy %1$I_select on app.%1$I for select to authenticated using (true)', t);
    execute format('drop policy if exists %1$I_write on app.%1$I', t);
    execute format(
      'create policy %1$I_write on app.%1$I for all to authenticated
         using (app.current_role_in(''creator'', ''md'', ''admin''))
         with check (app.current_role_in(''creator'', ''md'', ''admin''))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- work orders
alter table app.work_orders enable row level security;

drop policy if exists work_orders_select on app.work_orders;
create policy work_orders_select on app.work_orders for select to authenticated using (true);

drop policy if exists work_orders_insert on app.work_orders;
create policy work_orders_insert on app.work_orders for insert to authenticated
  with check (app.current_role_in('creator', 'md'));

-- Coarse "who may touch this row at all"; 003_functions.sql's trigger enforces exactly which
-- columns each role may change (e.g. Planner: only expected_completion_date).
drop policy if exists work_orders_update on app.work_orders;
create policy work_orders_update on app.work_orders for update to authenticated
  using (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and status = 'draft' and created_by = auth.uid())
    or app.current_role_in('planner')
  )
  with check (true);   -- the BEFORE UPDATE trigger raises an exception for a disallowed column change

-- No delete policy anywhere on work_orders: deactivate/cancel via status, never hard-delete (§8 principle).

drop policy if exists work_order_lines_select on app.work_order_lines;
create policy work_order_lines_select on app.work_order_lines for select to authenticated using (true);

drop policy if exists work_order_lines_write on app.work_order_lines;
create policy work_order_lines_write on app.work_order_lines for all to authenticated
  using (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and exists (
          select 1 from app.work_orders w
          where w.id = work_order_lines.work_order_id and w.status = 'draft' and w.created_by = auth.uid()))
  )
  with check (
    app.current_role_in('md', 'admin')
    or (app.current_role_in('creator') and exists (
          select 1 from app.work_orders w
          where w.id = work_order_lines.work_order_id and w.status = 'draft' and w.created_by = auth.uid()))
  );

-- History / audit tables: read for everyone signed in, no direct client write. Only the
-- SECURITY DEFINER trigger functions in 003_functions.sql (running with elevated rights) insert here.
do $$
declare t text;
begin
  foreach t in array array['work_order_revisions', 'status_history', 'completion_date_changes',
                            'finance_approvals', 'audit_events'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('drop policy if exists %1$I_select on app.%1$I', t);
    execute format('create policy %1$I_select on app.%1$I for select to authenticated using (true)', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- production (§4)
alter table app.production_entries enable row level security;
drop policy if exists production_entries_select on app.production_entries;
create policy production_entries_select on app.production_entries for select to authenticated using (true);
drop policy if exists production_entries_write on app.production_entries;
create policy production_entries_write on app.production_entries for insert to authenticated
  with check (app.current_role_in('planner', 'md', 'admin'));

alter table app.production_output_lines enable row level security;
drop policy if exists production_output_lines_select on app.production_output_lines;
create policy production_output_lines_select on app.production_output_lines for select to authenticated using (true);
drop policy if exists production_output_lines_write on app.production_output_lines;
create policy production_output_lines_write on app.production_output_lines for insert to authenticated
  with check (app.current_role_in('planner', 'md', 'admin'));

alter table app.qc_submissions enable row level security;
drop policy if exists qc_submissions_select on app.qc_submissions;
create policy qc_submissions_select on app.qc_submissions for select to authenticated using (true);
drop policy if exists qc_submissions_write on app.qc_submissions;
create policy qc_submissions_write on app.qc_submissions for insert to authenticated
  with check (app.current_role_in('planner', 'md', 'admin'));

-- ---------------------------------------------------------------- QC (§5)
alter table app.qc_inspections enable row level security;
drop policy if exists qc_inspections_select on app.qc_inspections;
create policy qc_inspections_select on app.qc_inspections for select to authenticated using (true);
drop policy if exists qc_inspections_write on app.qc_inspections;
create policy qc_inspections_write on app.qc_inspections for insert to authenticated
  with check (app.current_role_in('qc', 'md', 'admin'));

alter table app.attachments enable row level security;
drop policy if exists attachments_select on app.attachments;
create policy attachments_select on app.attachments for select to authenticated using (true);
drop policy if exists attachments_write on app.attachments;
create policy attachments_write on app.attachments for insert to authenticated
  with check (app.current_role_in('creator', 'md', 'planner', 'qc', 'admin'));

-- ---------------------------------------------------------------- invoicing (§6)
-- No client insert policy: rows are written only by app.generate_invoice() (003_functions.sql),
-- so a generated invoice always uses the server-computed final-price snapshot.
alter table app.invoices enable row level security;
drop policy if exists invoices_select on app.invoices;
create policy invoices_select on app.invoices for select to authenticated using (true);

alter table app.invoice_lines enable row level security;
drop policy if exists invoice_lines_select on app.invoice_lines;
create policy invoice_lines_select on app.invoice_lines for select to authenticated using (true);

-- ---------------------------------------------------------------- notifications (§9)
-- No client insert policy: only the status-change trigger (SECURITY DEFINER) creates notifications,
-- so a user can never forge one. A user may only mark their own as read.
alter table app.notifications enable row level security;
drop policy if exists notifications_select on app.notifications;
create policy notifications_select on app.notifications for select to authenticated
  using (user_id = auth.uid() or user_id is null);
drop policy if exists notifications_update on app.notifications;
create policy notifications_update on app.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 014: Sales Persons master (Item Master > Sales Persons tab).
-- Name, Phone and the company Location they belong to. Further fields can be added later as columns.
-- Same access model as the other master data: everyone signed in may read; Creator/MD/Admin may write.
create table if not exists app.sales_persons (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  phone      text,
  location   text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

alter table app.sales_persons enable row level security;
drop policy if exists sales_persons_select on app.sales_persons;
create policy sales_persons_select on app.sales_persons for select to authenticated using (true);
drop policy if exists sales_persons_write on app.sales_persons;
create policy sales_persons_write on app.sales_persons for all to authenticated
  using (app.current_role_in('creator', 'md', 'admin'))
  with check (app.current_role_in('creator', 'md', 'admin'));

revoke all on app.sales_persons from anon;
grant select, insert, update, delete on app.sales_persons to authenticated;
grant all on app.sales_persons to service_role;

notify pgrst, 'reload schema';

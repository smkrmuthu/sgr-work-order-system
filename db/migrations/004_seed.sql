-- Reference/master data from docs/architecture v1.3 Appendices A-D (SGR Master.xlsx + the earlier
-- prototype screenshot). Safe to re-run. Business/transactional data (work orders, production, QC,
-- invoices) is deliberately NOT seeded here — that starts empty in every environment.

insert into app.categories (code, name, description) values
  ('CAT-001', 'Edge Board', 'Paper-based protective edge and corner boards.'),
  ('CAT-002', 'Carton box', 'Corrugated cartons for packing and shipment.'),
  ('CAT-003', 'Paper Slitting E-CORE', 'Paper cores produced for slitting operations.'),
  ('CAT-004', 'Pyro', 'Pyro')                       -- transcribed as-is from SGR Master.xlsx; reads as a placeholder
on conflict (code) do update set name = excluded.name, description = excluded.description;

insert into app.shifts (code, name, start_time, end_time) values
  ('1', 'Morning',  '06:00', '14:00'),
  ('2', 'Evening',  '14:00', '22:00'),
  ('3', 'Night',    '22:00', '06:00'),               -- overnight: end_time < start_time, by design
  ('4', 'General',  '08:00', '18:00')
on conflict (code) do update set name = excluded.name, start_time = excluded.start_time, end_time = excluded.end_time;

-- Parts: rows 1-5 from the prototype screenshot, rows 6-7 from SGR Master.xlsx's "Item master" sheet.
-- CONFLICT FLAGGED IN docs/architecture v1.3, APPENDIX B: two numbering conventions (EB0806xxxxx vs
-- EB1005xxxxx) — both seeded so nothing is silently dropped; resolve with business before go-live.
-- Row 7 (EB1005000120)'s category is "Pyro" in the source despite its "EB" part-number prefix.
with c as (select id, name from app.categories)
insert into app.parts (part_no, description, uom, standard_weight_kg, category_id, price, remarks, customer_ref)
select v.part_no, v.description, v.uom, v.weight, c.id, v.price, v.remarks, v.customer_ref
from (values
  ('EB080600002', 'EB 80 x 80 x 6 x 840 mm',   'NOS', 6.42, 'Edge Board',            18.50, 'Brown kraft',  null),
  ('EB080600003', 'EB 80 x 80 x 6 x 990 mm',   'NOS', 7.56, 'Edge Board',            21.25, 'Brown kraft',  null),
  ('EB075600011', 'EB 75 x 75 x 6 x 1219 mm',  'NOS', 7.11, 'Edge Board',            24.00, 'As per PO',    'PUR-VB0RD48-PKG'),
  ('CB1200450',   '5-ply carton box - 450 x 320 x 280 mm', 'NOS', 0.82, 'Carton box', 42.00, '5-ply export', 'APA-CB-450'),
  ('EC075020',    'Paper Slitting E-CORE - 75 mm', 'NOS', 1.18, 'Paper Slitting E-CORE', 36.50, 'Heavy duty', null),
  ('EB1005000181','EB 100 x 100 x 5 x 380 mm', 'NOS', 0.25, 'Edge Board',            50.00, null,           null),
  ('EB1005000120','EB 120 x 10 x 2.5 x 380 mm','NOS', 0.40, 'Pyro',                  35.00, null,           null)
) as v(part_no, description, uom, weight, category_name, price, remarks, customer_ref)
join c on c.name = v.category_name
on conflict (part_no) do update set description = excluded.description, uom = excluded.uom,
  standard_weight_kg = excluded.standard_weight_kg, category_id = excluded.category_id,
  price = excluded.price, remarks = excluded.remarks, customer_ref = excluded.customer_ref;

-- Vendors: SAMPLE STRUCTURE ONLY (docs/architecture v1.3, Appendix D) — "ABC Ltd" / "XYZ Ltd" /
-- "MNX Ltd" and their GSTINs are placeholder values from SGR Master.xlsx, not real business records.
-- Replace with real vendor data before go-live; this exists to prove one vendor -> many contacts ->
-- many delivery locations works end to end.
insert into app.business_partners (code, name, gstin, is_customer, is_supplier) values
  ('ABC01', 'ABC Ltd', '33ABCDE1234F1Z1', true, false),
  ('XYX01', 'XYZ Ltd', '33ABCDE1234F1Z2', true, false),
  ('MXN01', 'MNX Ltd', '33ABCDE1234F1Z3', true, false)
on conflict (code) do update set name = excluded.name, gstin = excluded.gstin;

with p as (select id, code from app.business_partners)
insert into app.partner_contacts (partner_id, name, phone, email, is_primary)
select p.id, v.name, v.phone, v.email, v.is_primary
from (values
  ('ABC01', 'Arvind',  '90000 00001', 'arvind@abc.com', true),
  ('ABC01', 'Anand',   '90000 00002', 'anand@abc.com',  false),
  ('ABC01', 'Akash',   '90000 00003', 'akash@abc.com',  false),
  ('XYX01', 'Velan',   '80000 00001', 'Velan@xyz.com',  true),
  ('XYX01', 'Murugan', '80000 00002', 'mur@xyz.com',    false),
  ('MXN01', 'Ganga',   '70000 00001', 'ganga@mnx.com',  true)
) as v(partner_code, name, phone, email, is_primary)
join p on p.code = v.partner_code
where not exists (
  select 1 from app.partner_contacts pc where pc.partner_id = p.id and pc.email = v.email
);

with p as (select id, code from app.business_partners)
insert into app.partner_addresses (partner_id, kind, line1, city, is_primary)
select p.id, 'delivery', v.line1, v.city, v.is_primary
from (values
  ('ABC01', '1, First St',    'Chennai',     true),
  ('ABC01', '2, Second St',   'Cochin',      false),
  ('ABC01', '3, Third St',    'Coimbatore',  false),
  ('XYX01', '23, Mount Rd',   'Chennai',     true),
  ('XYX01', '12, River Road', 'Salem',       false),
  ('MXN01', '123, Last St',   'Madurai',     true)
) as v(partner_code, line1, city, is_primary)
join p on p.code = v.partner_code
where not exists (
  select 1 from app.partner_addresses pa where pa.partner_id = p.id and pa.line1 = v.line1
);

insert into app.delivery_locations (partner_id, address_id, label)
select pa.partner_id, pa.id, (select name from app.business_partners where id = pa.partner_id) || ' - ' || pa.city
from app.partner_addresses pa
where not exists (select 1 from app.delivery_locations dl where dl.address_id = pa.id);

// Hand-maintained TypeScript mirror of db/migrations (the `app` Postgres schema).
// This is the API contract: apps/web imports it today, and a future mobile app (Supabase's iOS/Android/
// React Native SDKs all speak the same schema-qualified REST/RPC surface) would import the exact same
// package. Regenerate with `supabase gen types typescript --schema app` once the CLI is linked to the
// project, and diff the result against this file rather than trusting either blindly.

export type UserRole = 'creator' | 'md' | 'planner' | 'qc' | 'finance' | 'admin';

export type WoStatus =
  | 'draft'
  | 'pending_finance_approval' // added 28 Sep 2026 — Finance gate between Draft and Created
  | 'created'
  | 'in_production'
  | 'qc_pending'
  | 'partially_qc_approved'
  | 'ready_for_dispatch'
  | 'completed'
  | 'cancelled';

export type SupplyType = 'intra' | 'inter';

export interface AppUser {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  is_active: boolean;
  created_at: string;
}

export interface Category {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
}

export interface SalesPerson {
  id: string;
  name: string;
  phone: string | null;
  location: string | null;
  is_active: boolean;
}

export interface Shift {
  id: string;
  code: string;
  name: string;
  start_time: string; // "HH:MM:SS"
  end_time: string;
  is_active: boolean;
}

export interface Part {
  id: string;
  part_no: string;
  description: string;
  uom: string;
  standard_weight_kg: number;
  category_id: string | null;
  price: number;
  remarks: string | null;
  customer_ref: string | null;
  is_active: boolean;
}

export interface BusinessPartner {
  id: string;
  code: string;
  name: string;
  gstin: string | null;
  is_customer: boolean;
  is_supplier: boolean;
  is_active: boolean;
}

export interface PartnerContact {
  id: string;
  partner_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  is_primary: boolean;
}

export interface PartnerAddress {
  id: string;
  partner_id: string;
  kind: 'billing' | 'delivery';
  line1: string;
  city: string | null;
  is_primary: boolean;
}

export interface DeliveryLocation {
  id: string;
  partner_id: string;
  address_id: string | null;
  label: string;
  is_active: boolean;
}

export interface WorkOrder {
  id: string;
  wo_number: string | null; // null while status === 'draft'
  revision: number;
  status: WoStatus;
  partner_id: string | null;
  delivery_location_id: string | null;
  delivery_location_snapshot: Record<string, unknown> | null;
  wo_date: string; // date
  delivery_date: string | null;
  doc_ref: string | null;
  sales_person_id: string | null;
  expected_completion_date: string | null;
  test_cert_required: boolean;
  inspection_report_required: boolean;
  additional_notes: string | null;
  packing_required: boolean;
  units_per_bundle: number | null;
  pallet_height_in: number | null;
  separate_vehicle_required: boolean;
  transport_notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface WorkOrderLine {
  id: string;
  work_order_id: string;
  line_no: number;
  part_id: string | null;
  part_no_snapshot: string;
  description_snapshot: string;
  uom_snapshot: string;
  standard_weight_kg_snapshot: number;
  category_snapshot: string | null;
  standard_price_snapshot: number;
  final_price: number;
  qty: number;
  remarks: string | null;
  customer_price: number | null; // what the customer is charged per unit; entered by the creator (017)
  customer_ref: string | null; // snapshot of the Item Master's, editable per line (006)
}

// One point per row (006). `icon` is unused today: the symbol chosen from a note's content goes there later.
export interface WorkOrderNote {
  id: string;
  work_order_id: string;
  position: number;
  note: string;
  icon: string | null;
  created_at: string;
}

export interface WorkOrderRevision {
  id: string;
  work_order_id: string;
  revision: number;
  snapshot: Record<string, unknown>;
  change_summary: string | null;
  changed_by: string | null;
  changed_at: string;
}

export interface StatusHistoryEntry {
  id: string;
  work_order_id: string;
  from_status: WoStatus | null;
  to_status: WoStatus;
  changed_by: string | null;
  changed_at: string;
  note: string | null;
}

export interface CompletionDateChange {
  id: string;
  work_order_id: string;
  from_date: string | null;
  to_date: string;
  reason: string | null;
  changed_by: string | null;
  changed_at: string;
}

export interface ProductionEntry {
  id: string;
  work_order_id: string;
  production_date: string;
  shift_id: string | null;
  labour_count: number | null;
  planner_id: string | null;
  created_at: string;
}

export interface ProductionOutputLine {
  id: string;
  production_entry_id: string;
  work_order_line_id: string;
  qty: number;
  actual_weight_kg: number;
  note: string | null;
}

export interface QcSubmission {
  id: string;
  work_order_line_id: string;
  qty: number;
  submitted_by: string | null;
  submitted_at: string;
}

export interface QcInspection {
  id: string;
  work_order_line_id: string;
  accepted_qty: number;
  held_qty: number;
  comments: string | null;
  inspector_id: string | null;
  inspected_at: string;
}

export interface Attachment {
  id: string;
  work_order_id: string | null;
  qc_inspection_id: string | null;
  file_name: string;
  storage_key: string;
  content_type: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
}

export interface Invoice {
  id: string;
  work_order_id: string;
  invoice_number: string;
  invoice_date: string;
  gst_rate: number;
  supply_type: SupplyType;
  subtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  grand_total: number;
  generated_by: string | null;
  generated_at: string;
  dispatched_at: string | null; // set when the goods leave (010); null = still waiting at the gate
  dispatched_by: string | null;
}

export interface InvoiceLine {
  id: string;
  invoice_id: string;
  work_order_line_id: string | null;
  description: string;
  qty: number;
  price: number;
  amount: number;
}

export interface Notification {
  id: string;
  user_id: string | null; // null = broadcast
  work_order_id: string | null;
  message: string;
  is_read: boolean;
  created_at: string;
}

export interface FinanceApproval {
  id: string;
  work_order_id: string;
  action: 'approved' | 'rejected';
  comments: string | null;
  actor: string | null;
  created_at: string;
}

// ---------------------------------------------------------------- RPC payloads (db/migrations/003_functions.sql)

export interface SaveDraftLine {
  part_id: string;
  qty: number;
  remarks?: string;
  customer_price?: number | string | null;
  customer_ref?: string; // omitted -> the Item Master's value
}

export interface SaveDraftNote {
  text: string;
  icon?: string;
}

export interface SaveDraftPayload {
  partner_id?: string;
  delivery_location_id?: string;
  delivery_location_snapshot?: Record<string, unknown>;
  wo_date?: string;
  delivery_date?: string;
  doc_ref?: string;
  sales_person_id?: string;
  test_cert_required?: boolean;
  inspection_report_required?: boolean;
  notes?: SaveDraftNote[];
  packing_required?: boolean;
  units_per_bundle?: number;
  pallet_height_in?: number;
  separate_vehicle_required?: boolean;
  transport_notes?: string;
  lines?: SaveDraftLine[];
}

export interface RecordProductionLine {
  work_order_line_id: string;
  qty: number;
  actual_weight_kg?: number;
  note?: string;
}

export interface RecordProductionPayload {
  work_order_id: string;
  production_date?: string;
  shift_id: string;
  labour_count: number;
  lines: RecordProductionLine[];
}

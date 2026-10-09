import { supabase } from './supabase';

// Sales order files (the customer's order document, PDF or JPG): bytes go to a PRIVATE Storage bucket and one
// app.attachments row (kind = 'sales_order') records which Work Order it belongs to
// (db/migrations/021_sales_order_file_and_delivery_date.sql). Only Creator, MD, Admin and Finance can see them —
// the database enforces that; Planner and QC get nothing back.
export const SALES_BUCKET = 'sales-order-files';
export const SALES_MAX_BYTES = 10 * 1024 * 1024;
export const SALES_ACCEPT = '.pdf,.jpg,.jpeg,application/pdf,image/jpeg';

/** null if the file is acceptable, otherwise a message for the user. */
export function checkSalesFile(f: File): string | null {
  if (f.size > SALES_MAX_BYTES) return `${f.name} is larger than ${SALES_MAX_BYTES / 1048576} MB.`;
  if (f.size === 0) return `${f.name} is empty.`;
  if (f.type !== 'application/pdf' && f.type !== 'image/jpeg') return `${f.name}: only PDF or JPG files are allowed.`;
  return null;
}

const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120);

/** Uploads one file and records it. Returns null on success, or a short reason on failure. */
export async function uploadSalesFile(file: File, ctx: { workOrderId: string; uploadedBy: string | null }): Promise<string | null> {
  const key = `${ctx.workOrderId}/${crypto.randomUUID()}-${safeName(file.name)}`;
  const up = await supabase.storage.from(SALES_BUCKET).upload(key, file, { contentType: file.type, upsert: false });
  if (up.error) return up.error.message;
  const { error } = await supabase.from('attachments').insert({
    work_order_id: ctx.workOrderId, file_name: file.name, storage_key: key, content_type: file.type,
    uploaded_by: ctx.uploadedBy, kind: 'sales_order',
  });
  if (error) {
    await supabase.storage.from(SALES_BUCKET).remove([key]);   // don't leave an unrecorded file behind
    return error.message;
  }
  return null;
}

/** Removes the record and the stored file. Returns null on success, or a reason. */
export async function removeSalesFile(att: { id: string; storage_key: string }): Promise<string | null> {
  const { data, error } = await supabase.from('attachments').delete().eq('id', att.id).select('id');
  if (error) return error.message;
  if (!data?.length) return 'This file can no longer be removed (the order may already be approved).';
  await supabase.storage.from(SALES_BUCKET).remove([att.storage_key]);
  return null;
}

/** Opens a file through a short-lived signed link (the bucket is private). */
export async function openSalesFile(storageKey: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(SALES_BUCKET).createSignedUrl(storageKey, 60);
  if (error || !data) return error?.message ?? 'Could not open the file.';
  window.open(data.signedUrl, '_blank', 'noopener');
  return null;
}

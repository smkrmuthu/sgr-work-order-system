import { supabase } from './supabase';

// QC inspection files: bytes go to a PRIVATE Storage bucket, one app.attachments row per file records what
// it is and which inspection it belongs to (db/migrations/009_qc_files.sql). The bucket itself also enforces
// the size limit and the file-type allow-list server-side — the checks here just fail fast with a clear message.
export const QC_BUCKET = 'qc-attachments';
export const QC_MAX_BYTES = 10 * 1024 * 1024;

// `accept` also makes a phone's file picker offer the camera / photo library, which is how photos will arrive
// later without any change to the storage side.
export const QC_ACCEPT = 'image/*,.pdf,.txt,.csv,.xls,.xlsx,.doc,.docx';
const ALLOWED = [
  /^image\/(jpeg|png|webp|heic)$/, /^application\/pdf$/, /^text\/(plain|csv)$/,
  /^application\/vnd\.ms-excel$/, /^application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet$/,
  /^application\/msword$/, /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/,
];

/** null if the file is acceptable, otherwise a message for the user. */
export function checkQcFile(f: File): string | null {
  if (f.size > QC_MAX_BYTES) return `${f.name} is larger than ${QC_MAX_BYTES / 1048576} MB.`;
  if (f.size === 0) return `${f.name} is empty.`;
  if (!ALLOWED.some((re) => re.test(f.type))) return `${f.name}: this file type isn't allowed (images, PDF, Excel, Word, CSV or text only).`;
  return null;
}

const safeName = (n: string) => n.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120);

/** Uploads one file and records it. Returns null on success, or a short reason on failure. */
export async function uploadQcFile(
  file: File,
  ctx: { workOrderId: string; inspectionId: string; uploadedBy: string | null },
): Promise<string | null> {
  const key = `${ctx.workOrderId}/${ctx.inspectionId}/${crypto.randomUUID()}-${safeName(file.name)}`;
  const up = await supabase.storage.from(QC_BUCKET).upload(key, file, { contentType: file.type, upsert: false });
  if (up.error) return up.error.message;
  const { error } = await supabase.from('attachments').insert({
    work_order_id: ctx.workOrderId, qc_inspection_id: ctx.inspectionId,
    file_name: file.name, storage_key: key, content_type: file.type, uploaded_by: ctx.uploadedBy,
  });
  return error ? error.message : null;
}

/** Opens a file through a short-lived signed link (the bucket is private). */
export async function openQcFile(storageKey: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(QC_BUCKET).createSignedUrl(storageKey, 60);
  if (error || !data) return error?.message ?? 'Could not open the file.';
  window.open(data.signedUrl, '_blank', 'noopener');
  return null;
}

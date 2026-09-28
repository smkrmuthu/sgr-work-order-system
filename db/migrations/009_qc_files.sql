-- 009: file uploads for QC inspections (test reports, certificates, scans — photos come later).
-- Safe to re-run.
--
-- The file bytes live in a PRIVATE Supabase Storage bucket; app.attachments (already in 001) holds one
-- row per file: which Work Order and inspection it belongs to, its original name, and its storage path.
-- Nothing is public: the app opens files through short-lived signed links.

-- ---------------------------------------------------------------- who may add attachment rows
-- QC (and MD/Admin) attach files to an inspection. Files that belong to a Work Order but not to an
-- inspection may be added by the Creator, MD, Planner or Admin. Nobody can edit or delete a row: a file
-- attached to an inspection stays on record.
drop policy if exists attachments_write on app.attachments;
create policy attachments_write on app.attachments for insert to authenticated
  with check (
    app.current_role_in('qc', 'md', 'admin')
    or (qc_inspection_id is null and app.current_role_in('creator', 'planner'))
  );

-- ---------------------------------------------------------------- the storage bucket + its rules
-- Guarded so the migration still runs where Supabase Storage doesn't exist (the local test database
-- creates a minimal stand-in for it).
do $$
begin
  if to_regclass('storage.buckets') is null then
    raise notice 'storage schema not present — skipping the qc-attachments bucket';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values (
    'qc-attachments', 'qc-attachments', false, 10485760,   -- 10 MB per file
    array[
      'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf', 'text/plain', 'text/csv',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]
  )
  on conflict (id) do update
    set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

  -- Anyone active and signed in can read (same as the attachment rows themselves) ...
  execute 'drop policy if exists qc_files_read on storage.objects';
  execute $p$create policy qc_files_read on storage.objects for select to authenticated
             using (bucket_id = 'qc-attachments' and app.current_role() is not null)$p$;

  -- ... only QC / MD / Admin can upload, and nobody can overwrite or delete.
  execute 'drop policy if exists qc_files_upload on storage.objects';
  execute $p$create policy qc_files_upload on storage.objects for insert to authenticated
             with check (bucket_id = 'qc-attachments' and app.current_role_in('qc', 'md', 'admin'))$p$;
end $$;

// Used by .github/workflows/db-backup.yml. A standalone .mjs (not inlined into the YAML as `node -e`,
// which risked breaking depending on the runner's exact Node version and whether it auto-detects ESM
// syntax) so this always runs as a real ES module regardless of that.
//
// Fixes two bugs found in the previous inline version:
//  1. It authenticated with the anon key and never signed in, so every query ran as Postgres role
//     `anon` — which db/migrations/005_grants.sql explicitly has zero privileges on schema `app` —
//     and the script read `error` but never checked it, so every table silently became `[]`. The job
//     reported "Backup completed successfully. Total records: 0" on every single run.
//  2. Because of #1, the job never failed even though it was never backing anything up. Any real
//     failure now stops the script (non-zero exit), so GitHub shows a failed run instead of a green
//     checkmark on an empty backup.
//
// Auth: SUPABASE_SERVICE_ROLE_KEY (a GitHub Actions secret — see docs/SETUP.md), never the anon key.
// This is server-side CI infrastructure, not a browser, so the service_role key is the right tool here
// — the same reasoning that puts it in the manage-app-users Edge Function and nowhere in apps/web.
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set (see .github/workflows/db-backup.yml).');
  process.exit(1);
}
const supabase = createClient(url, serviceRoleKey, { db: { schema: 'app' }, auth: { persistSession: false, autoRefreshToken: false } });

const TABLES = [
  'users', 'categories', 'shifts', 'parts', 'business_partners',
  'partner_addresses', 'partner_contacts', 'delivery_locations',
  'wo_number_counters', 'work_orders', 'work_order_lines',
  'work_order_notes', 'work_order_revisions', 'status_history',
  'completion_date_changes', 'finance_approvals', 'production_entries',
  'production_output_lines', 'qc_submissions', 'qc_inspections',
  'attachments', 'invoices', 'invoice_lines', 'notifications', 'audit_events',
];

function sqlEscape(val) {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return Number.isNaN(val) ? 'NULL' : String(val);
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'object') return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
  return `'${String(val).replace(/'/g, "''")}'`;
}

async function run() {
  const dump = {
    metadata: { system: 'SGR Work Order Management System', timestamp: new Date().toISOString(), total_records: 0, table_counts: {} },
    tables: {},
  };
  const failed = [];

  for (const t of TABLES) {
    // service_role bypasses RLS but a table this large (work_order_lines, status_history, ...) can
    // still exceed PostgREST's default 1000-row page, so this pages through with .range() instead
    // of a single unbounded select — the same gap flagged in the backup export earlier.
    let rows = [];
    for (let page = 0; ; page++) {
      const from = page * 1000, to = from + 999;
      const { data, error } = await supabase.from(t).select('*').range(from, to);
      if (error) { failed.push(`${t}: ${error.message}`); break; }
      rows = rows.concat(data ?? []);
      if (!data || data.length < 1000) break;
    }
    dump.tables[t] = rows;
    dump.metadata.table_counts[t] = rows.length;
    dump.metadata.total_records += rows.length;
  }

  if (failed.length) {
    console.error('Backup FAILED — could not read:\n  ' + failed.join('\n  '));
    process.exit(1);
  }

  fs.mkdirSync('backups', { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(`backups/sgr_db_backup_${dateStr}.json`, JSON.stringify(dump, null, 2));

  const sql = [
    '-- SGR MOULDS INDIA PVT LTD — AUTOMATED DATABASE BACKUP & REBUILD SCRIPT',
    `-- Timestamp: ${dump.metadata.timestamp}`,
    `-- Total Records: ${dump.metadata.total_records}`,
    'BEGIN;',
    'SET session_replication_role = replica;\n',
  ];
  for (const t of TABLES) {
    const rows = dump.tables[t] ?? [];
    sql.push(`-- Table: app.${t} (${rows.length} rows)`);
    if (rows.length > 0) {
      const cols = Object.keys(rows[0]);
      const colList = cols.map((c) => `"${c}"`).join(', ');
      for (const r of rows) {
        sql.push(`INSERT INTO app."${t}" (${colList}) VALUES (${cols.map((c) => sqlEscape(r[c])).join(', ')}) ON CONFLICT DO NOTHING;`);
      }
    }
    sql.push('');
  }
  sql.push('SET session_replication_role = origin;', 'COMMIT;');
  fs.writeFileSync(`backups/sgr_db_rebuild_${dateStr}.sql`, sql.join('\n'));

  console.log('Backup completed. Total records:', dump.metadata.total_records);
  console.log('Per table:', JSON.stringify(dump.metadata.table_counts, null, 2));
}

run().catch((e) => { console.error(e); process.exit(1); });

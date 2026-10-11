import { supabase } from '@/lib/supabase';

export const BACKUP_TABLES = [
  'users',
  'categories',
  'shifts',
  'parts',
  'business_partners',
  'partner_addresses',
  'partner_contacts',
  'delivery_locations',
  'wo_number_counters',
  'work_orders',
  'work_order_lines',
  'work_order_line_prices',
  'qc_reject_reasons',
  'qc_rejections',
  'qc_rejection_decisions',
  'sales_persons',
  'supervisors',
  'work_order_notes',
  'work_order_revisions',
  'status_history',
  'completion_date_changes',
  'finance_approvals',
  'production_entries',
  'production_output_lines',
  'qc_submissions',
  'qc_inspections',
  'attachments',
  'invoices',
  'invoice_lines',
  'notifications',
] as const;

export type BackupTable = (typeof BACKUP_TABLES)[number];

export interface BackupData {
  metadata: {
    system: string;
    version: string;
    timestamp: string;
    exported_by: string;
    total_records: number;
    table_counts: Record<string, number>;
  };
  tables: Record<string, Record<string, unknown>[]>;
}

function sqlEscape(val: unknown): string {
  if (val === null || val === undefined) return 'NULL';
  if (typeof val === 'number') return isNaN(val) ? 'NULL' : String(val);
  if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
  if (typeof val === 'object') {
    return `'${JSON.stringify(val).replace(/'/g, "''")}'::jsonb`;
  }
  const str = String(val);
  return `'${str.replace(/'/g, "''")}'`;
}

export async function fetchFullDatabaseDump(userEmail: string): Promise<BackupData> {
  const tablesData: Record<string, Record<string, unknown>[]> = {};
  const tableCounts: Record<string, number> = {};
  let totalRecords = 0;

  // Routed through app.export_table (db/migrations/013_backup_export_rpc.sql), a SECURITY DEFINER
  // function that re-checks md/admin itself, rather than a plain `.from(table).select('*')`. RLS
  // deliberately leaves most of these tables readable by every signed-in role for their own screens, so
  // a raw select here would let anyone who reached this page — or just replayed the same network
  // request — pull the whole database. The RPC is the actual access-control boundary; the page's own
  // role check below is only what decides whether to offer the button.
  for (const table of BACKUP_TABLES) {
    const { data, error } = await supabase.rpc('export_table', { p_table: table });
    if (error) {
      console.warn(`Warning: Could not export table app.${table}: ${error.message}`);
      tablesData[table] = [];
      tableCounts[table] = 0;
    } else {
      const rows = (data as Record<string, unknown>[] | null) ?? [];
      tablesData[table] = rows;
      tableCounts[table] = rows.length;
      totalRecords += rows.length;
    }
  }

  return {
    metadata: {
      system: 'SGR Work Order Management System',
      version: 'Phase-1 Production',
      timestamp: new Date().toISOString(),
      exported_by: userEmail,
      total_records: totalRecords,
      table_counts: tableCounts,
    },
    tables: tablesData,
  };
}

export function generateSqlRebuildScript(backup: BackupData): string {
  const lines: string[] = [];

  lines.push('-- ==============================================================================');
  lines.push('-- SGR MOULDS INDIA PVT LTD — FULL DATABASE BACKUP & REBUILD SCRIPT');
  lines.push(`-- Generated At: ${backup.metadata.timestamp}`);
  lines.push(`-- Exported By:  ${backup.metadata.exported_by}`);
  lines.push(`-- Total Records: ${backup.metadata.total_records}`);
  lines.push('-- ==============================================================================');
  lines.push('-- HOW TO REBUILD:');
  lines.push('-- 1. Run all migrations in db/migrations/ (001 through 011) against your Postgres DB.');
  lines.push('-- 2. Run this file in Supabase SQL Editor or psql to restore all application data.');
  lines.push('-- ==============================================================================\n');

  lines.push('BEGIN;\n');
  lines.push('-- Temporarily disable triggers and foreign key cascades to ensure clean rebuild');
  lines.push('SET session_replication_role = replica;\n');

  for (const table of BACKUP_TABLES) {
    const rows = backup.tables[table] ?? [];
    lines.push(`-- ----------------------------------------------------------------`);
    lines.push(`-- Table: app.${table} (${rows.length} rows)`);
    lines.push(`-- ----------------------------------------------------------------`);

    if (rows.length === 0) {
      lines.push(`-- (no rows)\n`);
      continue;
    }

    const columns = Object.keys(rows[0]!);
    const colList = columns.map((c) => `"${c}"`).join(', ');

    for (const row of rows) {
      const valList = columns.map((c) => sqlEscape(row[c])).join(', ');
      lines.push(`INSERT INTO app."${table}" (${colList}) VALUES (${valList}) ON CONFLICT DO NOTHING;`);
    }
    lines.push('');
  }

  lines.push('-- Re-enable standard trigger and foreign key constraints');
  lines.push('SET session_replication_role = origin;\n');
  lines.push('COMMIT;\n');
  lines.push('-- REBUILD COMPLETED SUCCESSFULLY.');

  return lines.join('\n');
}

export function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

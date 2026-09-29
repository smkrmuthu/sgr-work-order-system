'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth';
import {
  BACKUP_TABLES,
  fetchFullDatabaseDump,
  generateSqlRebuildScript,
  downloadFile,
  type BackupData,
} from '@/lib/backup';

export default function BackupPage() {
  const { profile, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [backupData, setBackupData] = useState<BackupData | null>(null);
  const [error, setError] = useState('');
  const [successNotice, setSuccessNotice] = useState('');

  const loadCounts = useCallback(async () => {
    setError('');
    try {
      const data = await fetchFullDatabaseDump(profile?.email || 'admin@sgr.com');
      setBackupData(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Could not fetch database status.');
    } finally {
      setLoading(false);
    }
  }, [profile]);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  const handleExportSql = async () => {
    setExporting(true);
    setError('');
    setSuccessNotice('');
    try {
      const dump = await fetchFullDatabaseDump(profile?.email || 'admin@sgr.com');
      const sql = generateSqlRebuildScript(dump);
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `sgr_db_rebuild_${dateStr}.sql`;
      downloadFile(sql, filename, 'application/sql');
      setSuccessNotice(`Successfully generated and downloaded ${filename} (${dump.metadata.total_records} records).`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to export SQL rebuild script.');
    } finally {
      setExporting(false);
    }
  };

  const handleExportJson = async () => {
    setExporting(true);
    setError('');
    setSuccessNotice('');
    try {
      const dump = await fetchFullDatabaseDump(profile?.email || 'admin@sgr.com');
      const jsonStr = JSON.stringify(dump, null, 2);
      const dateStr = new Date().toISOString().slice(0, 10);
      const filename = `sgr_db_backup_${dateStr}.json`;
      downloadFile(jsonStr, filename, 'application/json');
      setSuccessNotice(`Successfully exported JSON backup archive ${filename}.`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to export JSON backup.');
    } finally {
      setExporting(false);
    }
  };

  // The real access control is app.export_table's own role check (db/migrations/013) — it can't be
  // bypassed by calling the same request directly, the way this page-level gate could be. This just
  // gives anyone who lands here anyway (a stale bookmark, a role change) a clear message instead of a
  // page that quietly shows "0 records" and downloads empty files once every export_table call fails.
  if (authLoading) return null;
  if (profile && profile.role !== 'md' && profile.role !== 'admin') {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-800">
        This page is for MD and Admin only.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 pb-12">
      {/* Page Header */}
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-black text-forest-950">Database Backup & Rebuild</h1>
            <span className="rounded-full bg-emerald-100 border border-emerald-200 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
              MD / Admin Only
            </span>
          </div>
          <p className="text-xs text-ink-500 mt-0.5">
            Export complete snapshots of the <code className="font-mono text-forest-800 font-bold">app</code> database schema to rebuild the system anytime.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => { setLoading(true); loadCounts(); }}
            disabled={loading || exporting}
            className="btn-secondary text-xs"
          >
            🔄 Refresh Status
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-xs font-semibold text-rose-700">
          {error}
        </div>
      )}

      {successNotice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-xs font-semibold text-emerald-800">
          ✅ {successNotice}
        </div>
      )}

      {/* Quick Action Download Cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* SQL Rebuild Card */}
        <div className="flex flex-col justify-between rounded-xl border border-forest-300 bg-white p-5 shadow-xs hover:border-forest-500 transition-colors">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-2xl">📦</span>
              <span className="rounded bg-forest-100 text-forest-800 font-mono text-[10px] font-bold px-2 py-0.5">
                .SQL SCRIPT
              </span>
            </div>
            <h2 className="mt-3 text-base font-bold text-forest-950">Executable SQL Rebuild Script</h2>
            <p className="mt-1 text-xs text-ink-600 leading-relaxed">
              Generates a complete PostgreSQL executable file with disabled triggers and safe <code className="font-mono">ON CONFLICT</code> handling. Can be run directly in the Supabase SQL Editor or via psql to rebuild or restore data in seconds.
            </p>
          </div>

          <div className="mt-5 pt-4 border-t border-kraft-100 flex items-center justify-between">
            <span className="text-xs font-semibold text-ink-500">
              {backupData ? `${backupData.metadata.total_records} records ready` : 'Calculating…'}
            </span>
            <button
              onClick={handleExportSql}
              disabled={exporting || loading}
              className="btn-primary flex items-center gap-1.5 text-xs shadow-xs"
            >
              <span>⬇</span> {exporting ? 'Generating…' : 'Download SQL Rebuild File'}
            </button>
          </div>
        </div>

        {/* JSON Archive Card */}
        <div className="flex flex-col justify-between rounded-xl border border-kraft-300 bg-white p-5 shadow-xs hover:border-forest-300 transition-colors">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-2xl">🗄️</span>
              <span className="rounded bg-kraft-100 text-kraft-900 font-mono text-[10px] font-bold px-2 py-0.5">
                .JSON ARCHIVE
              </span>
            </div>
            <h2 className="mt-3 text-base font-bold text-forest-950">Structured JSON Data Archive</h2>
            <p className="mt-1 text-xs text-ink-600 leading-relaxed">
              Exports a machine-readable JSON archive containing all table records, column snapshots, and metadata. Ideal for offline inspection, data analytics, and cross-system migrations.
            </p>
          </div>

          <div className="mt-5 pt-4 border-t border-kraft-100 flex items-center justify-between">
            <span className="text-xs font-semibold text-ink-500">
              Format: Standard JSON (UTF-8)
            </span>
            <button
              onClick={handleExportJson}
              disabled={exporting || loading}
              className="btn-secondary flex items-center gap-1.5 text-xs shadow-xs"
            >
              <span>⬇</span> {exporting ? 'Generating…' : 'Download JSON Archive'}
            </button>
          </div>
        </div>
      </div>

      {/* Automated Backup Schedule Notice */}
      <section className="rounded-xl border border-violet-200 bg-violet-50/50 p-5 shadow-xs">
        <div className="flex items-start gap-3.5">
          <span className="text-2xl">⏰</span>
          <div>
            <h3 className="text-sm font-bold text-violet-950">Automated 2-Day Scheduled Backup Active</h3>
            <p className="mt-1 text-xs text-violet-800 leading-relaxed">
              In addition to manual on-demand downloads, the automated backup workflow triggers every <strong>2 days at 00:00 UTC</strong> (<code className="font-mono text-[11px] bg-violet-100 px-1.5 py-0.5 rounded">0 0 */2 * *</code>). Each backup snapshot is automatically generated and safely archived.
            </p>
          </div>
        </div>
      </section>

      {/* Live Table Schema & Record Counts */}
      <section className="rounded-xl border border-kraft-200 bg-white p-5 shadow-xs">
        <div className="flex items-center justify-between border-b border-kraft-100 pb-3">
          <div>
            <h2 className="text-sm font-bold text-forest-900 uppercase tracking-wide">
              📋 Live Database Schema Status (<code className="font-mono text-forest-800">app</code> schema)
            </h2>
            <p className="text-[11px] text-ink-500">Summary of all tables included in the backup dump.</p>
          </div>
          <div className="text-xs font-bold text-ink-700">
            Total Records: <span className="font-mono text-forest-900">{backupData?.metadata.total_records ?? 0}</span>
          </div>
        </div>

        {loading ? (
          <div className="py-8 text-center text-xs text-ink-500 font-semibold">Loading live table records…</div>
        ) : (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
            {BACKUP_TABLES.map((table) => {
              const count = backupData?.metadata.table_counts[table] ?? 0;
              return (
                <div
                  key={table}
                  className="flex items-center justify-between rounded-lg border border-kraft-100 bg-kraft-50/50 px-3 py-2 text-xs"
                >
                  <span className="font-mono text-ink-800 font-medium truncate max-w-[160px]">
                    app.{table}
                  </span>
                  <span className={`font-mono font-bold px-1.5 py-0.5 rounded text-[11px] ${count > 0 ? 'bg-forest-100 text-forest-900' : 'bg-ink-100 text-ink-500'}`}>
                    {count} {count === 1 ? 'row' : 'rows'}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* How to Rebuild Guide */}
      <section className="rounded-xl border border-kraft-200 bg-white p-5 shadow-xs">
        <h2 className="text-sm font-bold text-forest-900 uppercase tracking-wide border-b border-kraft-100 pb-2.5">
          🛠️ How to Rebuild the Application from a Backup (.sql)
        </h2>
        <div className="mt-3.5 space-y-3 text-xs text-ink-700 leading-relaxed">
          <div className="flex items-start gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-forest-800 text-[10px] font-bold text-white">1</span>
            <div>
              <strong>Setup Clean PostgreSQL / Supabase Project:</strong> If rebuilding on a new project, execute all migration SQL files in <code className="font-mono bg-kraft-100 px-1 py-0.5 rounded">db/migrations/</code> (from <code className="font-mono">001_schema.sql</code> to <code className="font-mono">011_md_approve_and_revisions.sql</code>).
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-forest-800 text-[10px] font-bold text-white">2</span>
            <div>
              <strong>Execute the Downloaded Rebuild Script:</strong> Paste the contents of your downloaded <code className="font-mono bg-kraft-100 px-1 py-0.5 rounded">sgr_db_rebuild_YYYY-MM-DD.sql</code> into the Supabase SQL Editor (or execute via psql). It will cleanly insert all business records with disabled triggers and restore all work order histories.
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-forest-800 text-[10px] font-bold text-white">3</span>
            <div>
              <strong>Deploy the Edge Function:</strong> Run <code className="font-mono bg-kraft-100 px-1 py-0.5 rounded">supabase functions deploy manage-app-users</code> to enable user management.
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

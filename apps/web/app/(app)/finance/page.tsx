'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { BusinessPartner, WorkOrder, WorkOrderLine } from '@sgr/types';

type Row = WorkOrder & { partner?: BusinessPartner | null; work_order_lines?: WorkOrderLine[] };

// UPDATED 28 Sep 2026: a created Work Order now waits here before it may start production —
// see app.approve_work_order() / app.reject_work_order() (db/migrations/003_functions.sql).
export default function FinancePage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('work_orders')
      .select('*, partner:business_partners(*), work_order_lines(qty, final_price)')
      .eq('status', 'pending_finance_approval')
      .order('created_at');
    if (error) { setError(error.message); return; }
    setRows(data ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function approve(id: string) {
    setBusyId(id); setError('');
    const { error } = await supabase.rpc('approve_work_order', { p_work_order_id: id, p_comments: null });
    setBusyId(null);
    if (error) { setError(error.message); return; }
    load();
  }

  async function reject(id: string) {
    if (!reason.trim()) { setError('Enter a reason before rejecting.'); return; }
    setBusyId(id); setError('');
    const { error } = await supabase.rpc('reject_work_order', { p_work_order_id: id, p_reason: reason.trim() });
    setBusyId(null);
    if (error) { setError(error.message); return; }
    setRejectingId(null); setReason('');
    load();
  }

  const total = (r: Row) => (r.work_order_lines ?? []).reduce((n, l) => n + Number(l.qty) * Number(l.final_price), 0);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold text-forest-900">Finance — Approval Queue</h1>
        <p className="text-sm text-ink-500">
          Every Work Order sits here after Creation until Finance approves it — approving releases it
          to the production floor; rejecting sends it back to the Creator as an editable draft.
        </p>
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}

      <div className="overflow-hidden rounded-lg border border-kraft-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-kraft-100 text-left text-[11px] font-bold uppercase tracking-wide text-ink-900">
            <tr>
              <th className="px-3 py-2">WO #</th>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2">Delivery Date</th>
              <th className="px-3 py-2 text-right">Order Value</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-ink-500">Loading…</td></tr>
            )}
            {rows !== null && rows.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-8 text-center text-ink-500">Nothing is awaiting Finance approval.</td></tr>
            )}
            {rows?.map((r) => (
              <>
                <tr key={r.id} className="border-t border-kraft-100 hover:bg-kraft-50">
                  <td className="px-3 py-2">
                    <a href={`/work-orders/detail?id=${r.id}`} className="font-mono font-bold text-forest-800 hover:underline">
                      {r.wo_number}
                    </a>
                  </td>
                  <td className="px-3 py-2">{r.partner ? `${r.partner.code} — ${r.partner.name}` : '—'}</td>
                  <td className="px-3 py-2">{r.delivery_date ?? '—'}</td>
                  <td className="px-3 py-2 text-right font-mono">₹{total(r).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => approve(r.id)} disabled={busyId === r.id} className="btn-primary !px-3 !py-1.5">
                        {busyId === r.id ? 'Working…' : 'Approve'}
                      </button>
                      <button
                        onClick={() => { setRejectingId(rejectingId === r.id ? null : r.id); setReason(''); setError(''); }}
                        className="btn-secondary !px-3 !py-1.5"
                      >
                        Reject
                      </button>
                    </div>
                  </td>
                </tr>
                {rejectingId === r.id && (
                  <tr className="border-t border-kraft-100 bg-kraft-50">
                    <td colSpan={5} className="px-3 py-3">
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="Reason for rejection (sent back to the Creator as a draft)…"
                          className="input flex-1"
                        />
                        <button onClick={() => reject(r.id)} disabled={busyId === r.id} className="btn-primary !px-3 !py-1.5">
                          {busyId === r.id ? 'Working…' : 'Confirm Reject'}
                        </button>
                        <button onClick={() => setRejectingId(null)} className="btn-secondary !px-3 !py-1.5">Cancel</button>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { STATUS_LABEL } from '@/lib/statusLabels';
import type { WorkOrder, WorkOrderLine, QcSubmission, QcInspection } from '@sgr/types';

interface LineRow extends WorkOrderLine {
  sent: number;
  approved: number;
  held: number;
}

export default function QcPage() {
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [lines, setLines] = useState<LineRow[]>([]);
  const [error, setError] = useState('');

  const [inspectingId, setInspectingId] = useState<string | null>(null);
  const [accepted, setAccepted] = useState('');
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);

  const selected = orders.find((o) => o.id === selectedId) ?? null;

  const loadOrders = useCallback(async () => {
    const { data } = await supabase.from('work_orders').select('*').not('status', 'in', '("draft","completed","cancelled")').order('created_at');
    setOrders(data ?? []);
    if (!selectedId && data && data.length) setSelectedId(data[0]!.id);
  }, [selectedId]);

  const loadLines = useCallback(async (woId: string) => {
    const { data: ls } = await supabase.from('work_order_lines').select('*').eq('work_order_id', woId).order('line_no');
    const lineIds = (ls ?? []).map((l) => l.id);
    const [{ data: sub }, { data: insp }] = await Promise.all([
      lineIds.length ? supabase.from('qc_submissions').select('*').in('work_order_line_id', lineIds) : Promise.resolve({ data: [] as QcSubmission[] }),
      lineIds.length ? supabase.from('qc_inspections').select('*').in('work_order_line_id', lineIds) : Promise.resolve({ data: [] as QcInspection[] }),
    ]);
    setLines((ls ?? []).map((l) => ({
      ...l,
      sent: (sub ?? []).filter((s) => s.work_order_line_id === l.id).reduce((n, s) => n + Number(s.qty), 0),
      approved: (insp ?? []).filter((i) => i.work_order_line_id === l.id).reduce((n, i) => n + Number(i.accepted_qty), 0),
      held: (insp ?? []).filter((i) => i.work_order_line_id === l.id).reduce((n, i) => n + Number(i.held_qty), 0),
    })));
  }, []);

  useEffect(() => { loadOrders(); }, [loadOrders]);
  useEffect(() => { if (selectedId) loadLines(selectedId); setInspectingId(null); }, [selectedId, loadLines]);

  function startInspect(l: LineRow) {
    setInspectingId(l.id);
    setAccepted(String(l.sent - l.approved - l.held));
    setComments('');
  }

  async function submitInspection() {
    if (!inspectingId) return;
    setBusy(true); setError('');
    const { error } = await supabase.rpc('record_qc_inspection', {
      p_work_order_line_id: inspectingId, p_accepted_qty: Number(accepted), p_comments: comments || null,
    });
    setBusy(false);
    if (error) { setError(error.message); return; }
    setInspectingId(null);
    loadLines(selectedId); loadOrders();
  }

  async function reopen(lineId: string) {
    setError('');
    const { error } = await supabase.rpc('reopen_held', { p_work_order_line_id: lineId });
    if (error) { setError(error.message); return; }
    loadLines(selectedId); loadOrders();
  }

  const inspectingLine = lines.find((l) => l.id === inspectingId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold text-forest-900">QC — Inspection Queue</h1>
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="input max-w-xs">
          {orders.map((o) => <option key={o.id} value={o.id}>{o.wo_number} — {STATUS_LABEL[o.status]}</option>)}
        </select>
      </div>
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}
      {!selected && <p className="text-sm text-ink-500">Nothing awaiting inspection.</p>}

      {selected && (
        <section className="rounded-lg border border-kraft-200 bg-white">
          <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">AWAITING INSPECTION</div>
          <div className="overflow-x-auto p-5">
            <table className="w-full text-xs">
              <thead className="bg-kraft-100 text-left font-bold uppercase text-ink-900">
                <tr><th className="px-2 py-2">Part #</th><th className="px-2 py-2">Awaiting</th><th className="px-2 py-2">Approved</th><th className="px-2 py-2">Held</th><th /></tr>
              </thead>
              <tbody>
                {lines.map((l) => {
                  const awaiting = l.sent - l.approved - l.held;
                  return (
                    <tr key={l.id} className="border-t border-kraft-100">
                      <td className="px-2 py-2 font-mono font-bold">{l.part_no_snapshot}</td>
                      <td className="px-2 py-2 font-mono font-bold">{awaiting}</td>
                      <td className="px-2 py-2 font-mono">{l.approved}</td>
                      <td className="px-2 py-2">
                        {l.held > 0 ? (
                          <span className="flex items-center gap-2">
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-bold text-amber-800">{l.held} held</span>
                            <button onClick={() => reopen(l.id)} className="btn-secondary !px-2 !py-1">Re-open</button>
                          </span>
                        ) : '—'}
                      </td>
                      <td className="px-2 py-2">
                        {awaiting > 0 && <button onClick={() => startInspect(l)} className="btn-primary !px-2 !py-1">Inspect</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {inspectingLine && (
              <div className="mt-4 rounded-md border border-dashed border-kraft-300 bg-kraft-50 p-4">
                <div className="mb-2 text-sm font-bold">Inspecting {inspectingLine.part_no_snapshot}</div>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Accepted Quantity"><input type="number" value={accepted} onChange={(e) => setAccepted(e.target.value)} className="input" /></Field>
                  <div className="col-span-2">
                    <Field label="Comments"><textarea value={comments} onChange={(e) => setComments(e.target.value)} className="input min-h-[40px]" /></Field>
                  </div>
                </div>
                <div className="mt-3 flex justify-end gap-2">
                  <button onClick={() => setInspectingId(null)} className="btn-secondary">Cancel</button>
                  <button onClick={submitInspection} disabled={busy} className="btn-primary">{busy ? 'Saving…' : 'Sign Off Inspection'}</button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="mb-1 block text-[11px] font-bold text-ink-700">{label}</label>{children}</div>;
}

'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { STATUS_LABEL } from '@/lib/statusLabels';
import type { WorkOrder, WorkOrderLine, Shift, ProductionOutputLine, QcSubmission } from '@sgr/types';

interface LineRow extends WorkOrderLine {
  produced: number;
  sentToQc: number;
}

export default function PlannerPage() {
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [lines, setLines] = useState<LineRow[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [error, setError] = useState('');

  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [shiftId, setShiftId] = useState('');
  const [labour, setLabour] = useState('6');
  const [entryValues, setEntryValues] = useState<Record<string, { qty: string; weight: string; note: string }>>({});
  const [submitting, setSubmitting] = useState(false);

  const [newCompletionDate, setNewCompletionDate] = useState('');
  const [editingDate, setEditingDate] = useState(false);

  const selected = orders.find((o) => o.id === selectedId) ?? null;

  const loadOrders = useCallback(async () => {
    const { data } = await supabase.from('work_orders').select('*').not('status', 'in', '("draft","completed","cancelled")').order('created_at');
    setOrders(data ?? []);
    if (!selectedId && data && data.length) setSelectedId(data[0]!.id);
  }, [selectedId]);

  const loadLines = useCallback(async (woId: string) => {
    const { data: ls } = await supabase.from('work_order_lines').select('*').eq('work_order_id', woId).order('line_no');
    const lineIds = (ls ?? []).map((l) => l.id);
    const [{ data: prod }, { data: sub }] = await Promise.all([
      lineIds.length ? supabase.from('production_output_lines').select('*').in('work_order_line_id', lineIds) : Promise.resolve({ data: [] as ProductionOutputLine[] }),
      lineIds.length ? supabase.from('qc_submissions').select('*').in('work_order_line_id', lineIds) : Promise.resolve({ data: [] as QcSubmission[] }),
    ]);
    setLines((ls ?? []).map((l) => ({
      ...l,
      produced: (prod ?? []).filter((p) => p.work_order_line_id === l.id).reduce((n, p) => n + Number(p.qty), 0),
      sentToQc: (sub ?? []).filter((s) => s.work_order_line_id === l.id).reduce((n, s) => n + Number(s.qty), 0),
    })));
  }, []);

  useEffect(() => { loadOrders(); supabase.from('shifts').select('*').order('code').then(({ data }) => { setShifts(data ?? []); if (data?.length) setShiftId(data[0]!.id); }); }, [loadOrders]);
  useEffect(() => { if (selectedId) loadLines(selectedId); }, [selectedId, loadLines]);

  async function submitEntry() {
    if (!selected) return;
    setSubmitting(true); setError('');
    const payload = {
      work_order_id: selected.id, production_date: entryDate, shift_id: shiftId, labour_count: Number(labour),
      lines: lines.filter((l) => entryValues[l.id]?.qty).map((l) => ({
        work_order_line_id: l.id, qty: Number(entryValues[l.id]!.qty),
        actual_weight_kg: Number(entryValues[l.id]!.weight || 0), note: entryValues[l.id]!.note,
      })),
    };
    const { error } = await supabase.rpc('record_production', { p: payload });
    setSubmitting(false);
    if (error) { setError(error.message); return; }
    setEntryValues({});
    loadLines(selected.id); loadOrders();
  }

  async function sendToQc(lineId: string) {
    setError('');
    const { error } = await supabase.rpc('send_line_to_qc', { p_work_order_line_id: lineId });
    if (error) { setError(error.message); return; }
    loadLines(selected!.id); loadOrders();
  }

  async function saveCompletionDate() {
    if (!selected) return;
    const { error } = await supabase.from('work_orders').update({ expected_completion_date: newCompletionDate || null }).eq('id', selected.id);
    if (error) { setError(error.message); return; }
    setEditingDate(false);
    loadOrders();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold text-forest-900">Production Planner</h1>
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="input max-w-xs">
          {orders.map((o) => <option key={o.id} value={o.id}>{o.wo_number} — {STATUS_LABEL[o.status]}</option>)}
        </select>
      </div>
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}
      {!selected && <p className="text-sm text-ink-500">Nothing in the ready-for-production queue.</p>}

      {selected && (
        <>
          <section className="rounded-lg border border-kraft-200 bg-white p-5">
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold text-ink-700">Expected Completion Date:</span>
              {!editingDate ? (
                <>
                  <span className="font-bold">{selected.expected_completion_date ?? '—'}</span>
                  <button onClick={() => { setEditingDate(true); setNewCompletionDate(selected.expected_completion_date ?? ''); }} className="btn-secondary !px-2 !py-1">Change</button>
                </>
              ) : (
                <>
                  <input type="date" value={newCompletionDate} onChange={(e) => setNewCompletionDate(e.target.value)} className="input w-auto" />
                  <button onClick={() => setEditingDate(false)} className="btn-secondary !px-2 !py-1">Cancel</button>
                  <button onClick={saveCompletionDate} className="btn-primary !px-2 !py-1">Save</button>
                </>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-kraft-200 bg-white">
            <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">ITEM PROGRESS</div>
            <div className="overflow-x-auto p-5">
              <table className="w-full text-xs">
                <thead className="bg-kraft-100 text-left font-bold uppercase text-ink-900">
                  <tr><th className="px-2 py-2">Part #</th><th className="px-2 py-2">Ordered</th><th className="px-2 py-2">Produced</th><th className="px-2 py-2">Sent to QC</th><th /></tr>
                </thead>
                <tbody>
                  {lines.map((l) => {
                    const unsent = l.produced - l.sentToQc;
                    return (
                      <tr key={l.id} className="border-t border-kraft-100">
                        <td className="px-2 py-2 font-mono font-bold">{l.part_no_snapshot}</td>
                        <td className="px-2 py-2 font-mono">{l.qty}</td>
                        <td className="px-2 py-2 font-mono">{l.produced}</td>
                        <td className="px-2 py-2 font-mono">{l.sentToQc}</td>
                        <td className="px-2 py-2">
                          {unsent > 0
                            ? <button onClick={() => sendToQc(l.id)} className="btn-secondary !px-2 !py-1">Send {unsent} to QC</button>
                            : <span className="text-ink-300">Nothing to send</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-lg border border-kraft-200 bg-white">
            <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">RECORD TODAY&rsquo;S PRODUCTION</div>
            <div className="p-5">
              <div className="mb-4 grid grid-cols-3 gap-3">
                <Field label="Production Date"><input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} className="input" /></Field>
                <Field label="Shift">
                  <select value={shiftId} onChange={(e) => setShiftId(e.target.value)} className="input">
                    {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label="Labour Count"><input type="number" value={labour} onChange={(e) => setLabour(e.target.value)} className="input" /></Field>
              </div>
              {lines.map((l) => {
                const remaining = l.qty - l.produced;
                const v = entryValues[l.id] ?? { qty: '', weight: '', note: '' };
                return (
                  <div key={l.id} className="flex flex-wrap items-end gap-3 border-b border-kraft-100 py-3 last:border-none">
                    <div className="min-w-[200px] flex-1 text-xs">
                      <div className="font-bold">{l.part_no_snapshot} — {l.description_snapshot}</div>
                      <div className="text-ink-500">{remaining} remaining of {l.qty}</div>
                    </div>
                    {remaining > 0 ? (
                      <>
                        <Field label="Qty Produced"><input type="number" value={v.qty} onChange={(e) => setEntryValues((s) => ({ ...s, [l.id]: { ...v, qty: e.target.value } }))} className="input w-28" /></Field>
                        <Field label="Actual Weight (kg)"><input type="number" step="0.1" value={v.weight} onChange={(e) => setEntryValues((s) => ({ ...s, [l.id]: { ...v, weight: e.target.value } }))} className="input w-32" /></Field>
                        <Field label="Note"><input value={v.note} onChange={(e) => setEntryValues((s) => ({ ...s, [l.id]: { ...v, note: e.target.value } }))} className="input" /></Field>
                      </>
                    ) : <span className="text-xs font-bold text-emerald-600">✓ Fully produced</span>}
                  </div>
                );
              })}
              <div className="mt-4 flex justify-end">
                <button onClick={submitEntry} disabled={submitting} className="btn-primary">{submitting ? 'Saving…' : 'Save Daily Entry'}</button>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="mb-1 block text-[11px] font-bold text-ink-700">{label}</label>{children}</div>;
}

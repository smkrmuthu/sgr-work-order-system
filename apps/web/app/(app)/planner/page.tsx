'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { STATUS_LABEL } from '@/lib/statusLabels';
import type { WorkOrder, WorkOrderLine, Shift, Supervisor, CompletionDateChange, ProductionOutputLine, QcSubmission } from '@sgr/types';

interface LogEntry {
  id: string;
  production_date: string;
  created_at: string;
  labour_count: number | null;
  shift?: { name: string } | null;
  supervisor?: { name: string } | null;
  planner?: { full_name: string | null } | null;
  production_output_lines?: { qty: number }[];
}
interface DateChange extends CompletionDateChange { by?: { full_name: string | null } | null }

interface LineRow extends WorkOrderLine {
  produced: number;
  sentToQc: number;
}

export default function PlannerPage() {
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [lines, setLines] = useState<LineRow[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [supervisors, setSupervisors] = useState<Supervisor[]>([]);
  const [supervisorId, setSupervisorId] = useState('');
  const [log, setLog] = useState<LogEntry[]>([]);
  const [dateChanges, setDateChanges] = useState<DateChange[]>([]);
  const [error, setError] = useState('');

  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [shiftId, setShiftId] = useState('');
  const [labour, setLabour] = useState('6');
  const [entryValues, setEntryValues] = useState<Record<string, { qty: string; weight: string; note: string }>>({});
  const [submitting, setSubmitting] = useState(false);

  const [newCompletionDate, setNewCompletionDate] = useState('');
  const [editingDate, setEditingDate] = useState(false);
  const [dateReason, setDateReason] = useState('');

  const selected = orders.find((o) => o.id === selectedId) ?? null;

  const loadOrders = useCallback(async () => {
    // pending_finance_approval is excluded too: production can't be recorded until Finance approves.
    const { data } = await supabase.from('work_orders').select('*')
      .not('status', 'in', '("draft","pending_finance_approval","completed","cancelled")').order('created_at');
    setOrders(data ?? []);
    // The Dashboard's "Open in Planner" link arrives with ?id=<work order>.
    const wanted = new URLSearchParams(window.location.search).get('id');
    if (!selectedId && data && data.length) setSelectedId(data.find((o) => o.id === wanted)?.id ?? data[0]!.id);
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

  // Production entries and completion-date changes recorded against the selected order.
  const loadHistory = useCallback(async (woId: string) => {
    const [{ data: entries }, { data: changes }] = await Promise.all([
      supabase.from('production_entries')
        .select('id, production_date, created_at, labour_count, shift:shifts(name), supervisor:supervisors(name), planner:users(full_name), production_output_lines(qty)')
        .eq('work_order_id', woId).order('created_at', { ascending: false }),
      supabase.from('completion_date_changes').select('*, by:users(full_name)').eq('work_order_id', woId).order('changed_at', { ascending: false }),
    ]);
    setLog((entries ?? []) as unknown as LogEntry[]);
    setDateChanges((changes ?? []) as unknown as DateChange[]);
  }, []);

  useEffect(() => { supabase.from('supervisors').select('*').eq('is_active', true).order('name').then(({ data }) => setSupervisors(data ?? [])); }, []);
  useEffect(() => { loadOrders(); supabase.from('shifts').select('*').order('code').then(({ data }) => { setShifts(data ?? []); if (data?.length) setShiftId(data[0]!.id); }); }, [loadOrders]);
  useEffect(() => { if (selectedId) { loadLines(selectedId); loadHistory(selectedId); } }, [selectedId, loadLines, loadHistory]);

  async function submitEntry() {
    if (!selected) return;
    if (!supervisorId) { setError('Choose the Supervisor for this production entry.'); return; }
    setSubmitting(true); setError('');
    const payload = {
      work_order_id: selected.id, production_date: entryDate, shift_id: shiftId, supervisor_id: supervisorId, labour_count: Number(labour),
      lines: lines.filter((l) => entryValues[l.id]?.qty).map((l) => ({
        work_order_line_id: l.id, qty: Number(entryValues[l.id]!.qty),
        actual_weight_kg: Number(entryValues[l.id]!.weight || 0), note: entryValues[l.id]!.note,
      })),
    };
    const { error } = await supabase.rpc('record_production', { p: payload });
    setSubmitting(false);
    if (error) { setError(error.message); return; }
    setEntryValues({});
    loadLines(selected.id); loadOrders(); loadHistory(selected.id);
  }

  async function sendToQc(lineId: string) {
    setError('');
    const { error } = await supabase.rpc('send_line_to_qc', { p_work_order_line_id: lineId });
    if (error) { setError(error.message); return; }
    loadLines(selected!.id); loadOrders();
  }

  async function saveCompletionDate() {
    if (!selected) return;
    setError('');
    if (!newCompletionDate) { setError('Choose a date.'); return; }
    if (newCompletionDate === selected.expected_completion_date) { setEditingDate(false); return; }
    // The first date needs no reason; changing a date that is already set always does (the database enforces it too).
    if (selected.expected_completion_date && !dateReason.trim()) { setError('Please give a reason for changing the Planned Completion Date.'); return; }
    const { error } = await supabase.rpc('set_completion_date', { p_work_order_id: selected.id, p_date: newCompletionDate, p_reason: dateReason.trim() || null });
    if (error) { setError(error.message); return; }
    setEditingDate(false); setDateReason('');
    loadOrders(); loadHistory(selected.id);
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
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-bold text-ink-700">Planned Completion Date:</span>
              {!editingDate ? (
                <>
                  <span className="font-bold">{selected.expected_completion_date ?? '—'}</span>
                  <button onClick={() => { setEditingDate(true); setError(''); setDateReason(''); setNewCompletionDate(''); }} className="btn-secondary !px-2 !py-1">
                    {selected.expected_completion_date ? 'Change' : 'Set date'}
                  </button>
                </>
              ) : (
                <div className="flex w-full flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xs font-bold text-ink-700">Current:</span>
                    <span className="font-bold">{selected.expected_completion_date ?? 'not set'}</span>
                    <span className="text-ink-300">→</span>
                    <span className="text-xs font-bold text-ink-700">New date:</span>
                    <input type="date" min={new Date().toISOString().slice(0, 10)} value={newCompletionDate} onChange={(e) => setNewCompletionDate(e.target.value)} className="input w-auto" />
                    {selected.expected_completion_date && newCompletionDate && newCompletionDate !== selected.expected_completion_date && (
                      <span className="rounded-md bg-amber-50 px-2 py-1 font-mono text-xs font-bold text-amber-900">
                        {selected.expected_completion_date} → {newCompletionDate}
                      </span>
                    )}
                  </div>
                  {selected.expected_completion_date && (
                    <div className="max-w-xl">
                      <label className="mb-1 block text-[11px] font-bold text-ink-700">Reason for the change *</label>
                      <input value={dateReason} onChange={(e) => setDateReason(e.target.value)} placeholder="Why is the completion date changing?" className="input" />
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button onClick={() => setEditingDate(false)} className="btn-secondary !px-2 !py-1">Cancel</button>
                    <button onClick={saveCompletionDate} className="btn-primary !px-2 !py-1">Save</button>
                  </div>
                </div>
              )}
            </div>
            {dateChanges.length > 0 && (
              <div className="mt-4 border-t border-kraft-100 pt-3">
                <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-500">Completion date history</div>
                <ul className="flex flex-col gap-1 text-xs">
                  {dateChanges.map((c) => (
                    <li key={c.id}>
                      <span className="font-mono font-bold">{c.from_date ?? 'not set'} → {c.to_date}</span>
                      {c.reason ? <> · {c.reason}</> : <span className="text-ink-500"> · first date set</span>}
                      <span className="text-ink-500"> · {c.by?.full_name ?? 'Unknown'}, {new Date(c.changed_at).toLocaleString('en-IN')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
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
              <div className="mb-4 grid grid-cols-1 sm:grid-cols-4 gap-3">
                <Field label="Production Date"><input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} className="input" /></Field>
                <Field label="Shift">
                  <select value={shiftId} onChange={(e) => setShiftId(e.target.value)} className="input">
                    {shifts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </Field>
                <Field label="Supervisor *">
                  <select value={supervisorId} onChange={(e) => setSupervisorId(e.target.value)} className="input">
                    <option value="">{supervisors.length ? 'Select supervisor…' : 'No supervisors yet'}</option>
                    {supervisors.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {supervisors.length === 0 && <div className="mt-1 text-[10px] text-ink-500">Ask the MD to add supervisors in Item Master → Supervisors.</div>}
                </Field>
                <Field label="Labour Count"><input type="number" value={labour} onChange={(e) => setLabour(e.target.value)} className="input" /></Field>
              </div>
              {lines.map((l) => {
                const remaining = l.qty - l.produced;
                const v = entryValues[l.id] ?? { qty: '', weight: '', note: '' };
                const stdWeight = Number(l.standard_weight_kg_snapshot || 0);
                const calcWeight =
                  v.qty && !isNaN(Number(v.qty))
                    ? (Number(v.qty) * stdWeight).toFixed(2)
                    : '';
                return (
                  <div key={l.id} className="flex flex-wrap items-end gap-3 border-b border-kraft-100 py-3 last:border-none">
                    <div className="min-w-[200px] flex-1 text-xs">
                      <div className="font-bold">{l.part_no_snapshot} — {l.description_snapshot}</div>
                      <div className="text-ink-500">{remaining} remaining of {l.qty} {stdWeight > 0 ? `· Std wt: ${stdWeight} kg/unit` : ''}</div>
                    </div>
                    {remaining > 0 ? (
                      <>
                        <Field label="Qty Produced"><input type="number" value={v.qty} onChange={(e) => setEntryValues((s) => ({ ...s, [l.id]: { ...v, qty: e.target.value } }))} className="input w-28" /></Field>
                        <Field label="Actual Weight (kg)"><input type="number" step="0.1" value={v.weight} onChange={(e) => setEntryValues((s) => ({ ...s, [l.id]: { ...v, weight: e.target.value } }))} className="input w-32" /></Field>
                        <Field label="Calculated Weight (kg)">
                          <input
                            type="text"
                            readOnly
                            disabled
                            value={calcWeight ? `${calcWeight}` : ''}
                            placeholder="0.00"
                            className="input w-36 font-mono disabled:bg-kraft-100 disabled:text-ink-700 disabled:cursor-not-allowed"
                          />
                        </Field>
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

          <section className="rounded-lg border border-kraft-200 bg-white">
            <div className="border-b border-kraft-100 px-5 py-3 text-sm font-bold text-forest-900">PRODUCTION LOG</div>
            <div className="overflow-x-auto p-5">
              <table className="w-full text-xs">
                <thead className="bg-kraft-100 text-left font-bold uppercase text-ink-900">
                  <tr><th className="px-2 py-2">Date</th><th className="px-2 py-2">Shift</th><th className="px-2 py-2">Supervisor</th><th className="px-2 py-2">Labour</th><th className="px-2 py-2">Qty Produced</th><th className="px-2 py-2">Recorded by</th></tr>
                </thead>
                <tbody>
                  {log.length === 0 && <tr><td colSpan={6} className="px-2 py-6 text-center text-ink-500">Nothing recorded yet.</td></tr>}
                  {log.map((e) => (
                    <tr key={e.id} className="border-t border-kraft-100">
                      <td className="px-2 py-2 font-mono">{e.production_date}</td>
                      <td className="px-2 py-2">{e.shift?.name ?? '—'}</td>
                      <td className="px-2 py-2">{e.supervisor?.name ?? <span className="text-ink-300">—</span>}</td>
                      <td className="px-2 py-2 font-mono">{e.labour_count ?? '—'}</td>
                      <td className="px-2 py-2 font-mono">{(e.production_output_lines ?? []).reduce((n, o) => n + Number(o.qty), 0)}</td>
                      <td className="px-2 py-2">{e.planner?.full_name ?? '—'} <span className="text-ink-500">· {new Date(e.created_at).toLocaleString('en-IN')}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
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

'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import type { BusinessPartner, DeliveryLocation, Part, Category, WorkOrder } from '@sgr/types';

interface LineRow {
  key: string;
  part: Part;
  qty: number;
  remarks: string;
  customerRef: string;
}

// One form for both jobs: /work-orders/new starts a blank Work Order; /work-orders/new?id=<uuid> edits
// one you already created — allowed until Finance approves it (draft, or waiting for Finance).
// A query param rather than a path segment because this is a static export (see detail/page.tsx).
export default function NewWorkOrderPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-500">Loading…</p>}>
      <WorkOrderForm />
    </Suspense>
  );
}

function WorkOrderForm() {
  const router = useRouter();
  const editId = useSearchParams().get('id');
  const { profile } = useAuth();
  const [editing, setEditing] = useState<WorkOrder | null>(null);
  const [rejection, setRejection] = useState('');
  const [editBlocked, setEditBlocked] = useState('');
  const [refReady, setRefReady] = useState(false);

  const [partners, setPartners] = useState<BusinessPartner[]>([]);
  const [locations, setLocations] = useState<DeliveryLocation[]>([]);
  const [parts, setParts] = useState<Part[]>([]);
  const allPartsRef = useRef<Part[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);

  const [draftId, setDraftId] = useState<string | null>(null);
  const [partnerId, setPartnerId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [woDate, setWoDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [deliveryDate, setDeliveryDate] = useState('');
  const [docRef, setDocRef] = useState('');
  const [testCert, setTestCert] = useState(false);
  const [inspectionReport, setInspectionReport] = useState(false);
  const [packingRequired, setPackingRequired] = useState(true);
  const [bundleQty, setBundleQty] = useState('50');
  const [palletHeight, setPalletHeight] = useState('46');
  const [separateVehicle, setSeparateVehicle] = useState(false);
  const [transportNotes, setTransportNotes] = useState('');
  // Additional notes are separate points, not a paragraph (each one becomes a row in work_order_notes).
  const [notes, setNotes] = useState<string[]>([]);
  const [noteInput, setNoteInput] = useState('');

  const [lines, setLines] = useState<LineRow[]>([]);
  const [newPartId, setNewPartId] = useState('');
  const [newQty, setNewQty] = useState('');
  const [newRemarks, setNewRemarks] = useState('');
  const [newCustomerRef, setNewCustomerRef] = useState('');

  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const [{ data: p }, { data: l }, { data: parts }, { data: cats }] = await Promise.all([
        supabase.from('business_partners').select('*').order('name'),
        supabase.from('delivery_locations').select('*'),
        supabase.from('parts').select('*').order('part_no'),
        supabase.from('categories').select('*'),
      ]);
      setPartners(p ?? []);
      setLocations(l ?? []);
      setParts(parts ?? []);
      allPartsRef.current = parts ?? [];
      setCategories(cats ?? []);
      setRefReady(true);
    })();
  }, []);

  // Editing an existing order: load it once the reference data is in.
  useEffect(() => {
    if (!editId || !refReady || !profile) return;
    (async () => {
      const [{ data: wo }, { data: ls }, { data: ns }, { data: rej }] = await Promise.all([
        supabase.from('work_orders').select('*').eq('id', editId).maybeSingle(),
        supabase.from('work_order_lines').select('*').eq('work_order_id', editId).order('line_no'),
        supabase.from('work_order_notes').select('*').eq('work_order_id', editId).order('position'),
        supabase.from('finance_approvals').select('*').eq('work_order_id', editId).eq('action', 'rejected').order('created_at', { ascending: false }).limit(1),
      ]);
      if (!wo) { setEditBlocked('Work order not found.'); return; }
      if (wo.created_by !== profile.id) { setEditBlocked('Only the person who created this Work Order can edit it here.'); return; }
      if (wo.status !== 'draft' && wo.status !== 'pending_finance_approval') {
        setEditBlocked('Finance has already approved this Work Order, so it can no longer be edited here. Ask the MD.');
        return;
      }
      setEditing(wo);
      setDraftId(wo.id);
      setPartnerId(wo.partner_id ?? '');
      setLocationId(wo.delivery_location_id ?? '');
      setWoDate(wo.wo_date);
      setDeliveryDate(wo.delivery_date ?? '');
      setDocRef(wo.doc_ref ?? '');
      setTestCert(wo.test_cert_required);
      setInspectionReport(wo.inspection_report_required);
      setPackingRequired(wo.packing_required);
      setBundleQty(wo.units_per_bundle != null ? String(wo.units_per_bundle) : '');
      setPalletHeight(wo.pallet_height_in != null ? String(wo.pallet_height_in) : '');
      setSeparateVehicle(wo.separate_vehicle_required);
      setTransportNotes(wo.transport_notes ?? '');
      setNotes((ns ?? []).map((n) => n.note));
      const partById = new Map(allPartsRef.current.map((p) => [p.id, p]));
      setLines((ls ?? []).flatMap((l) => {
        const part = l.part_id ? partById.get(l.part_id) : undefined;
        return part ? [{ key: l.id, part, qty: Number(l.qty), remarks: l.remarks ?? '', customerRef: l.customer_ref ?? '' }] : [];
      }));
      if (wo.status === 'draft' && rej && rej[0]?.comments) setRejection(rej[0].comments);
    })();
    // profile?.id, not profile: AuthProvider hands back a brand-new profile object on every auth event,
    // including a background token refresh — depending on the object itself re-ran this fetch mid-edit
    // and silently overwrote whatever the user had typed with the still-unsaved database values.
  }, [editId, refReady, profile?.id]);

  const partnerLocations = useMemo(
    () => locations.filter((l) => l.partner_id === partnerId && (l.is_active || l.id === locationId)),
    [locations, partnerId, locationId],
  );
  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? '';

  // A note that's been typed but not yet added with Enter/"+ Add note" still counts when saving.
  const allNotes = () => (noteInput.trim() ? [...notes, noteInput.trim()] : notes);

  const payload = () => ({
    partner_id: partnerId || undefined,
    delivery_location_id: locationId || undefined,
    wo_date: woDate,
    delivery_date: deliveryDate || undefined,
    doc_ref: docRef || undefined,
    test_cert_required: testCert,
    inspection_report_required: inspectionReport,
    notes: allNotes().map((text) => ({ text })),
    packing_required: packingRequired,
    units_per_bundle: bundleQty ? Number(bundleQty) : undefined,
    pallet_height_in: palletHeight ? Number(palletHeight) : undefined,
    separate_vehicle_required: separateVehicle,
    transport_notes: transportNotes || undefined,
    lines: lines.map((l) => ({
      part_id: l.part.id, qty: l.qty, remarks: l.remarks || undefined,
      // sent even when blank, so clearing the box doesn't silently fall back to the Item Master's value
      customer_ref: l.customerRef,
    })),
  });

  async function saveDraft(): Promise<string | null> {
    setSaving(true);
    setError('');
    const { data, error } = await supabase.rpc('save_draft', { p_id: draftId, p: payload() });
    setSaving(false);
    if (error) { setError(error.message); return null; }
    setDraftId(data as string);
    setNotes(allNotes());
    setNoteInput('');
    setMessage('Draft saved just now.');
    return data as string;
  }

  function addLine() {
    const part = parts.find((p) => p.id === newPartId);
    const qty = parseFloat(newQty);
    if (!part || !qty || qty <= 0) return;
    setLines((ls) => [...ls, { key: crypto.randomUUID(), part, qty, remarks: newRemarks, customerRef: newCustomerRef.trim() }]);
    setNewPartId(''); setNewQty(''); setNewRemarks(''); setNewCustomerRef('');
  }

  function addNote() {
    const text = noteInput.trim();
    if (!text) return;
    setNotes((ns) => [...ns, text]);
    setNoteInput('');
  }

  async function createWorkOrder() {
    setCreating(true);
    setError('');
    const id = await saveDraft();
    if (!id) { setCreating(false); return; }
    const { data, error } = await supabase.rpc('create_work_order', { p_id: id });
    setCreating(false);
    if (error) { setError(error.message); return; }
    const wo = Array.isArray(data) ? data[0] : data;
    router.push(`/work-orders/detail?id=${wo.id}`);
  }

  // Editing an order that is already waiting for Finance: save, then go back to it (it stays pending).
  async function saveChanges() {
    const id = await saveDraft();
    if (id) router.push(`/work-orders/detail?id=${id}`);
  }

  const totalQty = lines.reduce((n, l) => n + l.qty, 0);
  const totalWeight = lines.reduce((n, l) => n + l.qty * l.part.standard_weight_kg, 0);
  const totalValue = lines.reduce((n, l) => n + l.qty * l.part.price, 0);
  const selectedNewPart = parts.find((p) => p.id === newPartId);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold text-forest-900">
          {editing ? <>Edit Work Order {editing.wo_number && <span className="font-mono">{editing.wo_number}</span>}</> : 'New Work Order'}
        </h1>
        <p className="text-sm text-ink-500">
          {editing?.status === 'pending_finance_approval'
            ? 'This order is waiting for Finance. You can change anything until it is approved; saving keeps it in the Finance queue.'
            : editing
              ? 'Fix the details, then resubmit it for Finance approval.'
              : `Fill in the details, then add the first line item. Saved as a Draft as you go; the Work Order number is
                 assigned when you press Create (v1.3 §3.4) — it then goes to Finance for approval before
                 production can start.`}
        </p>
      </div>

      {editBlocked && <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{editBlocked}</div>}
      {rejection && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <b>Finance sent this back:</b> {rejection}
        </div>
      )}
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}

      <section className="rounded-lg border border-kraft-200 bg-white">
        <div className="border-b border-kraft-100 px-5 py-3">
          <div className="text-sm font-bold text-forest-900">A · WORK ORDER HEADER</div>
        </div>
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-3">
          <Field label="WO Date">
            <input type="date" value={woDate} onChange={(e) => setWoDate(e.target.value)} className="input" />
          </Field>
          <Field label="Document Reference">
            <input value={docRef} onChange={(e) => setDocRef(e.target.value)} placeholder="Optional" className="input" />
          </Field>
          <div />
          <Field label="Business Partner (Vendor) *">
            <select value={partnerId} onChange={(e) => { setPartnerId(e.target.value); setLocationId(''); }} className="input">
              <option value="">Select vendor…</option>
              {partners.filter((p) => p.is_active || p.id === partnerId).map((p) => <option key={p.id} value={p.id}>{p.code} — {p.name}</option>)}
            </select>
          </Field>
          <Field label="Delivery Location *">
            <select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={!partnerId} className="input">
              <option value="">{partnerId ? 'Select delivery location…' : 'Select vendor first'}</option>
              {partnerLocations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </Field>
          <Field label="Delivery Date *">
            <input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} className="input" />
          </Field>
        </div>
      </section>

      <section className="rounded-lg border border-kraft-200 bg-white">
        <div className="border-b border-kraft-100 px-5 py-3">
          <div className="text-sm font-bold text-forest-900">B · LINE ITEMS</div>
          <div className="text-xs text-ink-500">Part # fills description, UOM, weight, category and price from the Part Master.</div>
        </div>
        <div className="p-5">
          <table className="w-full text-xs">
            <thead className="bg-kraft-100 text-left font-bold uppercase text-ink-900">
              <tr>
                <th className="px-2 py-2">Part #</th><th className="px-2 py-2">Description</th><th className="px-2 py-2">Customer Ref</th><th className="px-2 py-2">Qty</th>
                <th className="px-2 py-2">Price</th><th className="px-2 py-2">Line Total</th><th className="px-2 py-2">Remarks</th><th />
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && (
                <tr><td colSpan={8} className="px-2 py-6 text-center text-ink-500">No line items yet — add one below.</td></tr>
              )}
              {lines.map((l) => (
                <tr key={l.key} className="border-t border-kraft-100">
                  <td className="px-2 py-2 font-mono font-bold">{l.part.part_no}</td>
                  <td className="px-2 py-2">{l.part.description}</td>
                  <td className="px-2 py-2 font-mono">{l.customerRef || '—'}</td>
                  <td className="px-2 py-2 font-mono">{l.qty}</td>
                  <td className="px-2 py-2 font-mono">₹{l.part.price.toFixed(2)}</td>
                  <td className="px-2 py-2 font-mono font-bold">₹{(l.qty * l.part.price).toLocaleString('en-IN')}</td>
                  <td className="px-2 py-2">{l.remarks || '—'}</td>
                  <td className="px-2 py-2">
                    <button onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="text-ink-300 hover:text-rose-600">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md border border-dashed border-kraft-300 bg-kraft-50 p-3">
            <div className="min-w-[220px] flex-1">
              <label className="mb-1 block text-[11px] font-bold text-ink-700">Part #</label>
              <select
                value={newPartId}
                onChange={(e) => {
                  setNewPartId(e.target.value);
                  // prefill from the Item Master; still editable for this line
                  setNewCustomerRef(parts.find((p) => p.id === e.target.value)?.customer_ref ?? '');
                }}
                className="input"
              >
                <option value="">Select part #…</option>
                {parts.filter((p) => p.is_active).map((p) => <option key={p.id} value={p.id}>{p.part_no} — {p.description}</option>)}
              </select>
            </div>
            <div className="w-24">
              <label className="mb-1 block text-[11px] font-bold text-ink-700">Qty</label>
              <input type="number" min={1} value={newQty} onChange={(e) => setNewQty(e.target.value)} className="input" />
            </div>
            <div className="w-40">
              <label className="mb-1 block text-[11px] font-bold text-ink-700">Customer Ref</label>
              <input value={newCustomerRef} onChange={(e) => setNewCustomerRef(e.target.value)} className="input" />
            </div>
            <div className="min-w-[160px] flex-1">
              <label className="mb-1 block text-[11px] font-bold text-ink-700">Remarks</label>
              <input value={newRemarks} onChange={(e) => setNewRemarks(e.target.value)} className="input" />
            </div>
            <button onClick={addLine} disabled={!newPartId || !newQty} className="btn-primary">+ Add Line</button>
          </div>
          {selectedNewPart && (
            <div className="mt-2 flex gap-4 text-[11px] text-ink-700">
              <span>UOM: <b>{selectedNewPart.uom}</b></span>
              <span>Weight: <b>{selectedNewPart.standard_weight_kg} kg</b></span>
              <span>Category: <b>{categoryName(selectedNewPart.category_id)}</b></span>
              <span>Price: <b>₹{selectedNewPart.price.toFixed(2)}</b></span>
            </div>
          )}

          <div className="mt-4 grid grid-cols-3 gap-3">
            <Tile label="TOTAL QUANTITY" value={`${totalQty.toLocaleString('en-IN')} Nos`} />
            <Tile label="ESTIMATED WEIGHT" value={`${totalWeight.toFixed(1)} kg`} />
            <Tile label="ESTIMATED ORDER VALUE" value={`₹${totalValue.toLocaleString('en-IN')}`} />
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-kraft-200 bg-white">
        <div className="border-b border-kraft-100 px-5 py-3">
          <div className="text-sm font-bold text-forest-900">C · QUALITY, PACKING &amp; TRANSPORT REQUIREMENTS</div>
        </div>
        <div className="grid grid-cols-1 gap-6 p-5 sm:grid-cols-2">
          <div className="flex flex-col gap-3">
            <Toggle label="Test Certificate Required" checked={testCert} onChange={setTestCert} />
            <Toggle label="Inspection Report Required" checked={inspectionReport} onChange={setInspectionReport} />
            <Field label="Additional Notes">
              <ol className="mb-2 flex flex-col gap-1.5">
                {notes.length === 0 && <li className="text-xs text-ink-300">No notes yet — add each point separately.</li>}
                {notes.map((n, i) => (
                  <li key={i} className="flex items-start gap-2 rounded-md border border-kraft-200 bg-kraft-50 px-2.5 py-1.5 text-[12.5px]">
                    <span className="mt-px font-mono text-[11px] font-bold text-ink-500">{i + 1}.</span>
                    <span className="flex-1 break-words">{n}</span>
                    <button
                      type="button"
                      onClick={() => setNotes((ns) => ns.filter((_, j) => j !== i))}
                      aria-label={`Remove note ${i + 1}`}
                      className="text-ink-300 hover:text-rose-600"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ol>
              <div className="flex gap-2">
                <input
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addNote(); } }}
                  placeholder="Type a note and press Enter"
                  className="input"
                />
                <button type="button" onClick={addNote} disabled={!noteInput.trim()} className="btn-secondary whitespace-nowrap">+ Add note</button>
              </div>
            </Field>
          </div>
          <div className="flex flex-col gap-3">
            <Toggle label="Packing List Required" checked={packingRequired} onChange={setPackingRequired} />
            {packingRequired && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Units per Bundle"><input type="number" value={bundleQty} onChange={(e) => setBundleQty(e.target.value)} className="input" /></Field>
                <Field label="Pallet Height (in)"><input type="number" value={palletHeight} onChange={(e) => setPalletHeight(e.target.value)} className="input" /></Field>
              </div>
            )}
            <Toggle label="Separate Vehicle Required" checked={separateVehicle} onChange={setSeparateVehicle} />
            <Field label="Special Instructions">
              <textarea value={transportNotes} onChange={(e) => setTransportNotes(e.target.value)} className="input min-h-[64px]" />
            </Field>
          </div>
        </div>
      </section>

      <div className="flex items-center justify-between pb-8">
        <div className="flex items-center gap-3">
          {editing?.status === 'pending_finance_approval' ? (
            <button onClick={() => router.push(`/work-orders/detail?id=${editing.id}`)} className="btn-secondary">Cancel</button>
          ) : (
            <button onClick={saveDraft} disabled={saving || !!editBlocked} className="btn-secondary">{saving ? 'Saving…' : 'Save Draft'}</button>
          )}
          {message && <span className="text-xs font-bold text-emerald-600">✓ {message}</span>}
        </div>
        {editing?.status === 'pending_finance_approval' ? (
          <button onClick={saveChanges} disabled={saving || !!editBlocked} className="btn-primary">{saving ? 'Saving…' : 'Save Changes'}</button>
        ) : (
          <button onClick={createWorkOrder} disabled={creating || !!editBlocked} className="btn-primary">
            {creating ? 'Submitting…' : editing ? 'Resubmit for Finance Approval' : 'Create Work Order'}
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-bold text-ink-700">{label}</label>
      {children}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-kraft-200 bg-kraft-50 px-3 py-3">
      <div className="text-[10px] font-bold text-ink-500">{label}</div>
      <div className="font-mono text-lg font-bold text-forest-900">{value}</div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between border-b border-kraft-100 py-2">
      <span className="text-[12.5px] font-semibold text-ink-900">{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-5 w-9 accent-forest-600" />
    </label>
  );
}

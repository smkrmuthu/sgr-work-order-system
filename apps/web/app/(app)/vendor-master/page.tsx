'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { BusinessPartner, DeliveryLocation, PartnerAddress, PartnerContact } from '@sgr/types';

// Master Creator / MD / Admin (see NAV in the layout); the master-data tables are writable only by those
// roles (db/migrations/002_rls.sql). The Work Order's Business Partner dropdown reads this list.
// Nothing is hard-deleted: a vendor or location is deactivated, so old Work Orders keep their history.
//
// Storage: Business Partner -> business_partners; Contact Person/Phone/Email -> its primary
// partner_contacts row; Location + Address -> a partner_addresses row plus the delivery_locations row
// (the "Delivery Location" dropdown on a Work Order) that points at it.

type VendorForm = { code: string; name: string; contact_name: string; phone: string; email: string };
const EMPTY: VendorForm = { code: '', name: '', contact_name: '', phone: '', email: '' };
type LocForm = { label: string; address: string };
const EMPTY_LOC: LocForm = { label: '', address: '' };

export default function VendorMasterPage() {
  const [partners, setPartners] = useState<BusinessPartner[] | null>(null);
  const [contacts, setContacts] = useState<PartnerContact[]>([]);
  const [addresses, setAddresses] = useState<PartnerAddress[]>([]);
  const [locations, setLocations] = useState<DeliveryLocation[]>([]);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const [form, setForm] = useState<VendorForm>(EMPTY);
  const [locForm, setLocForm] = useState<LocForm>(EMPTY_LOC);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const [p, c, a, l] = await Promise.all([
      supabase.from('business_partners').select('*').order('name'),
      supabase.from('partner_contacts').select('*'),
      supabase.from('partner_addresses').select('*'),
      supabase.from('delivery_locations').select('*').order('label'),
    ]);
    const err = p.error || c.error || a.error || l.error;
    if (err) { setError(err.message); return; }
    setPartners(p.data ?? []);
    setContacts(c.data ?? []);
    setAddresses(a.data ?? []);
    setLocations(l.data ?? []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const primaryContact = (pid: string) =>
    contacts.find((c) => c.partner_id === pid && c.is_primary) ?? contacts.find((c) => c.partner_id === pid);
  const addressOf = (l: DeliveryLocation) => addresses.find((a) => a.id === l.address_id);
  const locsOf = (pid: string) => locations.filter((l) => l.partner_id === pid);
  const addressText = (l: DeliveryLocation) => {
    const a = addressOf(l);
    return a ? [a.line1, a.city].filter(Boolean).join(', ') : '—';
  };

  function startNew() { setForm(EMPTY); setLocForm(EMPTY_LOC); setEditingId('new'); setError(''); }
  function startEdit(p: BusinessPartner) {
    const c = primaryContact(p.id);
    setForm({ code: p.code, name: p.name, contact_name: c?.name ?? '', phone: c?.phone ?? '', email: c?.email ?? '' });
    setLocForm(EMPTY_LOC);
    setEditingId(p.id); setError('');
  }

  const emailOk = (s: string) => !s || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

  // Saves the vendor and its primary contact. For a new vendor, the first Location/Address (if filled in)
  // is saved with it. Returns the partner id, or null after setting an error.
  async function saveVendor(): Promise<string | null> {
    const code = form.code.trim().toUpperCase(), name = form.name.trim();
    if (!code || !name) { setError('Vendor code and name are required.'); return null; }
    if (!emailOk(form.email.trim())) { setError('Enter a valid email address.'); return null; }

    let pid = editingId as string;
    if (editingId === 'new') {
      const { data, error } = await supabase.from('business_partners')
        .insert({ code, name, is_customer: true, is_supplier: false }).select('id').single();
      if (error) { setError(/duplicate|unique/i.test(error.message) ? 'That vendor code already exists.' : error.message); return null; }
      pid = data.id;
    } else {
      const { error } = await supabase.from('business_partners').update({ code, name }).eq('id', pid);
      if (error) { setError(/duplicate|unique/i.test(error.message) ? 'That vendor code already exists.' : error.message); return null; }
    }

    const contact = {
      name: form.contact_name.trim(), phone: form.phone.trim() || null, email: form.email.trim() || null,
    };
    const existing = primaryContact(pid);
    if (contact.name || contact.phone || contact.email) {
      // partner_contacts.name is required; fall back to the vendor name when only a phone/email is given.
      const row = { ...contact, name: contact.name || name };
      const { error } = existing
        ? await supabase.from('partner_contacts').update(row).eq('id', existing.id)
        : await supabase.from('partner_contacts').insert({ ...row, partner_id: pid, is_primary: true });
      if (error) { setError(error.message); return null; }
    } else if (existing) {
      const { error } = await supabase.from('partner_contacts').delete().eq('id', existing.id);
      if (error) { setError(error.message); return null; }
    }
    return pid;
  }

  async function addLocation(pid: string): Promise<boolean> {
    const label = locForm.label.trim(), address = locForm.address.trim();
    if (!label && !address) return true; // nothing to add
    if (!label || !address) { setError('Location and Address must both be filled to add a location.'); return false; }
    const { data: a, error: ae } = await supabase.from('partner_addresses')
      .insert({ partner_id: pid, kind: 'delivery', line1: address, is_primary: locsOf(pid).length === 0 })
      .select('id').single();
    if (ae) { setError(ae.message); return false; }
    const { error: le } = await supabase.from('delivery_locations').insert({ partner_id: pid, address_id: a.id, label });
    if (le) { setError(le.message); return false; }
    return true;
  }

  async function save() {
    setSaving(true); setError('');
    const pid = await saveVendor();
    if (pid && await addLocation(pid)) {
      setEditingId(null); setLocForm(EMPTY_LOC);
    } else if (pid && editingId === 'new') {
      setEditingId(pid); // vendor exists now; keep the form open so the location can be fixed and re-saved
    }
    setSaving(false);
    load();
  }

  async function toggleActive(table: 'business_partners' | 'delivery_locations', id: string, is_active: boolean) {
    setError('');
    const { error } = await supabase.from(table).update({ is_active: !is_active }).eq('id', id);
    if (error) { setError(error.message); return; }
    load();
  }

  const shown = (partners ?? []).filter((p) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return p.code.toLowerCase().includes(s) || p.name.toLowerCase().includes(s);
  });
  const set = (k: keyof VendorForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-forest-900">Vendor Master</h1>
          <p className="text-sm text-ink-500">
            Business partners / clients offered on Work Orders, with their delivery locations and contact.
            Editing a vendor never changes an existing Work Order.
          </p>
        </div>
        <button onClick={startNew} className="btn-primary">+ Add Vendor</button>
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</div>}

      {editingId && (
        <section className="rounded-lg border border-kraft-200 bg-white p-5">
          <div className="mb-3 text-sm font-bold text-forest-900">{editingId === 'new' ? 'NEW VENDOR' : 'EDIT VENDOR'}</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Vendor Code *"><input value={form.code} onChange={set('code')} placeholder="ABC01" className="input" /></Field>
            <div className="col-span-2 sm:col-span-3"><Field label="Business Partner / Client Name *"><input value={form.name} onChange={set('name')} className="input" /></Field></div>
            <Field label="Contact Person"><input value={form.contact_name} onChange={set('contact_name')} className="input" /></Field>
            <Field label="Contact Phone"><input value={form.phone} onChange={set('phone')} className="input" /></Field>
            <div className="col-span-2"><Field label="Email"><input type="email" value={form.email} onChange={set('email')} className="input" /></Field></div>
          </div>

          <div className="mb-2 mt-5 text-sm font-bold text-forest-900">LOCATIONS &amp; ADDRESSES</div>
          {editingId !== 'new' && locsOf(editingId).length > 0 && (
            <table className="mb-3 w-full text-sm">
              <thead className="bg-kraft-100 text-left text-[11px] font-bold uppercase tracking-wide text-ink-900">
                <tr><th className="px-3 py-2">Location</th><th className="px-3 py-2">Address</th><th className="px-3 py-2 text-center">Active</th></tr>
              </thead>
              <tbody>
                {locsOf(editingId).map((l) => (
                  <tr key={l.id} className={`border-t border-kraft-100 ${l.is_active ? '' : 'opacity-50'}`}>
                    <td className="px-3 py-2">{l.label}</td>
                    <td className="px-3 py-2">{addressText(l)}</td>
                    <td className="px-3 py-2 text-center"><input type="checkbox" checked={l.is_active} onChange={() => toggleActive('delivery_locations', l.id, l.is_active)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label={editingId === 'new' ? 'Location' : 'Add another location'}>
              <input value={locForm.label} onChange={(e) => setLocForm((f) => ({ ...f, label: e.target.value }))} placeholder="e.g. Chennai Plant" className="input" />
            </Field>
            <div className="col-span-2 sm:col-span-3">
              <Field label="Address">
                <input value={locForm.address} onChange={(e) => setLocForm((f) => ({ ...f, address: e.target.value }))} className="input" />
              </Field>
            </div>
          </div>

          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setEditingId(null)} className="btn-secondary">Cancel</button>
            <button onClick={save} disabled={saving} className="btn-primary">{saving ? 'Saving…' : 'Save Vendor'}</button>
          </div>
        </section>
      )}

      <input placeholder="Search by vendor code or name…" value={q} onChange={(e) => setQ(e.target.value)}
        className="w-full max-w-md rounded-md border border-kraft-300 px-3 py-2 text-sm outline-none focus:border-forest-500" />

      <div className="overflow-x-auto rounded-lg border border-kraft-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-kraft-100 text-left text-[11px] font-bold uppercase tracking-wide text-ink-900">
            <tr>
              <th className="px-3 py-2">Code</th><th className="px-3 py-2">Business Partner / Client</th>
              <th className="px-3 py-2">Location / Address</th><th className="px-3 py-2">Contact Person</th>
              <th className="px-3 py-2">Phone</th><th className="px-3 py-2">Email</th>
              <th className="px-3 py-2 text-center">Active</th><th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {partners === null && <tr><td colSpan={8} className="px-3 py-8 text-center text-ink-500">Loading…</td></tr>}
            {partners !== null && shown.length === 0 && <tr><td colSpan={8} className="px-3 py-8 text-center text-ink-500">No vendors found.</td></tr>}
            {shown.map((p) => {
              const c = primaryContact(p.id);
              const locs = locsOf(p.id);
              return (
                <tr key={p.id} className={`border-t border-kraft-100 align-top ${p.is_active ? '' : 'opacity-50'}`}>
                  <td className="px-3 py-2 font-mono font-bold">{p.code}</td>
                  <td className="px-3 py-2">{p.name}</td>
                  <td className="px-3 py-2">
                    {locs.length === 0 ? '—' : locs.map((l) => (
                      <div key={l.id} className={l.is_active ? '' : 'opacity-50'}>
                        <span className="font-bold">{l.label}</span> <span className="text-ink-500">— {addressText(l)}</span>
                      </div>
                    ))}
                  </td>
                  <td className="px-3 py-2">{c?.name ?? '—'}</td>
                  <td className="px-3 py-2">{c?.phone ?? '—'}</td>
                  <td className="px-3 py-2">{c?.email ?? '—'}</td>
                  <td className="px-3 py-2 text-center"><input type="checkbox" checked={p.is_active} onChange={() => toggleActive('business_partners', p.id, p.is_active)} /></td>
                  <td className="px-3 py-2 text-right"><button onClick={() => startEdit(p)} className="btn-secondary !px-2 !py-1">Edit</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
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

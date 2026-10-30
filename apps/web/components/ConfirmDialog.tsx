'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export interface ConfirmOptions {
  title: string;
  message?: string;          // may contain line breaks
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;          // red confirm button; the safer "cancel" button gets the initial focus
}
type Ask = (options: ConfirmOptions) => Promise<boolean>;
type Open = ConfirmOptions & { resolve: (ok: boolean) => void };

// Falls back to the browser's own box if a screen is ever rendered outside the provider.
const ConfirmContext = createContext<Ask>(async (o) => window.confirm(o.message ? `${o.title}\n\n${o.message}` : o.title));

/** askConfirm({ title, message, confirmLabel, danger }) resolves true when the person confirms, false otherwise. */
export const useConfirm = () => useContext(ConfirmContext);

// The app's own confirmation box (replaces the browser's confirm()): same look as the rest of the app, keyboard
// friendly (Esc cancels, Tab stays inside the box), and focus returns to where it was when the box closes.
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Open | null>(null);
  const openRef = useRef<Open | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  openRef.current = open;

  const ask = useCallback<Ask>((options) => new Promise<boolean>((resolve) => {
    openRef.current?.resolve(false);                       // a second request cancels the first
    returnFocus.current = document.activeElement as HTMLElement | null;
    setOpen({ ...options, resolve });
  }), []);

  const close = useCallback((ok: boolean) => {
    openRef.current?.resolve(ok);
    setOpen(null);
    returnFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    if (!open) return;
    (open.danger ? cancelBtn : confirmBtn).current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
      if (e.key !== 'Tab') return;
      const a = cancelBtn.current, b = confirmBtn.current;
      if (!a || !b) return;
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
      else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {open && (
        <div
          className="no-print fixed inset-0 z-[100] flex items-center justify-center bg-ink-900/50 px-4"
          onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}
        >
          <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby={open.message ? 'confirm-message' : undefined}
            className="w-full max-w-md rounded-lg border border-kraft-200 bg-white p-5 shadow-xl">
            <h2 id="confirm-title" className="text-base font-bold text-forest-900">{open.title}</h2>
            {open.message && <p id="confirm-message" className="mt-2 whitespace-pre-line text-sm text-ink-700">{open.message}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button ref={cancelBtn} type="button" onClick={() => close(false)} className="btn-secondary">{open.cancelLabel ?? 'Cancel'}</button>
              <button ref={confirmBtn} type="button" onClick={() => close(true)}
                className={open.danger ? 'btn-primary !bg-rose-700 hover:!bg-rose-800' : 'btn-primary'}>{open.confirmLabel ?? 'Confirm'}</button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

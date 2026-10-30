'use client';

import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

const CONTROLS = ['input', 'select', 'textarea'];

// A labelled form field. When the field's single child is an input, select or textarea, the label is tied to it
// (htmlFor + id), so clicking the label focuses the control and screen readers read the label out.
export default function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  const auto = useId();
  let id: string | undefined;
  let child = children;
  if (isValidElement(children) && typeof children.type === 'string' && CONTROLS.includes(children.type)) {
    const el = children as ReactElement<{ id?: string }>;
    id = el.props.id ?? auto;
    if (!el.props.id) child = cloneElement(el, { id });
  }
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1 block text-[11px] font-bold text-ink-700">{label}</label>
      {child}
    </div>
  );
}

import type { WoStatus } from '@sgr/types';

// Same lifecycle across every screen (v1.3 §7), one source of truth for its label/order/color.
// UPDATED 28 Sep 2026: a Finance approval gate sits between Draft and Created — see README.
export const STATUS_ORDER: WoStatus[] = [
  'pending_finance_approval',
  'created',
  'in_production',
  'qc_pending',
  'partially_qc_approved',
  'ready_for_dispatch',
  'completed',
];

export const STATUS_LABEL: Record<WoStatus, string> = {
  draft: 'Draft',
  pending_finance_approval: 'Pending Finance Approval',
  created: 'Created',
  in_production: 'In Production',
  qc_pending: 'QC Pending',
  partially_qc_approved: 'Partially QC Approved',
  ready_for_dispatch: 'Finished Goods', // all ordered qty QC-approved; billing/dispatch are tracked per invoice (see the Dispatch tab)
  completed: 'Completed / Closed',
  cancelled: 'Cancelled',
};

export const STATUS_BADGE_CLASS: Record<WoStatus, string> = {
  draft: 'bg-kraft-100 text-kraft-900 border-kraft-300',
  pending_finance_approval: 'bg-violet-50 text-violet-800 border-violet-200',
  created: 'bg-amber-50 text-amber-800 border-amber-200',
  in_production: 'bg-amber-50 text-amber-800 border-amber-200',
  qc_pending: 'bg-amber-50 text-amber-800 border-amber-200',
  partially_qc_approved: 'bg-amber-50 text-amber-800 border-amber-200',
  ready_for_dispatch: 'bg-blue-50 text-blue-800 border-blue-200',
  completed: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  cancelled: 'bg-rose-50 text-rose-800 border-rose-200',
};

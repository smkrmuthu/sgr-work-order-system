// Who may see prices on screen. Production (Planner) and QC logins see no price anywhere in the app, and the same
// goes for anyone whose role is not known yet (so a price never flashes up before the role has loaded).
// This is a display rule; the one price the database itself withholds from those roles is Customer Price (018).
export const PRICE_ROLES = ['creator', 'md', 'admin', 'finance'] as const;
export const canSeePrices = (role?: string | null): boolean => (PRICE_ROLES as readonly string[]).includes(role ?? '');

// Today's date as YYYY-MM-DD on the user's own clock. `new Date().toISOString().slice(0, 10)` is the UTC date, which
// is still "yesterday" in India between midnight and 5:30 am (a night shift, or 1 April's financial-year change).
export function todayLocal(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

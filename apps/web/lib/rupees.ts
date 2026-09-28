// 1234567.5 -> "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Rupees and Fifty Paise Only" (Indian grouping).
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below1000(n: number): string {
  const parts: string[] = [];
  if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} Hundred`); n %= 100; }
  if (n >= 20) { parts.push(TENS[Math.floor(n / 10)]!); n %= 10; }
  if (n > 0) parts.push(ONES[n]!);
  return parts.join(' ');
}

function wholeNumber(n: number): string {
  if (n === 0) return 'Zero';
  const units: [number, string][] = [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']];
  const out: string[] = [];
  for (const [size, name] of units) {
    if (n >= size) { out.push(`${below1000(Math.floor(n / size))} ${name}`); n %= size; }
  }
  if (n > 0) out.push(below1000(n));
  return out.join(' ');
}

export function rupeesInWords(amount: number): string {
  const paise = Math.round(amount * 100);
  const rupees = Math.floor(paise / 100), p = paise % 100;
  let words = `${wholeNumber(rupees)} ${rupees === 1 ? 'Rupee' : 'Rupees'}`;
  if (p > 0) words += ` and ${wholeNumber(p)} Paise`;
  return `${words} Only`;
}

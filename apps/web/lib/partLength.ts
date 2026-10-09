// A part's length in mm, read from the end of its Item Master description ("EB 54 X 54 X 5 X 142mm" -> 142).
// Only the profile parts (EB… angle boards, RP… profiles) have a length; cartons, pads, cores etc. return null
// because the last number in their description is a size, not a length.
export function partLengthMm(description: string): number | null {
  if (!/^\s*(EB|RP)\b/i.test(description)) return null;
  const m = description.match(/(\d+(?:\.\d+)?)\s*(?:mm)?\s*$/i);
  return m ? Number(m[1]) : null;
}

// Total length for a line, in metres.
export const lineLengthM = (description: string, qty: number): number => ((partLengthMm(description) ?? 0) * qty) / 1000;

export const fmtMeters = (m: number): string => `${m.toLocaleString('en-IN', { maximumFractionDigits: 2 })} m`;

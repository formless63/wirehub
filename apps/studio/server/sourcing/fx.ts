/**
 * One converted build cost from per-currency totals, read from the reference-rate snapshot the
 * optional fx-rates module saves on a design (`extensions['fx-rates']`: EUR-based rates, the
 * observation date and the target currency the user chose). Never fetched, never required: no
 * valid snapshot, or a total in a currency it lacks, gives nothing.
 */

export interface ConvertedTotal {
  amount: number;
  currency: string;
  /** the snapshot's observation date */
  date: string;
  source: string;
}

const CODE = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const record = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const rate = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

export function convertedTotal(totals: Readonly<Record<string, number>>, saved: unknown): ConvertedTotal | undefined {
  const settings = record(saved);
  const snapshot = record(settings?.['snapshot']);
  const rates = record(snapshot?.['rates']);
  const target = settings?.['target'];
  const date = snapshot?.['date'];
  const source = snapshot?.['source'];
  if (settings?.['schema'] !== 1 || snapshot?.['base'] !== 'EUR' || rates === undefined || typeof target !== 'string' || !CODE.test(target) || typeof date !== 'string' || !DATE.test(date) || typeof source !== 'string') return undefined;
  const perEur = (code: string): number | undefined => (code === 'EUR' ? 1 : rate(rates[code]));
  const to = perEur(target);
  const entries = Object.entries(totals);
  if (to === undefined || entries.length === 0) return undefined;
  let amount = 0;
  for (const [code, value] of entries) {
    const from = code === target ? to : CODE.test(code) ? perEur(code) : undefined;
    if (from === undefined || !Number.isFinite(value)) return undefined;
    amount += (value / from) * to;
  }
  return { amount: Math.round(amount * 100) / 100, currency: target, date, source: source.slice(0, 200) };
}

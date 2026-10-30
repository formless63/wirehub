/** Presentation fallbacks never expose database keys while records load or after removal. */
const OPAQUE = /^(?:[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}|(?:sha256:)?[a-f\d]{24,})$/i;
export function displayName(value: string | undefined | null, fallback = 'Unnamed item'): string {
  const text = value?.trim();
  return !text || OPAQUE.test(text) ? fallback : text;
}

/** Names are for people; stable keys are assigned automatically and retained on edits. */
export function newRecordId(label: string, taken: readonly string[], prefix = 'item'): string {
  const base = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || prefix;
  const used = new Set(taken);
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

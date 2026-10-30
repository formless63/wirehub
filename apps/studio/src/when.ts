/**
 * Times for people: always the viewer's own time zone, one format everywhere
 * (`2026-10-05 14:03`). Stored values stay ISO/UTC; show the ISO text in a
 * `title` (`title={iso}`) so the exact instant is one hover away.
 */
const pad = (n: number): string => String(n).padStart(2, '0');

/** `2026-10-05 14:03` (or `14:03:07` with `seconds`) in the viewer's time zone; the input back when it is not a date. */
export function localDateTime(iso: string, seconds = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`;
}

/** `2026-10-05` in the viewer's time zone. */
export function localDate(iso: string): string {
  return localDateTime(iso).slice(0, 10);
}

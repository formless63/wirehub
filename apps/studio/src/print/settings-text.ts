/** Slicer settings as `key = value` lines, for the profile and tweak editors. */
export type SettingValue = string | number | boolean;

export function settingsText(settings: Record<string, SettingValue>): string {
  return Object.entries(settings).map(([k, v]) => `${k} = ${String(v)}`).join('\n');
}

export function parseSettings(text: string): Record<string, SettingValue> | string {
  const out: Record<string, SettingValue> = {};
  for (const [n, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) return `line ${n + 1}: write key = value`;
    const k = line.slice(0, at).trim();
    const v = line.slice(at + 1).trim();
    out[k] = v === 'true' ? true : v === 'false' ? false : v !== '' && Number.isFinite(Number(v)) && !/^0\d/.test(v) ? Number(v) : v;
  }
  return out;
}

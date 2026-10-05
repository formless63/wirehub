/**
 * The pack lifecycle as the browser sees it (`/api/packs`, `server/packs.ts`):
 * what is installed, the update diff, disable, and install from a file or URL.
 * Answers keep the server's whole body (plans, references, problems), because
 * a refusal here carries the list the person has to act on.
 */

export interface RecordRef {
  file: string;
  id: string;
  kind: string;
  label?: string;
}
export interface FieldChange {
  path: string;
  before?: unknown;
  after?: unknown;
}
export interface PackDiff {
  added: RecordRef[];
  changed: (RecordRef & { fields: FieldChange[] })[];
  removed: RecordRef[];
  unchanged: number;
}
export interface PackReference {
  from: RecordRef;
  field: string;
  to: string;
}
export interface PackPlan {
  pack: { id: string; name?: string; version?: string; from?: string; to?: string; license: string };
  diff?: PackDiff;
  major?: boolean;
  licenseChanged?: boolean;
  conflicts?: string[];
  references?: PackReference[];
  /** records the new version drops that something outside the pack still uses: kept, as the deployment's own */
  retired?: RecordRef[];
  issues?: { code: string; message: string }[];
  records?: RecordRef[];
  unmetRequires?: string[];
  ok: boolean;
}
export interface InstalledPackView {
  id: string;
  version: string;
  license: string;
  records: number;
  module?: string;
  available?: string;
}
export interface PackAnswer {
  ok: boolean;
  status: number;
  /** the server's sentence, when it refused */
  error?: string;
  hint?: string;
  body: Record<string, unknown>;
}

async function call(method: string, path: string, body?: unknown): Promise<PackAnswer> {
  try {
    const response = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    const parsed = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    return {
      ok: response.ok,
      status: response.status,
      ...(typeof parsed['error'] === 'string' ? { error: parsed['error'] } : {}),
      ...(typeof parsed['hint'] === 'string' ? { hint: parsed['hint'] } : {}),
      body: parsed,
    };
  } catch (error) {
    return { ok: false, status: 0, error: 'The studio could not reach the workbench.', hint: error instanceof Error ? error.message : String(error), body: {} };
  }
}

const enc = encodeURIComponent;

export const listPacks = (base = '/api'): Promise<PackAnswer> => call('GET', `${base}/packs`);
export const previewUpdate = (id: string, base = '/api'): Promise<PackAnswer> => call('GET', `${base}/packs/${enc(id)}/update`);
export const applyUpdate = (id: string, acceptMajor: boolean, base = '/api'): Promise<PackAnswer> => call('POST', `${base}/packs/${enc(id)}/update`, { acceptMajor });
export const previewDisable = (id: string, base = '/api'): Promise<PackAnswer> => call('GET', `${base}/packs/${enc(id)}/references`);
export const disablePack = (id: string, base = '/api'): Promise<PackAnswer> => call('DELETE', `${base}/packs/${enc(id)}`);

/** What the person gave Install pack…: an uploaded file (zip or JSON bundle) or a URL. */
export type PackSource = { url: string } | { zip: string } | { bundle: unknown };

/** An uploaded file as a pack source: a zip travels base64, a JSON bundle as itself. */
export async function sourceOfFile(file: File): Promise<PackSource> {
  const buffer: ArrayBuffer =
    typeof file.arrayBuffer === 'function'
      ? await file.arrayBuffer()
      : await new Promise<ArrayBuffer>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as ArrayBuffer);
          reader.onerror = () => reject(reader.error);
          reader.readAsArrayBuffer(file);
        });
  const bytes = new Uint8Array(buffer);
  const zip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (zip) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { zip: btoa(binary) };
  }
  return { bundle: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
}

export const previewInstall = (source: PackSource, base = '/api'): Promise<PackAnswer> => call('POST', `${base}/packs/install`, source);
export const applyInstall = (source: PackSource, sha256: string, acceptMajor: boolean, base = '/api'): Promise<PackAnswer> =>
  call('POST', `${base}/packs/install`, { ...source, apply: true, sha256, acceptMajor });

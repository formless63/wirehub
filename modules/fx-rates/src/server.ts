import type { IntegrationContribution } from '@wirehub/modules';
import { snapshotProblems } from './logic.ts';
import type { FxSnapshot } from './types.ts';

export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 10_000;

/** Only the small daily ECB XML grammar is accepted; no entities, DTDs or general XML execution. */
export function parseEcbXml(xml: string, retrievedAt: string): FxSnapshot {
  if (new TextEncoder().encode(xml).byteLength > MAX_BYTES || /<!|&/.test(xml)) throw new Error('ECB response is invalid.');
  const body = xml.trim().replace(/^<\?xml version=(["'])1\.0\1 encoding=(["'])UTF-8\2\?>\s*/, '');
  const envelope = body.match(/^<gesmes:Envelope\s+xmlns:gesmes="http:\/\/www\.gesmes\.org\/xml\/2002-08-01"\s+xmlns="http:\/\/www\.ecb\.int\/vocabulary\/2002-08-01\/eurofxref"\s*>\s*<gesmes:subject>Reference rates<\/gesmes:subject>\s*<gesmes:Sender>\s*<gesmes:name>European Central Bank<\/gesmes:name>\s*<\/gesmes:Sender>\s*<Cube>\s*<Cube\s+time=(["'])(\d{4}-\d{2}-\d{2})\1\s*>([\s\S]*?)<\/Cube>\s*<\/Cube>\s*<\/gesmes:Envelope>$/);
  if (envelope === null) throw new Error('ECB response is invalid.');
  let remaining = envelope[3]!.trim();
  const rates: Record<string, number> = {};
  let count = 0;
  while (remaining !== '') {
    const row = remaining.match(/^<Cube\s+currency=(["'])([A-Z]{3})\1\s+rate=(["'])(\d+(?:\.\d+)?)\3\s*\/>\s*/);
    if (row === null || row[2] === 'EUR' || Object.hasOwn(rates, row[2]!) || ++count > 200) throw new Error('ECB response is invalid.');
    rates[row[2]!] = Number(row[4]);
    remaining = remaining.slice(row[0].length);
  }
  const snapshot: FxSnapshot = { base: 'EUR', date: envelope[2]!, rates, source: ECB_DAILY_URL, retrievedAt };
  if (snapshotProblems(snapshot).length > 0) throw new Error('ECB response is invalid.');
  return snapshot;
}

export interface EcbOptions { fetch?: typeof globalThis.fetch; now?: () => Date }

/** Manual only: nothing fetches at module import, design load, revision render or report generation. */
export async function fetchLatest(options: EcbOptions = {}): Promise<FxSnapshot> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('ECB request timed out.')); }, TIMEOUT_MS);
  });
  const request = async (): Promise<FxSnapshot> => {
    const response = await (options.fetch ?? globalThis.fetch)(ECB_DAILY_URL, { headers: { accept: 'application/xml' }, redirect: 'error', signal: controller.signal });
    if (!response.ok || response.redirected) throw new Error('ECB request failed.');
    if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('ECB response is too large.');
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('ECB response is invalid.');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new Error('ECB response is too large.');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let xml: string;
    try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('ECB response is invalid.'); }
    return parseEcbXml(xml, (options.now ?? (() => new Date()))().toISOString());
  };
  try { return await Promise.race([request(), deadline]); }
  catch (error) {
    controller.abort();
    const message = error instanceof Error && /^ECB (?:request (?:failed|timed out)|response is (?:invalid|too large))\.$/.test(error.message) ? error.message : 'ECB request failed.';
    throw new Error(message);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function createFxIntegration(options: EcbOptions = {}): IntegrationContribution {
  return { id: 'ecb', label: 'ECB reference snapshot', routes: [{ method: 'GET', path: 'latest', handle: async () => {
    try { return { status: 200, body: { snapshot: await fetchLatest(options) } }; }
    catch (error) { return { status: 502, body: { error: error instanceof Error ? error.message : 'ECB request failed.' } }; }
  } }] };
}

export const fxIntegration = createFxIntegration();

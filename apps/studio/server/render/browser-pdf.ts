/**
 * The HTML sheets as PDF through a browser engine (cs-5k1.24): the build
 * sheet, the BOM, the continuity spec, the drawing sheet and a wire stock's
 * spec sheet, printed by Chromium exactly as the browser's own Print → Save as
 * PDF prints them — the `@page` size and margins, the UNRELEASED / UNAPPROVED
 * mark, the branding, the figures.
 *
 * The engine is a separate, optional service (`docs/self-hosting.md`, the
 * compose profile `pdf`): Gotenberg, an HTTP API around headless Chromium, so
 * no browser ships in the WireHub image. WireHub posts the sheet as one
 * self-contained HTML file — images are `data:` URIs already, and the fonts
 * are inlined here — and gets the PDF back. The service runs with JavaScript
 * off and every outbound address refused, so the sheet is the whole input.
 *
 * Without an engine (`WIREHUB_PDF_ENGINE_URL` unset), or when it fails, the
 * documents route falls back to the plain text-layout PDF and says so in the
 * `X-WireHub-PDF-Fallback` header (`render/index.ts`).
 */

import { sans, sansBold } from '@wirehub/docs/src/drawing/fonts.generated.ts';
import type { RuntimeSettings } from '../runtime-settings.ts';

/** Turns a self-contained HTML document into PDF bytes. */
export interface PdfEngine {
  /** where it is, for messages (no credentials: the URL is shown without user info) */
  readonly describe: string;
  htmlToPdf(html: string): Promise<Uint8Array>;
}

export class PdfEngineError extends Error {}

/** The longest a conversion may take before WireHub gives up and falls back (default). */
export const DEFAULT_PDF_ENGINE_TIMEOUT_MS = 30_000;
/** A PDF larger than this is refused (a sheet is tens or hundreds of kilobytes). */
const MAX_PDF_BYTES = 64 * 1024 * 1024;

/**
 * The sheet as it is sent: the sans faces the drawings embed (Liberation Sans,
 * metric-compatible with Helvetica and Arial: `packages/docs/fonts`) inlined,
 * standing in for Helvetica and Arial and placed first in the sheets' font stacks, so the PDF is set the same
 * whichever engine host renders it, rather than in that host's system UI font.
 * Glyphs the subset lacks fall through to the stack as before.
 */
export function printableHtml(html: string): string {
  // Helvetica and Arial too: the build sheet's bench names them before the stack
  const face = (family: string, weight: 'normal' | 'bold', woff2: string): string =>
    `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight === 'bold' ? 700 : 400};src:url(data:font/woff2;base64,${woff2}) format('woff2')}`;
  const faces = ['CS Sans', 'Helvetica', 'Arial'].map((family) => face(family, 'normal', sans.woff2) + face(family, 'bold', sansBold.woff2)).join('');
  // the hub's own typeface (branding) travels inline in the sheet as 'CS Brand': keep it first
  const stack = `${html.includes("font-family:'CS Brand'") ? `'CS Brand',` : ''}'IBM Plex Sans','CS Sans',Helvetica,Arial,sans-serif`;
  const style =
    `<style data-wirehub-print-fonts>${faces}` +
    // the design sheets read --cs-font; the wire spec sheet names its stack on .cs-ws
    `.cs-root{--cs-font:${stack}}.cs-ws{font-family:${stack}}</style>`;
  const at = html.search(/<\/head>/i);
  if (at >= 0) return `${html.slice(0, at)}${style}${html.slice(at)}`;
  return `${style}${html}`;
}

function redact(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
}

/** Parse an engine URL; throws a sentence naming the variable when it is not an http(s) address. */
export function parseEngineUrl(raw: string, variable = 'WIREHUB_PDF_ENGINE_URL'): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} is not a URL. Set it to the engine's address, such as http://pdf:3000.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${variable} must be an http or https address, not ${url.protocol}.`);
  return url;
}

export interface GotenbergOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Gotenberg's Chromium route (`POST /forms/chromium/convert/html`): the sheet
 * as `index.html`, its own `@page` size and margins preferred, backgrounds
 * printed (the zebra rows, the marks).
 */
export function gotenbergEngine(base: string | URL, options: GotenbergOptions = {}): PdfEngine {
  const url = typeof base === 'string' ? parseEngineUrl(base) : base;
  const endpoint = new URL('forms/chromium/convert/html', url.href.endsWith('/') ? url.href : `${url.href}/`);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PDF_ENGINE_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const describe = redact(url);
  return {
    describe,
    async htmlToPdf(html) {
      const form = new FormData();
      form.append('files', new Blob([printableHtml(html)], { type: 'text/html' }), 'index.html');
      form.append('preferCssPageSize', 'true');
      form.append('printBackground', 'true');
      // the sheet's @page margins are the page's; nothing is added around them
      for (const side of ['marginTop', 'marginBottom', 'marginLeft', 'marginRight']) form.append(side, '0');
      let res: Response;
      try {
        res = await fetchImpl(endpoint, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        throw new PdfEngineError(timedOut ? `the engine at ${describe} did not answer within ${Math.round(timeoutMs / 1000)} s` : `the engine at ${describe} could not be reached (${error instanceof Error ? error.message : String(error)})`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (res.status !== 200) {
        const said = new TextDecoder().decode(bytes.subarray(0, 200)).trim();
        throw new PdfEngineError(`the engine at ${describe} answered ${res.status}${said === '' ? '' : `: ${said}`}`);
      }
      if (bytes.length > MAX_PDF_BYTES) throw new PdfEngineError(`the engine at ${describe} returned ${bytes.length} bytes, more than a sheet can be`);
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new PdfEngineError(`the engine at ${describe} did not return a PDF`);
      return bytes;
    },
  };
}

/**
 * `WIREHUB_PDF_ENGINE_URL` (and `WIREHUB_PDF_ENGINE_TIMEOUT_MS`): the engine,
 * or `undefined` when none is set. Throws a sentence when a value is wrong, so
 * a typo stops the start instead of silently printing the plain PDFs.
 */
export function pdfEngineFromEnv(env: Readonly<Record<string, string | undefined>>): PdfEngine | undefined {
  const raw = env['WIREHUB_PDF_ENGINE_URL']?.trim() ?? '';
  if (raw === '') return undefined;
  const url = parseEngineUrl(raw);
  const timeoutText = env['WIREHUB_PDF_ENGINE_TIMEOUT_MS']?.trim() ?? '';
  let timeoutMs = DEFAULT_PDF_ENGINE_TIMEOUT_MS;
  if (timeoutText !== '') {
    if (!/^\d{1,7}$/.test(timeoutText) || Number(timeoutText) < 1000) throw new Error(`WIREHUB_PDF_ENGINE_TIMEOUT_MS must be a whole number of milliseconds from 1000, not '${timeoutText}'.`);
    timeoutMs = Number(timeoutText);
  }
  return gotenbergEngine(url, { timeoutMs });
}

const live = new WeakMap<RuntimeSettings, () => PdfEngine | undefined>();

/**
 * The engine the live settings name (`runtime-settings.ts`): the server's
 * `WIREHUB_PDF_ENGINE_URL`, else the URL saved in Settings → Integrations,
 * rebuilt when it changes. A value that does not parse prints the plain PDFs
 * (and says so in the log) rather than failing a download.
 */
export function livePdfEngine(settings: RuntimeSettings): PdfEngine | undefined {
  let get = live.get(settings);
  if (get === undefined) {
    get = settings.memo((env) => {
      try {
        return pdfEngineFromEnv(env);
      } catch (error) {
        console.warn(`[pdf] ${error instanceof Error ? error.message : String(error)} The plain PDFs are sent.`);
        return undefined;
      }
    });
    live.set(settings, get);
  }
  return get();
}

/** The engine a request prints with: one the host handed over, else the live settings'. */
export function pdfEngineOf(deps: { pdfEngine?: PdfEngine; runtimeSettings?: RuntimeSettings }): PdfEngine | undefined {
  return deps.pdfEngine ?? (deps.runtimeSettings === undefined ? undefined : livePdfEngine(deps.runtimeSettings));
}

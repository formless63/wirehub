/**
 * Getting a pack's files onto the server's disk from what a person hands the
 * studio: an uploaded zip, a JSON bundle, or an https URL (`packs.ts`,
 * "Install pack…").
 *
 * Everything is bounded: sizes, file counts, paths, and the URL fetch (https
 * only, a size limit, a timeout, no private addresses, redirects followed one
 * by one with the same checks). Nothing is executed or evaluated here; only `.json`
 * data files, the manifest, the images of `depictions/**` and `art/**` (svg, png,
 * jpg, webp: the type must match the bytes, SVG is stripped of anything active,
 * and each file and the total are size-limited), vendor PDFs under `docs/**` and
 * `assets/**` (a PDF header, no scripts or launch actions, size-limited), fonts under
 * `fonts/**` (ttf, otf, woff2: the header must match, size-limited, a licence sidecar
 * checked by `packSourceProblems`) and a code module's entries
 * (`code/<module>/server.mjs`, `browser.mjs`, `browser.css`: UTF-8 text,
 * size-limited; whether they may be installed at all is `code-modules/trust.ts`'s
 * decision) are kept.
 *
 * Formats:
 * - **zip**: the pack directory zipped (`wirehub-pack.json` at the top, or inside one
 *   folder). Stored or deflated entries; no encryption, no zip64.
 * - **JSON bundle**: `{ "format": 1, "manifest": { …wirehub-pack.json… }, "files": { "connectors.json": [ … ], "vocab/signals.json": { … }, "depictions/x/face.svg": "<base64>" } }`
 *   (an image's value is its bytes, base64).
 */

import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isIP } from 'node:net';
import { inflateRawSync } from 'node:zlib';

import { canonicalPackText, isPackHostControlPath } from '@wirehub/catalog';
import { stripUnsafeSvg } from '@wirehub/catalog/src/depictions/index.ts';
import { isCodeFilePath } from '@wirehub/modules';

export const MAX_PACK_BYTES = 8 * 1024 * 1024;
export const MAX_PACK_UNPACKED_BYTES = 24 * 1024 * 1024;
export const MAX_PACK_FILES = 300;
/** one image of a pack, and all of a pack's images together (decoded) */
export const MAX_PACK_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_PACK_ASSETS_TOTAL_BYTES = 12 * 1024 * 1024;
/** one vendor PDF of a pack (`docs/**`, `assets/**`), and all of a pack's PDFs together */
export const MAX_PACK_PDF_BYTES = 4 * 1024 * 1024;
export const MAX_PACK_PDFS_TOTAL_BYTES = 6 * 1024 * 1024;
/** one font of a pack (`fonts/**`), and all of a pack's fonts together */
export const MAX_PACK_FONT_BYTES = 2 * 1024 * 1024;
export const MAX_PACK_FONTS_TOTAL_BYTES = 6 * 1024 * 1024;
/** one code file of a pack (`code/<module>/…`), and all of them together */
export const MAX_PACK_CODE_BYTES = 4 * 1024 * 1024;
export const MAX_PACK_CODE_TOTAL_BYTES = 8 * 1024 * 1024;
export const PACK_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

export class PackArchiveError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'PackArchiveError';
    this.status = status;
  }
}

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

const DATA_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*\.json$/;
const ASSET_PATH = /^(?:(?:depictions|art)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+\.(?:svg|png|jpe?g|webp)|assets\/[0-9a-f]{64}\.(?:png|jpg))$/;
const IMAGE_EXTENSION = /\.(?:svg|png|jpe?g|webp)$/;
const DOC_PATH = /^(?:docs|assets)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+\.pdf$/;
const FONT_PATH = /^fonts(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+\.(?:ttf|otf|woff2)$/;
const DOC_OR_FONT_EXTENSION = /\.(?:pdf|ttf|otf|woff2)$/;
const CODE_EXTENSION = /\.(?:mjs|css)$/;

/** An image a pack may ship: under `depictions/` or `art/`, an allowlisted type, a safe path; or `assets/<sha256>.png|jpg`, an image of the shared asset library. */
export function isPackAssetPath(path: string): boolean {
  return ASSET_PATH.test(path) && path.length <= 200 && !path.split('/').includes('..');
}

/** A vendor PDF a pack may ship: under `docs/` or `assets/`, a `.pdf`, a safe path. */
export function isPackDocPath(path: string): boolean {
  return DOC_PATH.test(path) && path.length <= 200 && !path.split('/').includes('..');
}

/** A font a pack may ship: under `fonts/`, `.ttf`, `.otf` or `.woff2`, a safe path. */
export function isPackFontPath(path: string): boolean {
  return FONT_PATH.test(path) && path.length <= 200 && !path.split('/').includes('..');
}

/** A binary a pack may ship besides images and code: a vendor PDF or a font. */
export const isPackBlobPath = (path: string): boolean => isPackDocPath(path) || isPackFontPath(path);

/** A relative path a pack file may have: `.json`, an image under `depictions/`/`art/`, a vendor PDF under `docs/`/`assets/`, a font under `fonts/`, or a code module's entry under `code/`; no `..`, no dot-segments, not absolute. */
export function isPackFilePath(path: string): boolean {
  if (isPackHostControlPath(path)) return false;
  return (DATA_PATH.test(path) && path.length <= 200 && !path.split('/').includes('..')) || isPackAssetPath(path) || isPackBlobPath(path) || isCodeFilePath(path);
}

const startsWith = (b: Uint8Array, magic: number[], at = 0): boolean => magic.every((m, i) => b[at + i] === m);

/** Does the content match what the extension says? */
function imageMatchesExtension(path: string, b: Uint8Array): boolean {
  if (path.endsWith('.png')) return startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (/\.jpe?g$/.test(path)) return startsWith(b, [0xff, 0xd8, 0xff]);
  if (path.endsWith('.webp')) return startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8);
  return true;
}

/** What in a PDF would run or reach out: scripts, launch actions, embedded files, rich media, form submission. */
const ACTIVE_PDF = /\/(?:JavaScript|JS|Launch|EmbeddedFile|EmbeddedFiles|RichMedia|SubmitForm|ImportData|GoToR|GoToE)(?![A-Za-z0-9])/;

/** A vendor PDF, checked: a PDF header, and no script, launch action or embedded file (a best-effort scan: it is served as an attachment regardless). */
export function pdfProblem(bytes: Uint8Array): string | undefined {
  if (!startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'is not a PDF (it does not start with %PDF-)';
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('latin1');
  const found = ACTIVE_PDF.exec(text);
  if (found !== null) return `contains active content (${found[0]}): a vendor document is a plain PDF`;
  return undefined;
}

/** A font, checked: its header says TrueType, OpenType or WOFF2 and the extension agrees. */
export function fontProblem(path: string, bytes: Uint8Array): string | undefined {
  const sfnt = startsWith(bytes, [0x00, 0x01, 0x00, 0x00]) || startsWith(bytes, [0x74, 0x72, 0x75, 0x65]);
  const cff = startsWith(bytes, [0x4f, 0x54, 0x54, 0x4f]);
  const woff2 = startsWith(bytes, [0x77, 0x4f, 0x46, 0x32]);
  if (path.endsWith('.ttf') && !sfnt) return 'is not a TrueType font';
  if (path.endsWith('.otf') && !sfnt && !cff) return 'is not an OpenType font';
  if (path.endsWith('.woff2') && !woff2) return 'is not a WOFF2 font';
  return undefined;
}

/**
 * The images of a pack, checked: the type matches the bytes, each is within
 * `MAX_PACK_ASSET_BYTES` and all within `MAX_PACK_ASSETS_TOTAL_BYTES`, and SVG is
 * stripped of scripts, handlers, external references and the like (`stripUnsafeSvg`,
 * the safety half of the artwork upload's sanitiser; the drawing is not repainted).
 */
function checkedAssets(files: PackFiles): PackFiles {
  const out: PackFiles = new Map();
  let total = 0;
  let code = 0;
  let pdfs = 0;
  let fonts = 0;
  for (const [path, bytes] of files) {
    if (isCodeFilePath(path)) {
      if (bytes.length === 0) throw new PackArchiveError(`'${path}' is empty.`);
      if (bytes.length > MAX_PACK_CODE_BYTES) throw new PackArchiveError(`'${path}' is larger than a module's code file may be (${MAX_PACK_CODE_BYTES / 1024 / 1024} MiB).`, 413);
      code += bytes.length;
      if (code > MAX_PACK_CODE_TOTAL_BYTES) throw new PackArchiveError(`The pack's code adds up to more than a pack may carry (${MAX_PACK_CODE_TOTAL_BYTES / 1024 / 1024} MiB).`, 413);
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new PackArchiveError(`'${path}' is not UTF-8 text.`);
      }
      out.set(path, bytes);
      continue;
    }
    if (isPackDocPath(path) || isPackFontPath(path)) {
      const doc = isPackDocPath(path);
      const max = doc ? MAX_PACK_PDF_BYTES : MAX_PACK_FONT_BYTES;
      if (bytes.length === 0) throw new PackArchiveError(`'${path}' is empty.`);
      if (bytes.length > max) throw new PackArchiveError(`'${path}' is larger than a pack ${doc ? 'PDF' : 'font'} may be (${max / 1024 / 1024} MiB).`, 413);
      const problem = doc ? pdfProblem(bytes) : fontProblem(path, bytes);
      if (problem !== undefined) throw new PackArchiveError(`'${path}' ${problem}.`);
      if (doc) pdfs += bytes.length;
      else fonts += bytes.length;
      if (pdfs > MAX_PACK_PDFS_TOTAL_BYTES) throw new PackArchiveError(`The pack's PDFs add up to more than a pack may carry (${MAX_PACK_PDFS_TOTAL_BYTES / 1024 / 1024} MiB).`, 413);
      if (fonts > MAX_PACK_FONTS_TOTAL_BYTES) throw new PackArchiveError(`The pack's fonts add up to more than a pack may carry (${MAX_PACK_FONTS_TOTAL_BYTES / 1024 / 1024} MiB).`, 413);
      out.set(path, bytes);
      continue;
    }
    if (path === 'drawing-art.json') {
      out.set(path, cleanDrawingArt(bytes));
      continue;
    }
    if (!isPackAssetPath(path)) {
      out.set(path, bytes);
      continue;
    }
    if (bytes.length === 0) throw new PackArchiveError(`'${path}' is empty.`);
    if (bytes.length > MAX_PACK_ASSET_BYTES) throw new PackArchiveError(`'${path}' is larger than a pack image may be (${MAX_PACK_ASSET_BYTES / 1024 / 1024} MiB).`, 413);
    let kept = bytes;
    if (path.endsWith('.svg')) {
      const clean = stripUnsafeSvg(new TextDecoder('utf-8').decode(bytes));
      if (clean.svg === undefined) throw new PackArchiveError(`'${path}' is not a usable SVG: ${clean.error ?? 'unreadable'}.`);
      kept = new TextEncoder().encode(clean.svg);
    } else if (!imageMatchesExtension(path, bytes)) {
      throw new PackArchiveError(`'${path}' is not the kind of image its name says.`);
    }
    if (path.startsWith('assets/') && path.slice('assets/'.length, -'.xxx'.length) !== sha256(bytes)) throw new PackArchiveError(`'${path}' is named by the sha256 of its bytes, and these are not it.`);
    total += kept.length;
    if (total > MAX_PACK_ASSETS_TOTAL_BYTES) throw new PackArchiveError(`The pack's images add up to more than a pack may carry (${MAX_PACK_ASSETS_TOTAL_BYTES / 1024 / 1024} MiB).`, 413);
    out.set(path, kept);
  }
  return out;
}

/**
 * A pack's `drawing-art.json` (faces, plugs and cutaways by definition id, `DrawingArt` in `@wirehub/docs`):
 * every cutaway's SVG is stripped of scripts, handlers and external references, as a pack's images are,
 * because the sheets embed it as markup. What it holds is otherwise checked when the pack is installed.
 */
function cleanDrawingArt(bytes: Uint8Array): Uint8Array {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return bytes; // reported as invalid JSON with the pack's other files
  }
  const art = value as { cutaways?: Record<string, { svg?: unknown }> };
  if (typeof art !== 'object' || art === null || typeof art.cutaways !== 'object' || art.cutaways === null) return bytes;
  for (const [id, cutaway] of Object.entries(art.cutaways)) {
    if (typeof cutaway?.svg !== 'string') continue;
    const clean = stripUnsafeSvg(cutaway.svg);
    if (clean.svg === undefined) throw new PackArchiveError(`drawing-art.json: the cutaway '${id}' is not a usable SVG: ${clean.error ?? 'unreadable'}.`);
    cutaway.svg = clean.svg;
  }
  return encode(art);
}

/** path → bytes, as read from an archive, before anything touches disk. */
export type PackFiles = Map<string, Uint8Array>;

/* ------------------------------------------------------------------ *
 * zip
 * ------------------------------------------------------------------ */

const u16 = (b: Uint8Array, at: number): number => (b[at] as number) | ((b[at + 1] as number) << 8);
const u32 = (b: Uint8Array, at: number): number => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 3 || bytes[2] === 5);
}

/** A pack's signature file (`wirehub-pack.sig`, phase 5): kept apart from the files, at most this many bytes. */
export const PACK_SIGNATURE_FILE = 'wirehub-pack.sig';
const MAX_SIGNATURE_BYTES = 16 * 1024;

/** The files of a zip: `.json` entries and allowlisted images, a single wrapping folder stripped. */
export function readZip(bytes: Uint8Array): PackFiles {
  const raw = readZipRaw(bytes);
  raw.delete(PACK_SIGNATURE_FILE);
  return checkedAssets(raw);
}

/** The files of a zip as shipped (images not yet checked or stripped), with `wirehub-pack.sig` if there is one. */
function readZipRaw(bytes: Uint8Array): PackFiles {
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65_535); at -= 1) {
    if (u32(bytes, at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new PackArchiveError('That is not a zip file (no directory at its end).');
  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);
  if (count === 0xffff || at === 0xffffffff) throw new PackArchiveError('Zip64 archives are not supported.');
  if (count > MAX_PACK_FILES * 4) throw new PackArchiveError(`The zip has too many entries (${count}).`);
  interface Entry { name: string; flags: number; method: number; compressed: number; size: number; local: number }
  const entries: Entry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) throw new PackArchiveError('The zip directory is damaged.');
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const compressed = u32(bytes, at + 20);
    const size = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const skip = nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
    const local = u32(bytes, at + 42);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + skip;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || !(name.endsWith('.json') || IMAGE_EXTENSION.test(name) || DOC_OR_FONT_EXTENSION.test(name) || CODE_EXTENSION.test(name) || name.endsWith(PACK_SIGNATURE_FILE))) continue;
    if (name.includes('\\') || name.startsWith('/') || name.split('/').some((s) => s === '..' || s.startsWith('.'))) {
      throw new PackArchiveError(`The zip holds an unsafe path: '${name}'.`);
    }
    entries.push({ name, flags, method, compressed, size, local });
  }
  // a single wrapping folder (`pack-1.0.0/wirehub-pack.json` → `wirehub-pack.json`) is stripped first, so only the images a pack may ship are unpacked
  const names = new Set(entries.map((e) => e.name));
  const tops = new Set(entries.map((e) => e.name.split('/')[0]));
  const top = [...tops][0];
  const strip = names.has('wirehub-pack.json') || tops.size !== 1 || top === undefined || !names.has(`${top}/wirehub-pack.json`) ? 0 : top.length + 1;
  const out: PackFiles = new Map();
  let total = 0;
  for (const { name, flags, method, compressed, size, local } of entries) {
    const path = name.slice(strip);
    if (isPackHostControlPath(path)) throw new PackArchiveError(`'${path}' is reserved host control state; a pack may not supply it.`);
    if (!path.endsWith('.json') && !isPackAssetPath(path) && !isPackBlobPath(path) && !isCodeFilePath(path) && path !== PACK_SIGNATURE_FILE) continue;
    if (path === PACK_SIGNATURE_FILE && size > MAX_SIGNATURE_BYTES) throw new PackArchiveError(`The pack's ${PACK_SIGNATURE_FILE} is larger than a signature may be.`, 413);
    if ((flags & 1) !== 0) throw new PackArchiveError('Encrypted zips are not supported.');
    if (compressed === 0xffffffff || size === 0xffffffff) throw new PackArchiveError('Zip64 archives are not supported.');
    total += size;
    if (size > MAX_PACK_BYTES || total > MAX_PACK_UNPACKED_BYTES) throw new PackArchiveError('The zip unpacks to more than a pack may be.', 413);
    if (isCodeFilePath(path) && size > MAX_PACK_CODE_BYTES) throw new PackArchiveError(`'${path}' is larger than a module's code file may be (${MAX_PACK_CODE_BYTES / 1024 / 1024} MiB).`, 413);
    if (isPackDocPath(path) && size > MAX_PACK_PDF_BYTES) throw new PackArchiveError(`'${path}' is larger than a pack PDF may be (${MAX_PACK_PDF_BYTES / 1024 / 1024} MiB).`, 413);
    else if (isPackFontPath(path) && size > MAX_PACK_FONT_BYTES) throw new PackArchiveError(`'${path}' is larger than a pack font may be (${MAX_PACK_FONT_BYTES / 1024 / 1024} MiB).`, 413);
    else if (isPackAssetPath(path) && size > MAX_PACK_ASSET_BYTES) throw new PackArchiveError(`'${path}' is larger than a pack image may be (${MAX_PACK_ASSET_BYTES / 1024 / 1024} MiB).`, 413);
    if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) throw new PackArchiveError('The zip is damaged (a file header is missing).');
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    const raw = bytes.subarray(start, start + compressed);
    let data: Uint8Array;
    if (method === 0) data = raw;
    else if (method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
      } catch {
        throw new PackArchiveError(`'${name}' in the zip cannot be unpacked.`);
      }
    } else throw new PackArchiveError(`'${name}' in the zip uses a compression method this studio cannot read.`);
    if (data.length !== size) throw new PackArchiveError(`'${name}' in the zip does not match its recorded size.`);
    out.set(path, data);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * JSON bundle
 * ------------------------------------------------------------------ */

const encode = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

/** The files of a `{ format, manifest, files }` bundle, each written canonically. */
export function readBundle(value: unknown): PackFiles {
  return checkedAssets(readBundleRaw(value));
}

/** A bundle's files as shipped (images not yet checked), and its `signature` as `wirehub-pack.sig`. */
function readBundleRaw(value: unknown): PackFiles {
  const bundle = value as { manifest?: unknown; files?: unknown; signature?: unknown } | null;
  if (typeof bundle !== 'object' || bundle === null || typeof bundle.manifest !== 'object' || bundle.manifest === null || typeof bundle.files !== 'object' || bundle.files === null || Array.isArray(bundle.files)) {
    throw new PackArchiveError('That is not a pack bundle.', 400);
  }
  const out: PackFiles = new Map([['wirehub-pack.json', encode(bundle.manifest)]]);
  const entries = Object.entries(bundle.files as Record<string, unknown>);
  if (entries.length > MAX_PACK_FILES) throw new PackArchiveError(`The bundle has too many files (${entries.length}).`);
  for (const [path, content] of entries) {
    if (!isPackFilePath(path) || path === 'wirehub-pack.json') throw new PackArchiveError(`'${path}' is not a path a pack file may have.`);
    if (isCodeFilePath(path)) {
      if (typeof content !== 'string') throw new PackArchiveError(`'${path}' is a code file: its value is its text.`);
      out.set(path, new TextEncoder().encode(content));
      continue;
    }
    if (isPackAssetPath(path) || isPackBlobPath(path)) {
      if (typeof content !== 'string' || !/^[A-Za-z0-9+/\s]*={0,2}$/.test(content)) throw new PackArchiveError(`'${path}' is a binary file (${isPackAssetPath(path) ? 'an image' : isPackDocPath(path) ? 'a PDF' : 'a font'}): its value is the file, base64 encoded.`);
      out.set(path, new Uint8Array(Buffer.from(content, 'base64')));
      continue;
    }
    out.set(path, encode(typeof content === 'string' ? (JSON.parse(content) as unknown) : content));
  }
  if (bundle.signature !== undefined) {
    if (typeof bundle.signature !== 'string' || bundle.signature.length > MAX_SIGNATURE_BYTES) throw new PackArchiveError('A bundle\'s "signature" is the text of wirehub-pack.sig.');
    out.set(PACK_SIGNATURE_FILE, new TextEncoder().encode(bundle.signature));
  }
  return out;
}

/** A pack as read: the files to install (images checked, SVG stripped), the files as shipped (what a signature covers), and its signature text. */
export interface ReadPack {
  files: PackFiles;
  format: 'zip' | 'bundle';
  /** every file as shipped, before images are checked or stripped; without the signature */
  shipped: PackFiles;
  /** `wirehub-pack.sig`, when the pack carries one */
  signature?: string;
}

/** What a stranger handed us: zip bytes, or JSON text holding a bundle. */
export function readPackBytes(bytes: Uint8Array): ReadPack {
  if (bytes.length > MAX_PACK_BYTES) throw new PackArchiveError('That pack is larger than this studio accepts.', 413);
  let raw: PackFiles;
  let format: 'zip' | 'bundle';
  if (isZip(bytes)) {
    raw = readZipRaw(bytes);
    format = 'zip';
  } else {
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new PackArchiveError('That is neither a zip file nor a JSON pack bundle.');
    }
    raw = readBundleRaw(value);
    format = 'bundle';
  }
  const sig = raw.get(PACK_SIGNATURE_FILE);
  raw.delete(PACK_SIGNATURE_FILE);
  const shipped = new Map(raw);
  return { files: checkedAssets(raw), format, shipped, ...(sig === undefined ? {} : { signature: new TextDecoder().decode(sig) }) };
}

/**
 * Write a pack's files under `dir` (a fresh temporary directory). A data document is written in
 * canonical JSON form (and `models.json` / `assets/index.json` in the store's order), whatever form
 * it was shipped in, so the same bytes land in the file catalog and the database one (`cs-e7d`).
 * The manifest is kept as shipped: a signature covers its bytes.
 */
export function writePackFiles(dir: string, files: PackFiles): void {
  for (const path of files.keys()) {
    if (!isPackFilePath(path)) throw new PackArchiveError(`'${path}' is not a path a pack file may have.`);
  }
  for (const [path, bytes] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    const document = path.endsWith('.json') && path !== 'wirehub-pack.json';
    writeFileSync(join(dir, path), document ? canonicalPackText(path, new TextDecoder().decode(bytes)) : bytes);
  }
}

/* ------------------------------------------------------------------ *
 * https fetch
 * ------------------------------------------------------------------ */

/** Private, loopback, link-local and other addresses a pack URL must never reach. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    if (a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    return mapped?.[1] !== undefined && isPrivateAddress(mapped[1]);
  }
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return true;
  const [a, b] = p as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
}

export interface FetchPackOptions {
  fetch?: typeof fetch;
  /** resolve a host to its addresses (tests inject one) */
  lookup?: (host: string) => Promise<string[]>;
  maxBytes?: number;
  timeoutMs?: number;
}

const defaultLookup = async (host: string): Promise<string[]> => (await dnsLookup(host, { all: true })).map((a) => a.address);

async function checkedUrl(raw: string, lookup: (host: string) => Promise<string[]>): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PackArchiveError('That is not a URL.');
  }
  if (url.protocol !== 'https:') throw new PackArchiveError('Only https:// addresses are accepted.');
  if (url.username !== '' || url.password !== '') throw new PackArchiveError('A pack URL cannot carry a user name or password.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) !== 0 ? [host] : await lookup(host).catch(() => []);
  if (addresses.length === 0) throw new PackArchiveError(`Could not find ${host}.`, 502);
  if (addresses.some(isPrivateAddress)) throw new PackArchiveError('That address is on a private network; this studio only fetches public https addresses.');
  return url;
}

/** Download a pack from an https URL: bounded in size and time, redirects re-checked. */
export async function fetchPack(raw: string, options: FetchPackOptions = {}): Promise<Uint8Array> {
  const doFetch = options.fetch ?? fetch;
  const lookup = options.lookup ?? defaultLookup;
  const max = options.maxBytes ?? MAX_PACK_BYTES;
  const signal = AbortSignal.timeout(options.timeoutMs ?? PACK_FETCH_TIMEOUT_MS);
  let url = await checkedUrl(raw, lookup);
  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await doFetch(url, { redirect: 'manual', signal, headers: { accept: 'application/zip, application/json' } });
    } catch (error) {
      const timedOut = signal.aborted;
      throw new PackArchiveError(timedOut ? 'The download took too long.' : `The download failed: ${error instanceof Error ? error.message : String(error)}`, 502);
    }
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      if (next === null || hop >= MAX_REDIRECTS) throw new PackArchiveError('Too many redirects.', 502);
      url = await checkedUrl(new URL(next, url).href, lookup);
      continue;
    }
    if (!response.ok) throw new PackArchiveError(`The server answered ${response.status}.`, 502);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) throw new PackArchiveError('That pack is larger than this studio accepts.', 413);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      const reader = response.body?.getReader();
      if (reader === undefined) throw new PackArchiveError('The download had no content.', 502);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) {
          await reader.cancel();
          throw new PackArchiveError('That pack is larger than this studio accepts.', 413);
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof PackArchiveError) throw error;
      throw new PackArchiveError(signal.aborted ? 'The download took too long.' : 'The download was interrupted.', 502);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
}

/**
 * Drawing sidecars: the title-block facts and product photo for a design's
 * drawing sheet, kept beside the design and never inside it.
 *
 *   packages/catalog/data/drawings/<design-id>.json            the DrawingMeta
 *   packages/catalog/data/drawings/<design-id>.photo-ref.json  { assetId }
 *   packages/catalog/data/drawings/<design-id>.photo.png/.jpg  legacy, read-only
 *
 * The photo itself lives in the shared asset store (`assets.ts`)
 * — this file only keeps which asset a design's
 * drawing points at, in its own tiny file so saving the *text* fields
 * (`writeMeta`, a completely separate call from `writePhoto`) can never
 * clobber it by overwriting `<id>.json` without knowing about the photo.
 *
 * `<design-id>.photo.png`/`.jpg` is what every drawing used to store its own
 * copy in, before the shared store existed; `read()` still honours one if it
 * finds it (nothing here writes one anymore — the migration script moved the
 * real catalog's copies into `assets/` and left none behind), so a host that
 * has not run the migration yet still shows its photo instead of losing it.
 *
 * Same rules as the design store: an id is checked before it becomes a path,
 * JSON is 2-space with a trailing newline, and a write that says nothing new
 * leaves the file alone.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

import { dataPath, isDesignId } from '@wirehub/catalog';
import type { DrawingMeta, LengthVariant, SheetSettings } from '@wirehub/docs';

import { assetDataUri, decodeImageDataUri, fileAssetStore, memoryAssetStore, type AssetStore } from './assets.ts';
import { writeFileAtomic } from './atomic-write.ts';
import { recordWrite } from './write-journal.ts';
import type { Awaitable } from './storage/change-set.ts';

export interface StoredDrawing {
  meta: DrawingMeta;
  /** `data:image/png;base64,…`, resolved from the shared asset it points at */
  photo?: string;
}

export interface DrawingStore {
  read(id: string): Awaitable<StoredDrawing>;
  writeMeta(id: string, meta: DrawingMeta): Awaitable<void>;
  /**
   * `undefined` removes the photo (the design stops pointing at it; the
   * shared asset itself is untouched — other drawings may still use it).
   * Otherwise the bytes are added to the shared asset store (a no-op if
   * identical bytes are already there) and this design is pointed at
   * whichever asset — new or existing — those bytes resolved to.
   */
  writePhoto(id: string, photo: { mime: 'image/png' | 'image/jpeg'; bytes: Buffer } | undefined): Awaitable<void>;
  /** follow a design rename; a no-op when there is nothing to move */
  move(from: string, to: string): Awaitable<void>;
  remove(id: string): Awaitable<void>;
}

const PHOTO_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg' } as const;

function metaPath(id: string): string {
  if (!isDesignId(id)) throw new Error(`'${id}' is not a usable design id`);
  return dataPath(`drawings/${id}.json`);
}

/** legacy per-design photo, pre-dating the shared asset store */
function legacyPhotoPath(id: string, ext: 'png' | 'jpg'): string {
  if (!isDesignId(id)) throw new Error(`'${id}' is not a usable design id`);
  return dataPath(`drawings/${id}.photo.${ext}`);
}

function photoRefPath(id: string): string {
  if (!isDesignId(id)) throw new Error(`'${id}' is not a usable design id`);
  return dataPath(`drawings/${id}.photo-ref.json`);
}

export function fileDrawingStore(assets: AssetStore = fileAssetStore()): DrawingStore {
  const removeLegacyPhotos = (id: string): void => {
    for (const ext of ['png', 'jpg'] as const) {
      const path = legacyPhotoPath(id, ext);
      if (existsSync(path)) unlinkSync(path);
      recordWrite(path);
    }
  };
  const readPhotoRef = (id: string): string | undefined => {
    const path = photoRefPath(id);
    if (!existsSync(path)) return undefined;
    return (JSON.parse(readFileSync(path, 'utf8')) as { assetId?: string }).assetId;
  };
  const writePhotoRef = (id: string, assetId: string | undefined): void => {
    const path = photoRefPath(id);
    if (assetId === undefined) {
      if (existsSync(path)) unlinkSync(path);
      recordWrite(path);
      return;
    }
    const next = `${JSON.stringify({ assetId }, null, 2)}\n`;
    if (existsSync(path) && readFileSync(path, 'utf8') === next) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomic(path, next, 'utf8');
  };
  return {
    async read(id) {
      const path = metaPath(id);
      const meta = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as DrawingMeta) : {};
      for (const [mime, ext] of Object.entries(PHOTO_EXT)) {
        const legacy = legacyPhotoPath(id, ext);
        if (existsSync(legacy)) return { meta, photo: `data:${mime};base64,${readFileSync(legacy).toString('base64')}` };
      }
      const assetId = readPhotoRef(id);
      const found = assetId === undefined ? undefined : await assets.get(assetId);
      if (found !== undefined) return { meta, photo: assetDataUri(found.record.mime, found.bytes) };
      return { meta };
    },
    writeMeta(id, meta) {
      const path = metaPath(id);
      const next = `${JSON.stringify(meta, null, 2)}\n`;
      if (existsSync(path) && readFileSync(path, 'utf8') === next) return;
      mkdirSync(dirname(path), { recursive: true });
      writeFileAtomic(path, next, 'utf8');
    },
    async writePhoto(id, photo) {
      removeLegacyPhotos(id);
      if (photo === undefined) {
        writePhotoRef(id, undefined);
        return;
      }
      const record = await assets.put(photo.bytes, photo.mime, `${id}.${PHOTO_EXT[photo.mime]}`, `Product photo for the ${id} drawing sheet.`);
      writePhotoRef(id, record.id);
    },
    move(from, to) {
      if (from === to) return;
      recordWrite(metaPath(from), metaPath(to), photoRefPath(from), photoRefPath(to));
      for (const ext of ['png', 'jpg'] as const) recordWrite(legacyPhotoPath(from, ext), legacyPhotoPath(to, ext));
      if (existsSync(metaPath(from))) renameSync(metaPath(from), metaPath(to));
      for (const ext of ['png', 'jpg'] as const) {
        if (existsSync(legacyPhotoPath(from, ext))) renameSync(legacyPhotoPath(from, ext), legacyPhotoPath(to, ext));
      }
      if (existsSync(photoRefPath(from))) renameSync(photoRefPath(from), photoRefPath(to));
    },
    remove(id) {
      recordWrite(metaPath(id), photoRefPath(id));
      if (existsSync(metaPath(id))) unlinkSync(metaPath(id));
      removeLegacyPhotos(id);
      if (existsSync(photoRefPath(id))) unlinkSync(photoRefPath(id));
    },
  };
}

/** In memory, for tests. */
export function memoryDrawingStore(assets: AssetStore = memoryAssetStore()): DrawingStore & { files: Map<string, StoredDrawing> } {
  const files = new Map<string, StoredDrawing>();
  const photoRefs = new Map<string, string>();
  const resolve = async (id: string): Promise<StoredDrawing> => {
    const meta = files.get(id)?.meta ?? {};
    const assetId = photoRefs.get(id);
    const found = assetId === undefined ? undefined : await assets.get(assetId);
    return found === undefined ? { meta } : { meta, photo: assetDataUri(found.record.mime, found.bytes) };
  };
  return {
    files,
    read: async (id) => (files.has(id) || photoRefs.has(id) ? await resolve(id) : { meta: {} }),
    writeMeta(id, meta) {
      files.set(id, { meta });
    },
    async writePhoto(id, photo) {
      if (!files.has(id)) files.set(id, { meta: {} });
      if (photo === undefined) {
        photoRefs.delete(id);
        return;
      }
      const record = await assets.put(photo.bytes, photo.mime, `${id}.${PHOTO_EXT[photo.mime]}`, `Product photo for the ${id} drawing sheet.`);
      photoRefs.set(id, record.id);
    },
    move(from, to) {
      if (from === to) return;
      const current = files.get(from);
      if (current !== undefined) {
        files.set(to, current);
        files.delete(from);
      }
      const ref = photoRefs.get(from);
      if (ref !== undefined) {
        photoRefs.set(to, ref);
        photoRefs.delete(from);
      }
    },
    remove(id) {
      files.delete(id);
      photoRefs.delete(id);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Checking what the studio sends
 * ------------------------------------------------------------------ */

const TEXT_FIELDS = ['title', 'partNumber', 'revision', 'designer', 'date', 'material', 'src'] as const;

/**
 * A DrawingMeta, or the sentences that say why not. Unknown keys are refused
 * rather than stored: a typo'd field that silently never prints is exactly the
 * kind of thing nobody finds until the drawing is wrong.
 */
export function readDrawingMeta(value: unknown): { ok: true; meta: DrawingMeta } | { ok: false; problems: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problems: ['Drawing details must be sent as an object of fields.'] };
  }
  const input = value as Record<string, unknown>;
  const problems: string[] = [];
  const meta: DrawingMeta = {};
  for (const key of Object.keys(input)) {
    if (![...TEXT_FIELDS, 'lengths', 'materials', 'remarks', 'cutaway', 'sheet'].includes(key)) problems.push(`'${key}' is not a drawing field.`);
  }
  if (input.cutaway !== undefined) {
    if (input.cutaway !== 'art' && input.cutaway !== 'drawn') problems.push("cutaway must be 'art' or 'drawn'.");
    else if (input.cutaway === 'drawn') meta.cutaway = 'drawn';
  }
  for (const key of TEXT_FIELDS) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== 'string') problems.push(`${key} must be text.`);
    // title-block fields must fit the printed block; `src` is a citation, never printed there
    else if (field.length > (key === 'src' ? 4000 : 200))
      problems.push(`${key} is longer than ${key === 'src' ? 4000 : 200} characters.`);
    else if (field.trim() !== '') meta[key] = field;
  }
  if (input.lengths !== undefined) {
    if (!Array.isArray(input.lengths)) problems.push('lengths must be a list.');
    else {
      const lengths: LengthVariant[] = [];
      input.lengths.forEach((entry: unknown, index) => {
        const v = entry as Partial<LengthVariant> | null;
        if (v === null || typeof v !== 'object' || typeof v.suffix !== 'string' || typeof v.mm !== 'number' || !(v.mm > 0)) {
          problems.push(`Length ${index + 1} needs a suffix (text, may be empty) and a positive mm.`);
          return;
        }
        if (v.overallMm !== undefined && !(typeof v.overallMm === 'number' && v.overallMm > 0)) {
          problems.push(`Length ${index + 1}'s overall length must be a positive number of mm.`);
          return;
        }
        lengths.push({ suffix: v.suffix, mm: v.mm, ...(v.overallMm === undefined ? {} : { overallMm: v.overallMm }) });
      });
      if (lengths.length > 0) meta.lengths = lengths;
    }
  }
  if (input.materials !== undefined) {
    const materials = input.materials;
    if (typeof materials !== 'object' || materials === null || Array.isArray(materials)) problems.push('materials must map instance ids to text.');
    else {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(materials)) {
        if (typeof v !== 'string') problems.push(`materials.${k} must be text.`);
        else if (v.trim() !== '') out[k] = v;
      }
      if (Object.keys(out).length > 0) meta.materials = out;
    }
  }
  if (input.remarks !== undefined) {
    if (!Array.isArray(input.remarks) || input.remarks.some((r) => typeof r !== 'string')) problems.push('remarks must be a list of text lines.');
    else {
      const remarks = (input.remarks as string[]).filter((r) => r.trim() !== '');
      if (remarks.length > 0) meta.remarks = remarks;
    }
  }
  if (input.sheet !== undefined) {
    const sheet = readSheetSettings(input.sheet, problems);
    if (sheet !== undefined) meta.sheet = sheet;
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, meta };
}

/** The printed sheets' options; empty ones are dropped, not stored. */
function readSheetSettings(value: unknown, problems: string[]): SheetSettings | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push('sheet must be an object of fields.');
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const sheet: SheetSettings = {};
  for (const key of Object.keys(input)) {
    if (!['paper', 'number', 'revision', 'status', 'stampDate'].includes(key)) problems.push(`'sheet.${key}' is not a sheet option.`);
  }
  if (input.paper !== undefined) {
    if (input.paper !== 'A4' && input.paper !== 'letter') problems.push("sheet.paper must be 'A4' or 'letter'.");
    else sheet.paper = input.paper;
  }
  for (const key of ['number', 'revision', 'status'] as const) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== 'string') problems.push(`sheet.${key} must be text.`);
    else if (field.length > 80) problems.push(`sheet.${key} is longer than 80 characters.`);
    else if (field.trim() !== '') sheet[key] = field.trim();
  }
  if (input.stampDate !== undefined) {
    if (typeof input.stampDate !== 'boolean') problems.push('sheet.stampDate must be true or false.');
    else if (input.stampDate) sheet.stampDate = true;
  }
  return Object.keys(sheet).length === 0 ? undefined : sheet;
}

/** A photo upload: a PNG/JPEG data URI under 2.5 MB (it has to fit the 4 MB body limit as base64), or `null` to remove. */
export function readPhoto(value: unknown):
  | { ok: true; photo: { mime: 'image/png' | 'image/jpeg'; bytes: Buffer } | undefined }
  | { ok: false; problem: string } {
  const body = value as { photo?: unknown } | null;
  if (body === null || typeof body !== 'object' || !('photo' in body)) return { ok: false, problem: 'Send { "photo": "data:image/…" } or { "photo": null }.' };
  if (body.photo === null) return { ok: true, photo: undefined };
  if (typeof body.photo !== 'string') return { ok: false, problem: 'The photo must be a data URI.' };
  const decoded = decodeImageDataUri(body.photo);
  if (decoded === undefined) return { ok: false, problem: 'Only PNG and JPEG photos can go on a drawing.' };
  if (decoded.bytes.length > 2.5 * 1024 * 1024) return { ok: false, problem: 'That photo is over 2.5 MB — shrink it first.' };
  return { ok: true, photo: decoded };
}

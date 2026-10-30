/**
 * Print files: an STL or 3MF uploaded on a mechanical record for slicing, when the part has no
 * generated enclosure and its 3D model link is not an STL (or the person has a ready plate, such
 * as a 3MF saved from a desktop slicer). The bytes go to the asset store as sent (`model/stl`,
 * `model/3mf`, pinned by sha256); the record's list of them is one catalog document,
 * `data/print/files/<id>.json`, written through a change set like the manufacturing variants.
 *
 * A 3MF's own slicer project settings are not used: the pack sets them aside and slices with the
 * hub's profile (`tools/slicer-prusaslicer/README.md`).
 */

import { isAsciiStl, isBinaryStl } from '../models/mesh.ts';

export const printFilesPath = (id: string): string => `data/print/files/${id}.json`;

/** Raw bytes of one print file (the base64 request around it is bounded by the models' upload limit). */
export const MAX_PRINT_FILE_BYTES = 24 * 1024 * 1024;

export type PrintFileMime = 'model/stl' | 'model/3mf';

export interface PrintFile {
  name: string;
  /** asset id = sha256 of the bytes */
  asset: string;
  mime: PrintFileMime;
  bytes: number;
  uploadedAt: string;
  by?: string;
}

/** `POST /api/print/mechanicals/:id/files` carries a base64 file: it gets the upload body limit. */
export function isPrintUploadPath(path: string): boolean {
  return /^\/api\/print\/mechanicals\/[^/]+\/files\/?(\?|$)/.test(path);
}

const NAME = /^[^\\/\u0000-\u001f]{1,200}$/;

/** What an uploaded file is, by its bytes (and name for the extension), or why it is refused. */
export function sniffPrintFile(name: string, bytes: Uint8Array): { mime: PrintFileMime; name: string } | { error: string; hint?: string } {
  const trimmed = name.trim();
  if (!NAME.test(trimmed)) return { error: 'The upload needs the file name (no folders).' };
  if (bytes.byteLength === 0) return { error: 'That file is empty.' };
  if (bytes.byteLength > MAX_PRINT_FILE_BYTES) return { error: `That file is over ${MAX_PRINT_FILE_BYTES / 1048576} MB.` };
  const lower = trimmed.toLowerCase();
  if (lower.endsWith('.3mf')) {
    // a 3MF is an OPC zip whose model part is 3D/3dmodel.model (names sit uncompressed in the zip headers)
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    if (!zip || !Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes('3D/')) {
      return { error: `${trimmed} is not a 3MF package.`, hint: 'A 3MF is a zip with a 3D/3dmodel.model part, as slicers and CAD tools save it.' };
    }
    return { mime: 'model/3mf', name: trimmed };
  }
  if (lower.endsWith('.stl')) {
    if (!isBinaryStl(bytes) && !isAsciiStl(bytes)) return { error: `${trimmed} is not an STL.`, hint: 'Binary or ASCII STL, as CAD tools export it.' };
    return { mime: 'model/stl', name: trimmed };
  }
  return { error: 'Print files are STL or 3MF.', hint: 'Export the part as .stl, or save the plate as .3mf.' };
}

export function readPrintFiles(doc: unknown): PrintFile[] {
  return Array.isArray(doc) ? (doc as PrintFile[]).filter((f) => typeof f?.asset === 'string' && typeof f.name === 'string') : [];
}

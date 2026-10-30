import type { Outcome } from '@wirehub/editor-react';
import { request } from './definitions.browser.ts';
import { COVER_CAPTURE_RENDERERS, type CoverCamera, type CoverCaptureView, type CoverChoice, type CoverKind, type RepresentationView } from './representations.ts';

export interface CoverView extends RepresentationView { etag: string }
export class CoverAccessDenied extends Error {}
export const coverKey = (kind: CoverKind, id: string): readonly string[] => ['representations', kind, id];
const address = (kind: CoverKind, id: string): string => `/api/representations/${kind}/${encodeURIComponent(id)}`;

export async function readCover(kind: CoverKind, id: string): Promise<CoverView> {
  let etag = '';
  let denied = false;
  const out = await request<RepresentationView>(address(kind, id), { method: 'GET' }, (r) => {
    etag = r.headers.get('etag') ?? '';
    denied = r.status === 401 || r.status === 403;
  });
  if (denied) throw new CoverAccessDenied('Access to this preview was denied.');
  if (!out.ok) throw new Error(out.message);
  return { ...out.value, etag };
}

export async function saveCover(kind: CoverKind, id: string, choice: CoverChoice | null, etag: string): Promise<Outcome<CoverView>> {
  let next = '';
  const out = await request<RepresentationView>(address(kind, id), {
    method: 'PUT', body: { choice }, headers: { 'if-match': etag },
  }, (r) => { next = r.headers.get('etag') ?? ''; });
  return out.ok ? { ok: true, value: { ...out.value, etag: next } } : out;
}

export interface CoverCapture {
  view: CoverCaptureView;
  image: Blob;
  width: number;
  height: number;
  camera?: CoverCamera;
  editorView?: 'canvas' | 'schematic';
}

async function base64Of(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * Store a static capture and choose it as the cover. Reads the record's current version first, so
 * the image is tied to exactly what the server holds; a change in between is refused, not merged.
 */
export async function saveCoverCapture(kind: CoverKind, id: string, capture: CoverCapture, expectedSource?: string): Promise<Outcome<CoverView>> {
  let fresh: CoverView;
  try {
    fresh = await readCover(kind, id);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  const source = fresh.captureSources?.[capture.view];
  if (source === undefined) return { ok: false, message: 'This record has nothing to save a view of.' };
  if (expectedSource !== undefined && expectedSource !== source) return { ok: false, message: 'The record changed since this view was drawn. Reload, then save the view again.' };
  let next = '';
  const out = await request<RepresentationView>(`${address(kind, id)}/captures`, {
    method: 'POST',
    headers: { 'if-match': fresh.etag },
    body: {
      view: capture.view, source, renderer: COVER_CAPTURE_RENDERERS[capture.view], image: await base64Of(capture.image), width: capture.width, height: capture.height,
      ...(capture.camera === undefined ? {} : { camera: capture.camera }), ...(capture.editorView === undefined ? {} : { editorView: capture.editorView }),
    },
  }, (r) => { next = r.headers.get('etag') ?? ''; });
  return out.ok ? { ok: true, value: { ...out.value, etag: next } } : out;
}

/** Downscale a drawn canvas to a gallery-sized static image (no live scene per card). */
export async function canvasToCover(source: HTMLCanvasElement | HTMLImageElement, sourceWidth: number, sourceHeight: number, maxWidth = 960): Promise<{ image: Blob; width: number; height: number }> {
  const scale = Math.min(1, maxWidth / Math.max(1, sourceWidth));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const context = out.getContext('2d');
  if (context === null) throw new Error('This browser cannot draw a preview image.');
  context.drawImage(source, 0, 0, width, height);
  const image = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/webp', 0.88));
  const png = image ?? await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/png'));
  if (png === null) throw new Error('This browser could not encode the preview image.');
  return { image: png, width, height };
}

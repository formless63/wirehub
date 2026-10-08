/**
 * The studio's `ArtworkAdapter`: the workbench's artwork endpoints, over
 * `fetch`.
 *
 * The sibling of `persistence.browser.ts`, and the same bargain: this is one of
 * only two files in the studio that knows a URL, and `CableEditor` is handed
 * the adapter without ever learning where artwork is kept.
 *
 * Two things here are not boilerplate:
 *
 * - **Uploads go as `FormData`.** The file's bytes travel as bytes; the
 *   scale and the provenance ride along as text fields. The endpoint also takes
 *   base64 JSON, which is what a `curl` round-trip uses, but a browser that has
 *   a real `File` should not spend a third of the file's size on base64.
 * - **`artwork()` converts on the way in.** The renderer embeds vector art as
 *   inlined source and raster art as a `data:` URI — never as a URL — because
 *   a schematic has to stay self-contained. So the bytes are turned into
 *   whichever of the two the manifest declares, right here, and what comes back
 *   can be layered straight over the bundled `DepictionSource`.
 *
 * Nothing throws. Every failure is a sentence and a next step, and a refused
 * upload additionally carries the import ladder's `guidance` lines, which the
 * Artwork pane prints verbatim.
 */

import type {
  ArtworkAdapter,
  ArtworkDetail,
  ArtworkOutcome,
  AnchorWrite,
  DepictionArtwork,
  UploadReport,
  UploadRequest,
} from '@wirehub/editor-react';
import type { Issue } from '@wirehub/model';

interface ApiError {
  error?: string;
  hint?: string;
  issues?: Issue[];
  guidance?: string[];
}

function unreachable<T>(error: unknown): ArtworkOutcome<T> {
  return {
    ok: false,
    message: 'WireHub could not reach the server.',
    hint: `Nothing was changed. Start the dev server and try again. (${
      error instanceof Error ? error.message : String(error)
    })`,
  };
}

function refusal<T>(status: number, payload: unknown): ArtworkOutcome<T> {
  const body = (payload ?? {}) as ApiError;
  return {
    ok: false,
    message: body.error ?? `The server refused that (HTTP ${status}).`,
    ...(body.hint === undefined ? {} : { hint: body.hint }),
    ...(body.issues === undefined ? {} : { issues: body.issues }),
    ...(body.guidance === undefined ? {} : { guidance: body.guidance }),
  };
}

async function json<T>(
  input: string,
  init: { method: string; body?: BodyInit; contentType?: string } = { method: 'GET' },
): Promise<ArtworkOutcome<T>> {
  let response: Response;
  try {
    response = await fetch(input, {
      method: init.method,
      ...(init.body === undefined ? {} : { body: init.body }),
      // FormData sets its own boundary-carrying content-type; overriding it
      // would make the body unreadable at the other end
      ...(init.contentType === undefined ? {} : { headers: { 'content-type': init.contentType } }),
    });
  } catch (error) {
    return unreachable(error);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return response.ok
      ? unreachable(error)
      : {
          ok: false,
          message: 'The server answered with something WireHub could not read.',
          hint: `Nothing was changed. Check the terminal running WireHub. (HTTP ${response.status})`,
        };
  }
  return response.ok ? { ok: true, value: payload as T } : refusal(response.status, payload);
}

/** Bytes → base64, without a `FileReader` round trip. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function assetUrl(base: string, defId: string, view: string): string {
  return `${base}/depictions/${encodeURIComponent(defId)}/${encodeURIComponent(view)}`;
}

export function workbenchArtwork(base = '/api'): ArtworkAdapter {
  return {
    detail: (defId) => json<ArtworkDetail>(`${base}/depictions/${encodeURIComponent(defId)}`),

    async upload(defId, view, request: UploadRequest): Promise<ArtworkOutcome<UploadReport>> {
      const url = assetUrl(base, defId, view);
      const blob = request.file.blob;
      if (typeof FormData !== 'undefined' && blob instanceof Blob) {
        const form = new FormData();
        form.append('file', blob, request.file.name);
        if (request.widthMm !== undefined) form.append('widthMm', String(request.widthMm));
        if (request.mmPerUnit !== undefined) form.append('mmPerUnit', String(request.mmPerUnit));
        if (request.sourceKind !== undefined) form.append('sourceKind', request.sourceKind);
        if (request.src !== undefined) form.append('src', request.src);
        return json<UploadReport>(url, { method: 'POST', body: form });
      }
      const bytes = request.file.bytes;
      if (bytes === undefined) {
        return {
          ok: false,
          message: 'There was nothing to upload.',
          hint: 'Choose a file and try again.',
        };
      }
      return json<UploadReport>(url, {
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({
          fileName: request.file.name,
          data: toBase64(bytes),
          ...(request.widthMm === undefined ? {} : { widthMm: request.widthMm }),
          ...(request.mmPerUnit === undefined ? {} : { mmPerUnit: request.mmPerUnit }),
          ...(request.sourceKind === undefined ? {} : { sourceKind: request.sourceKind }),
          ...(request.src === undefined ? {} : { src: request.src }),
        }),
      });
    },

    saveAnchors: (defId, write: AnchorWrite) =>
      json<ArtworkDetail>(`${base}/depictions/${encodeURIComponent(defId)}/anchors`, {
        method: 'PUT',
        contentType: 'application/json',
        body: JSON.stringify(write),
      }),

    saveEntryGuides: (defId, guides) =>
      json<ArtworkDetail>(`${base}/depictions/${encodeURIComponent(defId)}/entry-guides`, {
        method: 'PUT',
        contentType: 'application/json',
        body: JSON.stringify({ entryGuides: guides }),
      }),

    async artwork(defId, view): Promise<ArtworkOutcome<DepictionArtwork>> {
      let response: Response;
      try {
        response = await fetch(assetUrl(base, defId, view));
      } catch (error) {
        return unreachable(error);
      }
      if (!response.ok) {
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          payload = undefined;
        }
        return refusal(response.status, payload);
      }
      const media = (response.headers.get('content-type') ?? '').toLowerCase();
      if (media.startsWith('image/svg')) {
        return { ok: true, value: { kind: 'vector', source: await response.text() } };
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const type = media.split(';')[0] ?? 'application/octet-stream';
      return { ok: true, value: { kind: 'raster', dataUri: `data:${type};base64,${toBase64(bytes)}` } };
    },
  };
}

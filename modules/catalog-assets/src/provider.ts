import { candidatesFromTree, isDirectory, KICAD } from './discovery.ts';
import type { ServerRouteContribution } from '@wirehub/modules';

export const MAX_LIST_BYTES = 256 * 1024;

/** Fixed public origin, no redirects, no credentials, deadline and streamed byte bound. */
export async function listKicad(query: URLSearchParams, fetcher: typeof fetch = fetch): Promise<{ status: number; body: unknown }> {
  const directory = query.get('directory') ?? '';
  const page = query.get('page') ?? '1';
  const filter = query.get('q') ?? '';
  if (!isDirectory(directory) || !/^(?:[1-9]|1[0-9]|20)$/.test(page) || filter.length > 120 || /[\u0000-\u001f\u007f]/.test(filter)) {
    return { status: 400, body: { error: 'Choose a supported KiCad category, page 1–20, and a search of at most 120 characters.' } };
  }
  const params = new URLSearchParams({ ref: KICAD.commit, path: directory, page, per_page: '100' });
  const url = `https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-packages3D/repository/tree?${params}`;
  try {
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      return { status: 502, body: { error: 'KiCad could not provide a listing. Open its catalog directly or try again later.' } };
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAX_LIST_BYTES) {
      await response.body.cancel();
      return { status: 502, body: { error: 'KiCad returned a listing larger than the supported limit.' } };
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > MAX_LIST_BYTES) throw new Error('listing too large');
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const tree: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const candidates = candidatesFromTree(tree, directory, filter);
    const hasMore = response.headers.get('x-next-page') !== null
      ? response.headers.get('x-next-page') !== ''
      : Array.isArray(tree) && tree.length === 100;
    return { status: 200, body: { candidates, page: Number(page), hasMore: hasMore && Number(page) < 20, library: KICAD, filteredPage: filter.trim() !== '' } };
  } catch {
    return { status: 502, body: { error: 'The KiCad listing was unavailable or invalid. Open its catalog directly or try again later.' } };
  }
}

export const kicadListingRoute: ServerRouteContribution = { method: 'GET', path: 'kicad', handle: (request) => listKicad(request.query) };

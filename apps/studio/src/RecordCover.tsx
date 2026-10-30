import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Select, useEditLocked } from '@wirehub/editor-react';
import { coverHref, resolveCover, type CoverKind } from './representations.ts';
import { CoverAccessDenied, coverKey, readCover, saveCover } from './representations.browser.ts';

/*
 * A list's covers wait their turn: a row reads its cover only once it is on screen, and at
 * most two row covers are read at a time, so the open record's own requests (Where used, its
 * art) are never queued behind a whole list of thumbnails.
 */
const ROW_COVER_READS = 2;
let rowReads = 0;
const rowQueue: (() => void)[] = [];
async function readRowCover(kind: CoverKind, id: string): ReturnType<typeof readCover> {
  if (rowReads >= ROW_COVER_READS) await new Promise<void>((go) => rowQueue.push(go));
  rowReads += 1;
  try {
    return await readCover(kind, id);
  } finally {
    rowReads -= 1;
    rowQueue.shift()?.();
  }
}

/** True once the element has come near the viewport (always true where there is no IntersectionObserver). */
function useSeen(on: boolean): [(el: HTMLElement | null) => void, boolean] {
  const [seen, setSeen] = useState(!on || typeof IntersectionObserver === 'undefined');
  const observer = useRef<IntersectionObserver | undefined>(undefined);
  useEffect(() => () => observer.current?.disconnect(), []);
  const ref = useCallback((el: HTMLElement | null): void => {
    observer.current?.disconnect();
    if (el === null || seen) return;
    observer.current = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        observer.current?.disconnect();
      }
    }, { rootMargin: '200px' });
    observer.current.observe(el);
  }, [seen]);
  return [ref, seen];
}

/** The same static cover in a list row and its record header. No live 3D gallery scenes. */
export function RecordCover({ kind = 'pcbas', id, label, compact = false, editable = false, bare = false, caption = 'Shared cover · lists and record', thumbClass = 'h-10 w-14' }: {
  kind?: CoverKind; id: string; label: string; compact?: boolean; editable?: boolean; bare?: boolean; caption?: string; thumbClass?: string;
}): JSX.Element {
  const client = useQueryClient();
  // Catalog events invalidate these queries; focus/reconnect refresh stale data. Do not make
  // every visible row reread and hash all its artwork on a timer.
  const [seenRef, seen] = useSeen(compact);
  const query = useQuery({ queryKey: coverKey(kind, id), queryFn: () => (compact ? readRowCover(kind, id) : readCover(kind, id)), retry: false, staleTime: 30_000, enabled: seen });
  const locked = useEditLocked();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [failedAsset, setFailedAsset] = useState<string>();
  const [retriedAsset, setRetriedAsset] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const data = query.error instanceof CoverAccessDenied ? undefined : query.data;
  const resolved = data === undefined ? undefined : resolveCover(data);
  const chosenStale = data?.choice === null || data === undefined ? undefined : data.candidates.find((c) => c.view === data.choice?.view)?.stale;
  const candidate = !compact && preview !== undefined ? data?.candidates.find((c) => c.view === preview && c.asset !== undefined) : resolved?.selected;
  const asset = candidate?.asset;
  const image = asset === undefined || asset === failedAsset || candidate === undefined ? undefined : coverHref(candidate);
  // A transport failure need not change the content hash. Retry once without remounting the
  // record; persistent failures require a deliberate retry rather than a background loop.
  useEffect(() => {
    if (asset === undefined || asset !== failedAsset || asset === retriedAsset || data === undefined) return;
    const timer = window.setTimeout(() => { setRetriedAsset(asset); setFailedAsset(undefined); }, 1000);
    return () => window.clearTimeout(timer);
  }, [asset, failedAsset, retriedAsset, data]);
  const choose = async (automatic: boolean): Promise<void> => {
    if (data === undefined || busy || locked || (!automatic && candidate === undefined)) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const choice = automatic ? null : { view: candidate!.view, lineage: candidate!.lineage };
      const out = await saveCover(kind, id, choice, data.etag);
      if (out.ok) {
        client.setQueryData(coverKey(kind, id), out.value);
        setPreview(undefined);
        setMessage(automatic ? 'Automatic cover restored.' : 'Cover saved.');
      } else {
        setMessage(out.message);
        void query.refetch();
      }
    } finally {
      setBusy(false);
    }
  };
  // a list row without a picture keeps a quiet empty box: no "No preview" words in the name column
  const picture = image === undefined && (bare || compact) ? <span aria-hidden className={thumbClass} /> : image === undefined ? <span className="text-faint text-xs">{asset !== undefined && asset === failedAsset
    ? <Button size="xs" onClick={(event) => { event.stopPropagation(); setFailedAsset(undefined); void query.refetch(); }}>Retry preview</Button>
    : query.isPending ? 'Loading preview…' : 'No preview'}</span>
    : <img src={image} loading="lazy" alt={`${label} — ${candidate!.label}`} className={compact ? `${thumbClass} object-contain` : 'h-32 w-56 rounded-sm border border-line bg-raised object-contain'}
      onError={() => { setFailedAsset(asset); void query.refetch(); }} />;
  if (compact) return <span ref={seenRef} className="inline-flex shrink-0 items-center justify-center" title={resolved?.state === 'stale' ? `${chosenStale ?? 'Cover source changed.'} Showing an automatic preview.` : candidate?.src}>{picture}</span>;
  // nothing to show or choose yet (no source preview at all): no empty cover row
  if (data !== undefined && data.choice === null && !data.candidates.some((c) => c.asset !== undefined) && message === undefined) return <></>;
  // one row: the picture, then the preview picker and the cover actions beside it (the caption is the tooltip)
  return <section aria-label="Record cover" title={caption} className="flex items-start gap-3 border-t border-line p-2">
    {image === undefined ? <span className="flex h-16 w-28 shrink-0 items-center justify-center rounded-sm border border-dashed border-line">{picture}</span> : <span className="shrink-0">{picture}</span>}
    <div className="flex min-w-0 flex-col gap-1.5">
    {data === undefined ? null : <div className="flex flex-wrap items-center gap-2">
      <Select className="w-56" size="xs" aria-label="Choose preview" value={candidate?.view ?? ''} options={data.candidates.filter((c) => c.asset !== undefined).map((c) => ({ value: c.view, label: c.label }))}
        onValueChange={setPreview} disabled={busy} />
      {!editable ? null : <>
        <Button size="xs" disabled={locked || busy || image === undefined} onClick={() => void choose(false)}>Use as cover</Button>
        <Button size="xs" disabled={locked || busy || data.choice === null} onClick={() => void choose(true)}>Automatic cover</Button>
      </>}
      <span className="text-xs text-faint" title={candidate?.limitations.join(' ')}>{candidate?.fidelity}{data.identity.revision === undefined ? '' : ` · ${data.identity.revision}`}{data.identity.build === undefined ? '' : ` · ${data.identity.build}`}</span>
    </div>}
    {resolved?.state !== 'stale' && resolved?.state !== 'unavailable' ? null : <p role="status" className="text-xs text-faint">
      {resolved.state === 'stale' ? `${chosenStale ?? 'Chosen cover source changed.'} ${resolved.selected === undefined ? 'No other preview is available' : 'Showing an automatic preview'}; ${chosenStale === undefined ? 'choose again to adopt it.' : 'save the view again to refresh it.'}`
        : data?.choice === null ? 'No source preview is available yet.' : 'Chosen preview is unavailable. Any available automatic preview is shown.'}
    </p>}
    {query.error === null ? null : <p role="alert" className="text-xs text-err">{query.error.message}</p>}
    {message === undefined ? null : <p role="status" className="text-xs">{message}</p>}
    </div>
  </section>;
}

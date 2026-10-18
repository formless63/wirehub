import { useState, type JSX } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Select, useEditLocked } from '@wirehub/editor-react';
import { resolveCover } from './representations.ts';
import { CoverAccessDenied, coverKey, readCover, saveCover } from './representations.browser.ts';

/** The same static cover in a library row and its record header. No live 3D gallery scenes. */
export function RecordCover({ id, label, compact = false, editable = false }: {
  id: string; label: string; compact?: boolean; editable?: boolean;
}): JSX.Element {
  const client = useQueryClient();
  const query = useQuery({ queryKey: coverKey(id), queryFn: () => readCover(id), retry: false, refetchInterval: 30_000 });
  const locked = useEditLocked();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [failedAsset, setFailedAsset] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const data = query.error instanceof CoverAccessDenied ? undefined : query.data;
  const resolved = data === undefined ? undefined : resolveCover(data);
  const candidate = !compact && preview !== undefined ? data?.candidates.find((c) => c.view === preview && c.asset !== undefined) : resolved?.selected;
  const asset = candidate?.asset;
  const image = asset === undefined || asset === failedAsset ? undefined : `/api/blobs/${asset}`;
  const choose = async (automatic: boolean): Promise<void> => {
    if (data === undefined || busy || locked || (!automatic && candidate === undefined)) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const choice = automatic ? null : { view: candidate!.view, lineage: candidate!.lineage };
      const out = await saveCover(id, choice, data.etag);
      if (out.ok) {
        client.setQueryData(coverKey(id), out.value);
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
  const picture = image === undefined ? <span className="text-faint text-xs">{query.isPending ? 'Loading preview…' : 'No preview'}</span>
    : <img src={image} loading="lazy" alt={`${label} — ${candidate!.label}`} className={compact ? 'h-10 w-14 object-contain' : 'h-40 w-full object-contain'}
      onError={() => { setFailedAsset(asset); void query.refetch(); }} />;
  if (compact) return <span className="inline-flex shrink-0 items-center justify-center" title={resolved?.state === 'stale' ? 'Cover source changed; showing an automatic preview.' : candidate?.src}>{picture}</span>;
  return <section aria-label="Record cover" className="flex flex-col gap-2 border-t border-line p-2">
    {picture}
    {data === undefined ? null : <div className="flex flex-wrap items-center gap-2">
      <Select aria-label="Choose preview" value={candidate?.view ?? ''} options={data.candidates.filter((c) => c.asset !== undefined).map((c) => ({ value: c.view, label: c.label }))}
        onValueChange={setPreview} disabled={busy} />
      {!editable ? null : <>
        <Button size="xs" disabled={locked || busy || image === undefined} onClick={() => void choose(false)}>Use as cover</Button>
        <Button size="xs" disabled={locked || busy || data.choice === null} onClick={() => void choose(true)}>Automatic cover</Button>
      </>}
      <span className="text-xs text-faint" title={candidate?.limitations.join(' ')}>{candidate?.fidelity}{data.identity.revision === undefined ? '' : ` · ${data.identity.revision}`}{data.identity.build === undefined ? '' : ` · ${data.identity.build}`}</span>
    </div>}
    {resolved?.state !== 'stale' && resolved?.state !== 'unavailable' ? null : <p role="status" className="text-xs text-faint">
      {resolved.state === 'stale' ? 'Chosen cover source changed. Showing an automatic preview; choose again to adopt it.'
        : data?.choice === null ? 'No source preview is available yet.' : 'Chosen preview is unavailable. Any available automatic preview is shown.'}
    </p>}
    {query.error === null ? null : <p role="alert" className="text-xs text-err">{query.error.message}</p>}
    {message === undefined ? null : <p role="status" className="text-xs">{message}</p>}
  </section>;
}

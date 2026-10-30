/**
 * A saved version's effective inputs: every library record, board, stock and placed design it
 * captured (revision, content hash, artwork, cover), and "Changed since this version" — the ones
 * that differ in the library today. The revision keeps drawing its own copies; this panel only
 * says the library moved on, with a compare link: against the saved record revision it matched,
 * else against the copy this version froze.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Badge, Drawer, type Tone, FindingsList } from '@wirehub/editor-react';
import type { JSX } from 'react';

import { getVersionInputs, shortTime, versionInputsKey, type VersionInputs, type VersionInputStatus } from '../versions.browser.ts';

const NOUN: Record<VersionInputStatus['kind'], string> = {
  pcbas: 'Board',
  connectors: 'Connector',
  bodies: 'Body',
  interfaces: 'Pinout',
  wires: 'Stock',
  components: 'Component',
  mechanicals: 'Hardware',
  designs: 'Design',
};

/** the Library's URL segment per record kind (bodies and pinouts have no page of their own) */
const LIBRARY_URL: Partial<Record<VersionInputStatus['kind'], string>> = {
  pcbas: 'boards',
  connectors: 'connectors',
  wires: 'wires',
  components: 'components',
  mechanicals: 'hardware',
};

const CHANGE_TEXT: Record<NonNullable<VersionInputStatus['changed']>[number], string> = {
  record: 'record changed',
  artwork: 'artwork changed',
  cover: 'cover changed',
  'newer-version': 'newer version saved',
  'working-copy': 'working copy changed',
};


export function useVersionInputs(id: string, rev: number): VersionInputs | undefined {
  const query = useQuery({
    queryKey: versionInputsKey(id, rev),
    queryFn: async () => {
      const out = await getVersionInputs(id, rev);
      if (!out.ok) throw new Error(out.message);
      return out.value;
    },
    retry: false,
    staleTime: 15_000,
  });
  return query.data;
}

function InputRow(props: { input: VersionInputStatus; design: string; rev: number }): JSX.Element {
  const i = props.input;
  const tone: Tone = i.state === 'same' ? 'ok' : i.state === 'gone' ? 'err' : 'warn';
  const url = LIBRARY_URL[i.kind];
  // the saved record revision it matched, else the copy this version froze
  const compare = url !== undefined && i.state === 'changed' && i.changed?.includes('record') === true ? `${i.kind}/${i.id}@${i.recordRev ?? `${props.design}:${props.rev}`}` : undefined;
  const revText = [
    i.revision,
    i.recordRev === undefined ? undefined : `rec r${i.recordRev}`,
    i.designRev === undefined ? undefined : `Rev ${i.designRev}`,
  ].filter((t): t is string => t !== undefined).join(' · ');
  return (
    <li className="border-b border-line px-1 py-1.5 text-xs" data-testid="version-input" data-state={i.state}>
      <div className="flex min-w-0 items-center gap-1.5">
        <Badge tone={tone}>{i.state === 'same' ? 'same' : i.state === 'gone' ? 'gone' : 'changed'}</Badge>
        <span className="shrink-0 text-2xs uppercase text-faint">{NOUN[i.kind]}</span>
        {i.kind === 'designs' ? (
          <Link to="/cables/$id" params={{ id: i.id }} search={i.designRev === undefined ? {} : { rev: i.designRev }} className="min-w-0 truncate text-ink" title={i.label}>
            {i.label ?? 'Unavailable input'}
          </Link>
        ) : url === undefined ? (
          <span className="min-w-0 truncate text-ink" title={i.label}>{i.label ?? 'Unavailable input'}</span>
        ) : (
          <Link to="/library/$kind/$id" params={{ kind: url, id: i.id }} className="min-w-0 truncate text-ink" title={i.label}>
            {i.label ?? 'Unavailable input'}
          </Link>
        )}
        {revText === '' ? null : <span className="shrink-0 font-mono text-2xs text-dim">{revText}</span>}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 pl-1 font-mono text-2xs text-faint">
        {i.artwork === undefined ? null : <span>Saved artwork</span>}
        {i.cover === undefined ? null : <span>cover {i.cover.view}</span>}
        {i.partNumber === undefined ? null : <span>{i.partNumber}</span>}
      </div>
      {i.state !== 'changed' ? null : (
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 pl-1 text-2xs text-warn">
          <span>{(i.changed ?? []).map((c) => CHANGE_TEXT[c]).join(', ')}</span>
          {i.fields === undefined ? null : <span className="font-mono text-dim" title={i.fields.join(', ')}>{i.fields.slice(0, 4).join(', ')}{i.fields.length > 4 ? ` +${i.fields.length - 4}` : ''}</span>}
          {i.latestDesignRev === undefined || i.designRev === undefined || i.latestDesignRev <= i.designRev ? null : <span>now Rev {i.latestDesignRev}</span>}
          {compare === undefined || url === undefined ? null : (
            <Link to="/library/$kind/$id" params={{ kind: url, id: i.id }} search={{ compare }} className="text-accent" data-testid="input-compare" title={i.recordRev === undefined ? `The copy Rev ${props.rev} froze against the record now` : undefined}>
              {i.recordRev === undefined ? 'compare' : `compare r${i.recordRev}`} → now
            </Link>
          )}
        </div>
      )}
    </li>
  );
}

export function InputsPanel(props: { open: boolean; onClose: () => void; design: string; rev: number; inputs: VersionInputs | undefined }): JSX.Element {
  const data = props.inputs;
  const stale = data?.inputs.filter((i) => i.state !== 'same') ?? [];
  const same = data?.inputs.filter((i) => i.state === 'same') ?? [];
  const errorCount = data?.findings.filter((f) => f.severity === 'error').length ?? 0;
  return (
    <Drawer open={props.open} title={`Rev ${props.rev} inputs`} onClose={props.onClose} width={420} testId="version-inputs">
      {data === undefined ? (
        <p className="m-0 text-xs text-faint">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-2xs text-dim">
            {data.source === 'derived'
              ? `Derived from what Rev ${data.rev} froze (saved before inputs were captured; covers unknown).`
              : `Captured automatically ${shortTime(data.capturedAt)} when this version was ${data.source === 'version-edit' ? 'last edited' : 'saved'}. Capturing is not approval.`}
            {' '}The revision draws its own saved copies.
          </p>
          {data.findings.length === 0 ? null : (
            <div className="text-xs" data-testid="version-findings">
              <div className="mb-0.5 font-semibold">Saved with {errorCount} error{errorCount === 1 ? '' : 's'}, {data.findings.length - errorCount} warning{data.findings.length - errorCount === 1 ? '' : 's'}</div>
              <FindingsList max={8} findings={data.findings.map((f) => ({ level: f.severity === 'error' ? 'error' : 'warn', message: f.message }))} />
            </div>
          )}
          <section>
            <h3 className="m-0 mb-1 text-xs font-semibold">Changed since this version {stale.length === 0 ? null : <Badge tone="warn">{stale.length}</Badge>}</h3>
            {stale.length === 0 ? <p className="m-0 text-xs text-faint">Nothing it used has changed.</p> : <ul className="m-0 list-none p-0" data-testid="version-stale">{stale.map((i) => <InputRow key={`${i.kind}/${i.id}`} input={i} design={props.design} rev={props.rev} />)}</ul>}
          </section>
          <section>
            <h3 className="m-0 mb-1 text-xs font-semibold">Unchanged ({same.length})</h3>
            <ul className="m-0 list-none p-0">{same.map((i) => <InputRow key={`${i.kind}/${i.id}`} input={i} design={props.design} rev={props.rev} />)}</ul>
          </section>
        </div>
      )}
    </Drawer>
  );
}

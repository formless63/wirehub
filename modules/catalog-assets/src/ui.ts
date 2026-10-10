import { createElement as h, useEffect, useId, useRef, useState, type ReactElement } from 'react';
import type { ModuleApi, PanelProps, RouteProps } from '@wirehub/modules';
import { DIRECTORIES, KICAD, providerSearches, subjectForRecord, type AssetSubject, type CadCandidate, type Directory } from './discovery.ts';

/** Module UI is server-importable .ts; controls use the host's primitive CSS contract. */
const button = { className: 'cs-ui-btn', 'data-size': 'sm', 'data-variant': 'secondary' };
const link = { ...button, target: '_blank', rel: 'noopener noreferrer' };

function Discovery({ api, subject, identity }: { api: ModuleApi; subject?: AssetSubject; identity: string }): ReactElement {
  const id = useId();
  const [query, setQuery] = useState(subject?.mpn ?? subject?.label ?? '');
  const [directory, setDirectory] = useState<Directory>('Connector_RJ.3dshapes');
  const [filter, setFilter] = useState('');
  const [listing, setListing] = useState<{ candidates: CadCandidate[]; page: number; hasMore: boolean }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setQuery(subject?.mpn ?? subject?.label ?? '');
    setListing(undefined); setError(''); setBusy(false);
    return () => { generation.current += 1; };
  }, [identity, subject?.mpn, subject?.label]);

  const clearListing = () => { generation.current += 1; setListing(undefined); setBusy(false); setError(''); };
  async function load(page = 1) {
    const ticket = ++generation.current;
    setBusy(true); setError(''); setListing(undefined);
    try {
      const params = new URLSearchParams({ directory, page: String(page), q: filter });
      const result = await api('GET', `kicad?${params}`);
      if (ticket !== generation.current) return;
      const body = result.body as { candidates?: CadCandidate[]; page?: number; hasMore?: boolean; error?: string };
      if (result.status !== 200 || !Array.isArray(body.candidates) || typeof body.page !== 'number') throw new Error(body.error ?? 'The CAD listing could not be loaded.');
      setListing({ candidates: body.candidates, page: body.page, hasMore: body.hasMore === true });
    } catch (cause) {
      if (ticket === generation.current) setError(cause instanceof Error ? cause.message : 'The CAD listing could not be loaded.');
    } finally { if (ticket === generation.current) setBusy(false); }
  }

  return h('section', { 'data-testid': 'catalog-assets-discovery', style: { display: 'grid', gap: 'var(--space-md)', minWidth: 0 } },
    h('p', null, 'Find a model for the physical part. Download a STEP file, check its dimensions and contact layout, then use Attach model or Replace model in the Library. Keep the provider citation with the record.'),
    subject?.mpn ? h('p', null, `Manufacturer part number: ${subject.mpn}${subject.manufacturer ? ` (${subject.manufacturer})` : ''}. Search results still need verification.`)
      : h('p', null, 'No manufacturer part number is recorded. These are generic searches; a similarly named model can describe a different part.'),
    h('div', { className: 'cs-ui-field' },
      h('label', { htmlFor: `${id}-query` }, 'Manufacturer part number or search terms'),
      h('input', { id: `${id}-query`, className: 'cs-ui-input', 'data-size': 'sm', value: query, maxLength: 120, onChange: (e: { target: { value: string } }) => setQuery(e.target.value) }),
    ),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)' } },
      ...providerSearches(query).map((provider) => h('a', { ...link, key: provider.id, href: provider.url, title: provider.help }, `Search ${provider.label} ↗`))),
    h('p', { className: 'cs-ui-hint' }, 'External searches open the provider site. Downloads may require a provider account; WireHub does not send provider credentials or copy their catalogs.'),
    h('h3', null, 'Browse KiCad STEP models'),
    h('p', { className: 'cs-ui-hint' }, `Public library ${KICAD.tag}. Models are unverified candidates; connector sockets are not substitutes for cable plugs.`),
    h('div', { role: 'group', 'aria-label': 'KiCad category', style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)' } },
      ...DIRECTORIES.map((dir) => h('button', { ...button, type: 'button', key: dir, 'aria-pressed': directory === dir, 'data-variant': directory === dir ? 'primary' : 'secondary', onClick: () => { clearListing(); setDirectory(dir); } }, dir.replace(/^Connector_?/, '').replace('.3dshapes', '') || 'Other connectors'))),
    h('form', { onSubmit: (e: { preventDefault(): void }) => { e.preventDefault(); void load(); }, style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)', alignItems: 'end' } },
      h('div', { className: 'cs-ui-field', style: { flex: '1 1 12rem', minWidth: 0 } },
        h('label', { htmlFor: `${id}-filter` }, 'Filter file names on this page'),
        h('input', { id: `${id}-filter`, className: 'cs-ui-input', 'data-size': 'sm', value: filter, maxLength: 120, onChange: (e: { target: { value: string } }) => { clearListing(); setFilter(e.target.value); } })),
      h('button', { ...button, type: 'submit', disabled: busy, 'aria-busy': busy || undefined }, busy ? 'Loading models…' : 'Browse KiCad models'),
      h('a', { ...link, href: `${KICAD.project}/-/tree/${KICAD.commit}/${directory}` }, 'Open KiCad catalog ↗')),
    error ? h('p', { role: 'alert' }, error) : null,
    listing ? h('div', { 'aria-live': 'polite', style: { minWidth: 0 } },
      h('p', null, `Page ${listing.page}: ${listing.candidates.length} STEP candidates${filter.trim() ? ' matching this page’s filter' : ''}.`),
      listing.candidates.length === 0 ? h('p', null, 'No STEP models on this page match. Clear the filter, try another category or continue to the next page.') : null,
      h('ul', { style: { listStyle: 'none', padding: 0, display: 'grid', gap: 'var(--space-md)' } },
        ...listing.candidates.map((candidate) => h('li', { key: candidate.path, style: { border: '1px solid var(--line)', borderRadius: 'var(--r-sm)', padding: 'var(--space-md)', overflowWrap: 'anywhere' } },
          h('strong', null, candidate.name), h('p', { className: 'cs-ui-hint' }, 'Candidate — match, dimensions and contact layout not verified.'),
          h('p', { className: 'cs-ui-hint' }, candidate.license),
          h('a', { ...link, href: candidate.url }, 'Download STEP from KiCad ↗'),
          h('details', { style: { marginTop: 'var(--space-sm)' } }, h('summary', null, 'Source citation'), h('p', null, candidate.source), h('a', { href: candidate.url, target: '_blank', rel: 'noopener noreferrer' }, candidate.url))))),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-sm)' } },
        h('button', { ...button, type: 'button', disabled: busy || listing.page === 1, onClick: () => void load(listing.page - 1) }, 'Previous page'),
        h('button', { ...button, type: 'button', disabled: busy || !listing.hasMore, onClick: () => void load(listing.page + 1) }, 'Next page'))) : null,
  );
}

export function AssetDiscoveryPanel(props: PanelProps): ReactElement | null {
  const subject = subjectForRecord(props.db, props.record);
  return subject === undefined ? null : h(Discovery, { api: props.api, subject, identity: `${props.record?.kind}/${props.record?.id}` });
}

export function AssetDiscoveryPage(props: RouteProps): ReactElement {
  return h('div', { style: { maxWidth: '64rem', margin: 'auto', padding: 'var(--space-lg)' } },
    h('h2', null, 'Find CAD models'), h(Discovery, { api: props.api, identity: 'page' }));
}

/**
 * The one map from a place in the app (a route, or a topic) to its documentation.
 * Everything that points at the docs reads it: the `(?)` in the top bar, the
 * "Learn more" of an empty state, the "New hub" strip. For now the targets are
 * the docs in the repository on GitHub; when the docs site exists, repoint
 * `DOCS_BASE` and the entries here and nothing else changes.
 */

export const DOCS_BASE = 'https://github.com/formless63/wirehub/blob/main/docs';
export const REPO_BASE = 'https://github.com/formless63/wirehub/blob/main';

/** A topic names a page of the docs, optionally an anchor on it. */
export type HelpTopic =
  | 'designs'
  | 'new-design'
  | 'library'
  | 'library-connectors'
  | 'library-wires'
  | 'library-components'
  | 'library-pcbas'
  | 'library-mechanicals'
  | 'library-kits'
  | 'library-bodies'
  | 'store'
  | 'resolver'
  | 'products'
  | 'history'
  | 'jobs'
  | 'part-numbers'
  | 'settings'
  | 'modules'
  | 'people'
  | 'tokens'
  | 'documents'
  | 'self-hosting';

const PAGES: Readonly<Record<HelpTopic, string>> = {
  designs: `${REPO_BASE}/README.md`,
  'new-design': `${REPO_BASE}/README.md`,
  library: `${DOCS_BASE}/catalog-store.md`,
  'library-connectors': `${DOCS_BASE}/catalog-store.md`,
  'library-wires': `${DOCS_BASE}/catalog-store.md`,
  'library-components': `${DOCS_BASE}/catalog-store.md`,
  'library-pcbas': `${DOCS_BASE}/catalog-store.md`,
  'library-mechanicals': `${DOCS_BASE}/catalog-store.md`,
  'library-kits': `${DOCS_BASE}/catalog-store.md`,
  'library-bodies': `${DOCS_BASE}/catalog-store.md`,
  store: `${DOCS_BASE}/store-hosting.md`,
  resolver: `${DOCS_BASE}/resolver.md`,
  products: `${DOCS_BASE}/products.md`,
  history: `${DOCS_BASE}/revisions.md`,
  jobs: `${DOCS_BASE}/self-hosting.md`,
  'part-numbers': `${DOCS_BASE}/part-numbers.md`,
  settings: `${DOCS_BASE}/self-hosting.md`,
  modules: `${DOCS_BASE}/modules.md`,
  people: `${DOCS_BASE}/self-hosting.md`,
  tokens: `${DOCS_BASE}/self-hosting.md`,
  documents: `${DOCS_BASE}/exports.md`,
  'self-hosting': `${DOCS_BASE}/self-hosting.md`,
};

export function helpUrl(topic: HelpTopic): string {
  return PAGES[topic];
}

/** The route prefixes, most specific first, and the topic each one is about. */
const ROUTES: readonly (readonly [prefix: string, topic: HelpTopic])[] = [
  ['/library/store', 'store'],
  ['/library/connectors', 'library-connectors'],
  ['/library/wires', 'library-wires'],
  ['/library/components', 'library-components'],
  ['/library/boards', 'library-pcbas'],
  ['/library/pcbas', 'library-pcbas'],
  ['/library/mechanicals', 'library-mechanicals'],
  ['/library/hardware', 'library-mechanicals'],
  ['/library/kits', 'library-kits'],
  ['/library', 'library'],
  ['/cables', 'designs'],
  ['/resolver', 'resolver'],
  ['/products', 'products'],
  ['/history', 'history'],
  ['/jobs', 'jobs'],
  ['/part-numbers', 'part-numbers'],
  ['/settings/people', 'people'],
  ['/settings', 'settings'],
  ['/modules', 'modules'],
  ['/account/tokens', 'tokens'],
];

/** The documentation for a route's pathname, or the front page of the docs when none is more specific. */
export function helpForPath(pathname: string): { topic: HelpTopic | undefined; url: string } {
  const hit = ROUTES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return hit === undefined ? { topic: undefined, url: REPO_BASE + '/README.md' } : { topic: hit[1], url: helpUrl(hit[1]) };
}

/** The Library kinds, by their record-kind name, and their topics. */
export function helpForLibraryKind(kind: string): string {
  const topic = (`library-${kind === 'pcbas' ? 'pcbas' : kind}` as HelpTopic);
  return topic in PAGES ? PAGES[topic] : PAGES.library;
}

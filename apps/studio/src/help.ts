/**
 * The one map from a place in the app (a route, a Settings section, or a topic) to its
 * documentation. Everything that points at the docs reads it: the `(?)` in the top bar, the
 * "Learn more" of an empty state, the "New hub" strip, the Settings section headings and the
 * Docs results of the command palette (`docs-search.ts`).
 *
 * Targets are paths inside the docs site (`site/docs.mjs`; `site/test/docs.test.js` checks that
 * every one exists in the built site, anchor included). The base URL is the public site by
 * default; a hub that hosts its own copy sets `WIREHUB_DOCS_URL`, which the hub settings
 * endpoint returns as `docsUrl` (`hub-settings.browser.ts`).
 */

/** The public documentation site. */
export const DEFAULT_DOCS_BASE = 'https://formless63.github.io/wirehub/docs/';

/** A configured base, as a URL ending in a slash; anything that is not an http(s) URL is the default. */
export function normalizeDocsBase(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (!/^https?:\/\/[^\s]+$/i.test(value)) return DEFAULT_DOCS_BASE;
  return value.endsWith('/') ? value : `${value}/`;
}

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
  | 'setup'
  | 'sign-in'
  | 'self-hosting'
  | 'overview';

/** Each topic's page in the docs site, relative to its base (`page/` or `page/#anchor`). */
const PAGES: Readonly<Record<HelpTopic, string>> = {
  overview: '',
  designs: 'first-design/',
  'new-design': 'first-design/#create-it-with-the-wizard',
  library: 'concepts/#the-library',
  'library-connectors': 'concepts/#the-library',
  'library-wires': 'concepts/#the-library',
  'library-components': 'concepts/#the-library',
  'library-pcbas': 'concepts/#the-library',
  'library-mechanicals': 'concepts/#the-library',
  'library-kits': 'concepts/#the-library',
  'library-bodies': 'concepts/#the-library',
  store: 'reference/catalog-store/#store-sources-adding-stores-in-the-app',
  resolver: 'reference/resolver/#in-the-app',
  products: 'reference/products/#in-the-app',
  history: 'reference/revisions/#in-the-app',
  jobs: 'reference/self-hosting/#jobs-the-worker-service',
  'part-numbers': 'reference/part-numbers/',
  settings: 'reference/self-hosting/#settings',
  modules: 'reference/modules/',
  people: 'quick-start/#invite-people',
  tokens: 'reference/self-hosting/#settings',
  documents: 'reference/exports/#from-the-documents-tab',
  setup: 'quick-start/#first-run-setup',
  'sign-in': 'reference/self-hosting/#github-and-google-sign-in',
  'self-hosting': 'self-hosting-essentials/',
};

/** The Settings sections (`settings-sections.ts`) and the page each one is about. */
const SETTINGS_PAGES: Readonly<Record<string, string>> = {
  documents: 'reference/exports/',
  engineering: 'reference/exports/#continuity-tester-export-and-test-parameters',
  numbering: 'reference/part-numbers/#editing-it',
  rules: 'reference/validation-rules/',
  authentication: 'reference/self-hosting/#github-and-google-sign-in',
  runtime: 'reference/self-hosting/#settings',
  webhooks: 'reference/webhooks/',
  stores: 'reference/catalog-store/#store-sources-adding-stores-in-the-app',
  'module-settings': 'reference/modules/#module-settings-module-api-15',
  modules: 'reference/modules/#runtime-code-modules',
};

/** Every target the map can return, relative to the docs base (the docs test resolves each in the built site). */
export function helpTargets(): string[] {
  return [...new Set([...Object.values(PAGES), ...Object.values(SETTINGS_PAGES)])];
}

export function helpTopics(): HelpTopic[] {
  return Object.keys(PAGES) as HelpTopic[];
}

export function settingsHelpSections(): string[] {
  return Object.keys(SETTINGS_PAGES);
}

export function helpUrl(topic: HelpTopic, base: string = DEFAULT_DOCS_BASE): string {
  return base + PAGES[topic];
}

/** The docs for a Settings section (`/settings?section=…`), or the Settings overview when it is not one. */
export function helpForSettingsSection(section: string, base: string = DEFAULT_DOCS_BASE): string {
  return base + (SETTINGS_PAGES[section] ?? PAGES.settings);
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
  ['/m', 'modules'],
  ['/account/tokens', 'tokens'],
  ['/sign-in', 'sign-in'],
  ['/setup', 'setup'],
];

/** The documentation for a route's pathname, or the front page of the docs when none is more specific. */
export function helpForPath(pathname: string, base: string = DEFAULT_DOCS_BASE): { topic: HelpTopic | undefined; url: string } {
  const hit = ROUTES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return hit === undefined ? { topic: undefined, url: helpUrl('overview', base) } : { topic: hit[1], url: helpUrl(hit[1], base) };
}

/** The Library kinds, by their record-kind name, and their topics. */
export function helpForLibraryKind(kind: string, base: string = DEFAULT_DOCS_BASE): string {
  const topic = `library-${kind}` as HelpTopic;
  return topic in PAGES ? helpUrl(topic, base) : helpUrl('library', base);
}

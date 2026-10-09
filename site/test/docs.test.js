// The documentation site (/docs/): the guide and reference pages, working nav and search data, no broken
// internal link or anchor, the app's tokens verbatim, and every help-link target the app uses.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildDocsFiles, buildSite } from '../build.mjs';
import { GUIDE, REFERENCE, REPO, docsAssets, slugify } from '../docs.mjs';
import { DEFAULT_DOCS_BASE, helpForPath, helpForSettingsSection, helpTargets, helpTopics, helpUrl, normalizeDocsBase, settingsHelpSections } from '../../apps/studio/src/help.ts';
import { SETTINGS_SECTIONS } from '../../apps/studio/src/settings-sections.ts';
import { loadDocsIndex, searchDocs } from '../../apps/studio/src/docs-search.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const docs = new Map(buildDocsFiles(root));
const pages = [...docs].filter(([path]) => path.endsWith('.html'));
const siteFiles = new Map(buildSite(root));
const html = (path) => String(docs.get(path));
const idsOf = (source) => new Set([...source.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

/** Resolves `target` (docs-relative, `page/` or `page/#anchor`) in the built docs; returns a problem or undefined. */
function problemWith(target) {
  const [path, hash] = target.split('#');
  const file = path === '' || path.endsWith('/') ? `${path}index.html` : path;
  const body = docs.get(file);
  if (body === undefined) return `no such page: ${file}`;
  if (hash !== undefined && hash !== '' && !idsOf(String(body)).has(hash)) return `no anchor #${hash} in ${file}`;
  return undefined;
}

describe('the docs site', () => {
  it('has a curated guide of at most four pages, then the reference', () => {
    expect(GUIDE.length).toBeLessThanOrEqual(4);
    expect(GUIDE.map((g) => g.slug)).toEqual(['quick-start', 'first-design', 'concepts', 'self-hosting-essentials']);
    expect(REFERENCE.map((r) => r.slug)).toEqual(expect.arrayContaining(['modules', 'exports', 'resolver', 'products', 'revisions', 'part-numbers', 'validation-rules', 'webhooks', 'catalog-store', 'store-hosting', 'self-hosting']));
    expect(pages.map(([p]) => p).sort()).toEqual(['index.html', ...GUIDE.map((g) => `${g.slug}/index.html`), ...REFERENCE.map((r) => `reference/${r.slug}/index.html`)].sort());
  });

  it('is published inside the site, with the shared nav pointing at /docs/', () => {
    const site = new Map(buildSite(root));
    expect(site.get('docs/index.html')).toBe(docs.get('index.html'));
    expect(String(site.get('index.html'))).toContain('href="docs/"');
    expect([...site.keys()]).toContain('docs/search-index.json');
    expect([...site.keys()]).toContain('.nojekyll');
    // the store index belongs to the store workflow step, never to this build
    expect([...site.keys()].filter((p) => p.startsWith('store/'))).toEqual(['store/index.html']);
  });

  it('every page has a title, one h1, the nav with itself marked, search and the skip link', () => {
    for (const [path, page] of pages) {
      const source = String(page);
      expect(source, path).toMatch(/<title>[^<]+<\/title>/);
      expect(source.match(/<h1[\s>]/g)?.length, path).toBe(1);
      expect(source, path).toContain('id="docs-search"');
      expect(source, path).toContain('class="skip"');
      expect(source, path).toContain('aria-label="Documentation"');
      expect(source, path).toContain('aria-current="page"');
      expect(source, path).toContain("script-src 'self'");
    }
  });

  it('shares the app tokens verbatim and ships IBM Plex', () => {
    const css = String(docs.get('assets/docs.css'));
    expect(css).toContain(readFileSync(join(root, 'packages/editor-react/src/tokens.css'), 'utf8'));
    expect(css).toContain("font-family:'IBM Plex Sans'");
    for (const [path] of docsAssets(root).filter(([p]) => p.endsWith('.woff2'))) expect(docs.has(path), path).toBe(true);
    // no copied hex palette in the docs' own rules
    const own = ['docs', 'chrome'].map((f) => readFileSync(join(root, `site/src/${f}.css`), 'utf8')).join('\n').replace(/\[data-theme='(dark|light)'\] \.site-head[^\n]*\n/g, '');
    expect(own.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });

  it('has no broken internal link, asset reference or anchor', () => {
    let checked = 0;
    for (const [path, page] of pages) {
      const source = String(page);
      const dir = posix.dirname(`docs/${path}`);
      for (const m of source.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
        const url = m[1];
        if (/^(https?:|mailto:|data:)/.test(url)) continue;
        if (url.startsWith('#')) {
          expect(idsOf(source).has(url.slice(1)), `${path}: ${url}`).toBe(true);
          checked += 1;
          continue;
        }
        // resolve against the page, then look in the whole site
        const [rel, hash] = url.split('#');
        let target = posix.normalize(posix.join(dir, rel)).replace(/^\.\//, '');
        if (target === '.' || target === '') target = 'index.html';
        else if (target.endsWith('/')) target += 'index.html';
        const found = siteFiles.get(target);
        expect(found, `${path}: ${url} -> ${target}`).toBeDefined();
        if (hash !== undefined && hash !== '' && target.endsWith('.html')) expect(idsOf(String(found)).has(hash), `${path}: ${url} anchor`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });

  it('links to repository files that exist', () => {
    const seen = new Set();
    for (const [path, page] of pages) {
      for (const m of String(page).matchAll(new RegExp(`href="${REPO}/(?:blob|tree)/main/([^"#]+)`, 'g'))) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        expect(existsSync(join(root, m[1])), `${path}: ${m[1]}`).toBe(true);
      }
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it('builds a search index whose every entry resolves, and finds the obvious things', () => {
    const index = JSON.parse(String(docs.get('search-index.json')));
    expect(index.length).toBeGreaterThan(150);
    for (const e of index) expect(problemWith(e.u), `${e.t} / ${e.h}`).toBeUndefined();
    const find = (q) => index.filter((e) => `${e.t} ${e.h} ${e.x}`.toLowerCase().includes(q)).map((e) => e.u);
    expect(find('setup code').some((u) => u.startsWith('quick-start/'))).toBe(true);
    expect(find('webhook').some((u) => u.startsWith('reference/webhooks/'))).toBe(true);
  });

  it('shows real images in the guide, none of them a placeholder, each one shipped with the site', () => {
    const site = new Map(buildSite(root));
    let seen = 0;
    for (const [path, page] of pages) {
      const source = String(page);
      expect(source, path).not.toContain('data-placeholder');
      for (const m of source.matchAll(/<img src="([^"]*)" alt="([^"]*)"/g)) {
        seen += 1;
        expect(m[2].length, `${path}: alt of ${m[1]}`).toBeGreaterThan(20);
        const target = posix.normalize(posix.join(posix.dirname(`docs/${path}`), m[1]));
        expect(site.has(target), `${path}: ${m[1]}`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(5);
    expect(html('first-design/index.html')).toContain('assets/media/guide-wizard.gif');
  });

  it('slugs headings the way GitHub does, so links written for GitHub keep working', () => {
    expect(slugify('Jobs: the `worker` service'.replace(/`/g, ''))).toBe('jobs-the-worker-service');
    expect(slugify('Backups — recommended (COMPOSE_PROFILES=backup)')).toBe('backups--recommended-compose_profilesbackup');
  });
});

describe('the app\'s help links', () => {
  it('resolves every mapped target in the built docs, anchor included', () => {
    const targets = helpTargets();
    expect(targets.length).toBeGreaterThan(10);
    for (const t of targets) expect(problemWith(t), t).toBeUndefined();
  });

  it('maps every topic, every Settings section and every route of the app', () => {
    for (const topic of helpTopics()) expect(helpUrl(topic).startsWith(DEFAULT_DOCS_BASE), topic).toBe(true);
    expect(settingsHelpSections().sort()).toEqual(SETTINGS_SECTIONS.map((s) => s.id).sort());
    for (const s of SETTINGS_SECTIONS) {
      const url = helpForSettingsSection(s.id);
      expect(url.startsWith(DEFAULT_DOCS_BASE), s.id).toBe(true);
      expect(problemWith(url.slice(DEFAULT_DOCS_BASE.length)), s.id).toBeUndefined();
    }
    const router = readFileSync(join(root, 'apps/studio/src/router.tsx'), 'utf8');
    const paths = [...router.matchAll(/path: '(\/[^']*)'/g)].map((m) => m[1].replace(/\$\w+/g, 'x').replace(/\/x\/\*?$/, '/x'));
    expect(paths).toContain('/cables/x');
    for (const path of paths) {
      if (path === '/' || path.startsWith('/dev/')) continue; // the index route redirects to the designs list; /dev is development only
      const { topic, url } = helpForPath(path);
      expect(topic, path).toBeDefined();
      expect(problemWith(url.slice(DEFAULT_DOCS_BASE.length)), path).toBeUndefined();
    }
    expect(helpForPath('/nowhere').url).toBe(DEFAULT_DOCS_BASE);
  });

  it('takes a configured base, falling back to the public site', () => {
    expect(normalizeDocsBase(undefined)).toBe(DEFAULT_DOCS_BASE);
    expect(normalizeDocsBase('javascript:alert(1)')).toBe(DEFAULT_DOCS_BASE);
    expect(normalizeDocsBase('https://docs.example.org/wh')).toBe('https://docs.example.org/wh/');
    expect(helpForPath('/resolver', 'https://docs.example.org/wh/').url).toBe('https://docs.example.org/wh/reference/resolver/#in-the-app');
  });
});

describe('the command palette index', () => {
  it('is the committed apps/studio/src/docs-index.json (regenerate with `node site/build.mjs docs-index apps/studio/src/docs-index.json`)', async () => {
    const committed = readFileSync(join(root, 'apps/studio/src/docs-index.json'), 'utf8');
    const fresh = (await import('../docs.mjs')).docsIndexJson(root, { favicon: '', header: () => '', footer: '' });
    expect(committed).toBe(fresh);
  });

  it('points at real pages and finds docs by heading', async () => {
    const index = await loadDocsIndex();
    for (const e of index) expect(problemWith(e.path), e.path).toBeUndefined();
    expect(searchDocs(index, 'webhooks')[0]?.path).toMatch(/^reference\/webhooks\//);
    expect(searchDocs(index, 'first-run setup').map((e) => e.path)).toContain('quick-start/#first-run-setup');
    expect(searchDocs(index, 'zzzzqq')).toEqual([]);
    expect(statSync(join(root, 'apps/studio/src/docs-index.json')).size).toBeLessThan(40_000);
  });
});

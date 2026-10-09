// The documentation site, /docs/: a lean Markdown build.
//
//   guide pages      site/docs/*.md             hand-written, the newcomer path (frontmatter: title, summary)
//   reference pages  docs/*.md                  the repository's reference documents, rendered as they are
//
// A guide page's links are written as published (`../concepts/`, `../../generator/`); a reference page's
// are the repository's own relative links, resolved below.
//
// Both are rendered with `marked` (one pinned dev dependency, no runtime dependency in the page), into
// static HTML that shares the site's shell. Styled with the app's own design tokens: the output carries
// `packages/editor-react/src/tokens.css` verbatim, so the docs repaint when the tokens do. Fonts are the
// app's IBM Plex, copied from the same packages the app bundles. Search is a static index (search-index.json)
// read by a small script; the app's command palette reads a titles-and-headings subset (docs-index.json).
//
// Links: a relative link in a source document is resolved against the repository. A link to another
// document that has a docs page becomes a link to that page (and its #anchor); any other repository
// path becomes a link to the file on GitHub. test/docs.test.js checks every internal link and anchor.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Marked } from 'marked';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

export const REPO = 'https://github.com/formless63/wirehub';
/** The public docs: the default the app's help links point at (`apps/studio/src/help.ts`). */
export const DOCS_URL = 'https://formless63.github.io/wirehub/docs/';

/** The curated guide, in reading order. `file` is under site/docs/. */
export const GUIDE = [
  { slug: 'quick-start', file: 'quick-start.md' },
  { slug: 'first-design', file: 'first-design.md' },
  { slug: 'concepts', file: 'concepts.md' },
  { slug: 'self-hosting-essentials', file: 'self-hosting-essentials.md' },
];

/** The reference pages, generated from the repository's documents. */
export const REFERENCE = [
  { slug: 'modules', source: 'docs/modules.md', title: 'Modules' },
  { slug: 'exports', source: 'docs/exports.md', title: 'Exports' },
  { slug: 'resolver', source: 'docs/resolver.md', title: 'Resolver' },
  { slug: 'products', source: 'docs/products.md', title: 'Products' },
  { slug: 'revisions', source: 'docs/revisions.md', title: 'Revisions' },
  { slug: 'part-numbers', source: 'docs/part-numbers.md', title: 'Part numbers' },
  { slug: 'validation-rules', source: 'docs/validation-rules.md', title: 'Validation rules' },
  { slug: 'webhooks', source: 'docs/webhooks.md', title: 'Webhooks' },
  { slug: 'interop', source: 'docs/interop.md', title: 'Interop and costing' },
  { slug: 'catalog-store', source: 'docs/catalog-store.md', title: 'Catalog store' },
  { slug: 'store-hosting', source: 'docs/store-hosting.md', title: 'Store hosting' },
  { slug: 'self-hosting', source: 'docs/self-hosting.md', title: 'Self-hosting (full)' },
];

const read = (repoRoot, path) => readFileSync(join(repoRoot, path), 'utf8');
const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A heading's anchor, the way GitHub makes it (so links written for GitHub keep working). */
export function slugify(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, '')
    .replace(/ /g, '-');
}

/** Markdown inline syntax removed, for a heading's text and the search index. */
function plain(text) {
  return String(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function frontmatter(source) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (m === null) return { meta: {}, body: source };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv !== null) meta[kv[1]] = kv[2];
  }
  return { meta, body: source.slice(m[0].length) };
}

/** Where a page lives: path under the docs root, as a directory with an index.html. */
function pageDir(page) {
  return page.kind === 'reference' ? `reference/${page.slug}/` : `${page.slug}/`;
}

/** The pages (metadata only), in nav order. */
export function listPages(repoRoot = root) {
  const pages = [];
  for (const g of GUIDE) {
    const { meta } = frontmatter(read(repoRoot, `site/docs/${g.file}`));
    pages.push({ kind: 'guide', slug: g.slug, source: `site/docs/${g.file}`, title: meta.title ?? g.slug, summary: meta.summary ?? '' });
  }
  for (const r of REFERENCE) pages.push({ kind: 'reference', slug: r.slug, source: r.source, title: r.title, summary: '' });
  return pages;
}

const ref = (page) => `${pageDir(page)}`;

/** Render one page's markdown. `links` maps a repository path to its docs page. */
export function renderMarkdown({ markdown, source, pages, depth, repoRoot = root, siteRelative = false }) {
  const bySource = new Map(pages.map((p) => [p.source, p]));
  const all = []; // every heading, in document order: { depth, id, text }
  const used = new Map();
  const up = '../'.repeat(depth);

  const resolveHref = (href) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return href; // absolute
    if (href.startsWith('#') || siteRelative) return href; // a guide page's links are written relative to the page as published
    const [pathPart, ...rest] = href.split('#');
    const hash = rest.length > 0 ? `#${rest.join('#')}` : '';
    if (pathPart === '') return href;
    const repoPath = posix.normalize(posix.join(posix.dirname(source), pathPart));
    const target = bySource.get(repoPath);
    if (target !== undefined) return `${up}${ref(target)}${hash}`;
    if (repoPath.startsWith('..')) return href; // outside the repository: left for the link check to flag
    const isDir = existsSync(join(repoRoot, repoPath)) && statSync(join(repoRoot, repoPath)).isDirectory();
    return `${REPO}/${isDir ? 'tree' : 'blob'}/main/${repoPath.replace(/\/$/, '')}${hash}`;
  };

  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth: level }) {
        const inner = this.parser.parseInline(tokens);
        const text = plain(tokens.map((t) => t.raw ?? t.text ?? '').join(''));
        let id = slugify(text);
        const n = used.get(id) ?? 0;
        used.set(id, n + 1);
        if (n > 0) id = `${id}-${n}`;
        all.push({ depth: level, id, text });
        return `<h${level} id="${esc(id)}">${inner}${level >= 2 ? `<a class="anchor" href="#${esc(id)}" aria-label="Link to this section">#</a>` : ''}</h${level}>\n`;
      },
      link({ href, title, tokens }) {
        const to = resolveHref(href);
        const external = /^https?:/i.test(to);
        return `<a href="${esc(to)}"${title ? ` title="${esc(title)}"` : ''}${external ? ' rel="noopener"' : ''}>${this.parser.parseInline(tokens)}</a>`;
      },
      image({ href, title, text }) {
        const m = /^PLACEHOLDER (screenshot|gif):\s*(.*)$/.exec(text);
        if (href === 'placeholder' && m !== null) {
          return `<span class="placeholder" role="img" aria-label="${esc(`${m[1]} to come: ${m[2]}`)}" data-placeholder="${m[1]}"><span class="placeholder-kind">${m[1] === 'gif' ? 'GIF' : 'Screenshot'} to come</span><span class="placeholder-text">${esc(m[2])}</span></span>`;
        }
        // `media/x` names a file of the site's shared images (assets/media/ at the site root, one level above /docs/)
        const src = href.startsWith('media/') ? `${up}../assets/${href}` : href;
        return `<img src="${esc(src)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ''} loading="lazy" decoding="async">`;
      },
      table(token) {
        const head = token.header.map((c, i) => `<th scope="col"${token.align[i] ? ` align="${token.align[i]}"` : ''}>${c.tokens.length === 0 ? '<span class="sr-only">Item</span>' : this.parser.parseInline(c.tokens)}</th>`).join('');
        const rows = token.rows.map((r) => `<tr>${r.map((c, i) => `<td${token.align[i] ? ` align="${token.align[i]}"` : ''}>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('\n');
        return `<div class="table-wrap" role="region" tabindex="0" aria-label="Table"><table><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table></div>\n`;
      },
      code({ text, lang }) {
        const l = (lang ?? '').trim().split(/\s+/)[0];
        return `<pre tabindex="0"><code${l ? ` class="language-${esc(l)}"` : ''}>${esc(text)}\n</code></pre>\n`;
      },
    },
  });
  const tokens = marked.lexer(markdown);
  const html = marked.parser(tokens);
  // search sections: the text under each top-level heading (the page's own H1 section has no heading of its own)
  const tops = tokens.filter((t) => t.type === 'heading');
  if (tops.length !== all.length) throw new Error(`${source}: a heading nested inside another block would get an anchor the search cannot see`);
  const sections = [];
  let section = { heading: '', id: '', text: [] };
  let at = 0;
  for (const token of tokens) {
    if (token.type === 'heading') {
      sections.push(section);
      const h = all[at++];
      section = { heading: h.depth === 1 ? '' : h.text, id: h.depth === 1 ? '' : h.id, text: [] };
    } else if (token.type !== 'space' && token.type !== 'html') {
      const text = plain(token.raw ?? '');
      if (text !== '') section.text.push(text);
    }
  }
  sections.push(section);
  return { html, headings: all.filter((h) => h.depth >= 2), sections: sections.filter((s) => s.text.length > 0 || s.heading !== '') };
}

const groupsOf = (pages) => [
  { label: 'Guide', pages: pages.filter((p) => p.kind === 'guide') },
  { label: 'Reference', pages: pages.filter((p) => p.kind === 'reference') },
];

function navHtml(pages, current, up) {
  const home = `<a href="${up}./"${current === undefined ? ' aria-current="page"' : ''}>Overview</a>`;
  const groups = groupsOf(pages)
    .map((g) => `<div class="nav-group"><h2>${g.label}</h2><ul>${g.pages.map((p) => `<li><a href="${up}${ref(p)}"${current === p ? ' aria-current="page"' : ''}>${esc(p.title)}</a></li>`).join('')}</ul></div>`)
    .join('\n');
  return `<nav class="docs-nav" id="docs-nav" aria-label="Documentation">${`<div class="nav-group"><ul><li>${home}</li></ul></div>`}\n${groups}</nav>`;
}

export const DOCS_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";

/** IBM Plex, as @font-face rules (font files at `fonts/` beside the stylesheet) and the files themselves. */
export function fontAssets(repoRoot = root) {
  const sans = (w) => readFileSync(join(repoRoot, `site/node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-${w}-normal.woff2`));
  const mono = readFileSync(join(repoRoot, 'site/node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'));
  const fontFaces = [
    ['ibm-plex-sans-400.woff2', 'IBM Plex Sans', 400, sans(400)],
    ['ibm-plex-sans-500.woff2', 'IBM Plex Sans', 500, sans(500)],
    ['ibm-plex-sans-600.woff2', 'IBM Plex Sans', 600, sans(600)],
    ['ibm-plex-mono-400.woff2', 'IBM Plex Mono', 400, mono],
  ];
  const faces = fontFaces.map(([file, family, weight]) => `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;font-display:swap;src:url(fonts/${file}) format('woff2')}`).join('\n');
  return { faces, files: fontFaces.map(([file, , , data]) => [`fonts/${file}`, data]) };
}

/** The app's tokens verbatim (THE source of the palette, type scale, radii and motion), then the shared chrome. */
export function sharedCss(repoRoot = root) {
  return `${read(repoRoot, 'packages/editor-react/src/tokens.css')}\n${read(repoRoot, 'site/src/chrome.css')}`;
}

/** The images the site shows: the repository's own README images (docs/assets/) and the guide's (site/media/), published at assets/media/ of the site root. */
export function mediaAssets(repoRoot = root) {
  const out = [];
  for (const dir of ['docs/assets', 'site/media']) {
    const at = join(repoRoot, dir);
    if (!existsSync(at)) continue;
    for (const name of readdirSync(at).sort()) if (/\.(webp|gif|png|jpe?g|svg)$/.test(name)) out.push([`assets/media/${name}`, readFileSync(join(at, name))]);
  }
  return out;
}

/** The assets every docs page links, as [docs-relative path, contents]. */
export function docsAssets(repoRoot = root) {
  const { faces, files } = fontAssets(repoRoot);
  const css = `/* generated by site/docs.mjs: the app's tokens (packages/editor-react/src/tokens.css), the shared chrome, then the docs' own rules */\n${faces}\n${sharedCss(repoRoot)}\n${read(repoRoot, 'site/src/docs.css')}`;
  return [
    ['assets/docs.css', css],
    ['assets/docs.js', read(repoRoot, 'site/src/docs.js')],
    ...files.map(([path, data]) => [`assets/${path}`, data]),
  ];
}

/** The theme is applied from a tiny head script (assets/theme.js) so there is no flash. */
export function themeScript() {
  return `(function(){try{var t=localStorage.getItem('wirehub-docs-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}document.documentElement.classList.add('js')})();\n`;
}

function layout({ repoRoot, title, description, depth, pages, current, bodyHtml, headings, shell }) {
  const up = '../'.repeat(depth); // to the docs root
  const toc = headings.filter((h) => h.depth === 2 || h.depth === 3);
  const tocHtml = toc.length < 2 ? '' : `<nav class="docs-toc" aria-label="On this page"><h2>On this page</h2><ul>${toc.map((h) => `<li class="d${h.depth}"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`).join('')}</ul></nav>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${DOCS_CSP}">
${shell.social === undefined ? `<meta name="description" content="${esc(description)}">` : shell.social(title, description)}
<title>${esc(title)}</title>
<link rel="icon" href="${shell.favicon}">
<link rel="stylesheet" href="${up}assets/docs.css">
<script src="${up}assets/theme.js"></script>
<script src="${up}assets/docs.js" defer data-root="${up || './'}"></script>
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
${shell.header(depth + 1)}
<div class="docs-bar">
  <button type="button" class="nav-toggle" aria-expanded="false" aria-controls="docs-nav">Menu</button>
  <div class="search" role="search">
    <label class="sr-only" for="docs-search">Search the docs</label>
    <input id="docs-search" type="search" placeholder="Search the docs" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="docs-results" aria-autocomplete="list" spellcheck="false">
    <kbd aria-hidden="true">/</kbd>
    <ul id="docs-results" role="listbox" aria-label="Search results" hidden></ul>
  </div>
  <button type="button" class="theme-toggle" title="Switch between light and dark">Theme</button>
</div>
<div class="docs-shell">
  ${navHtml(pages, current, up)}
  <main id="content" class="docs-main" tabindex="-1">
    <article class="doc">
${bodyHtml}
    </article>
    <p class="edit-link">${current === undefined ? '' : `<a href="${REPO}/blob/main/${current.source}" rel="noopener">Edit this page on GitHub</a>`}</p>
  </main>
  ${tocHtml}
</div>
${shell.footer}
</body>
</html>
`;
}

/** Everything under /docs/, as [path relative to the docs root, contents], plus the two indexes. */
export function buildDocsSite({ repoRoot = root, shell }) {
  const pages = listPages(repoRoot);
  const files = [];
  const search = [];
  const appIndex = [];
  const entry = (page, section, text) => ({ t: page.title, h: section.heading, u: `${ref(page)}${section.id === '' ? '' : `#${section.id}`}`, x: text.slice(0, 420) });

  // overview
  const overviewCards = (p) => `<li><a href="${ref(p)}"><strong>${esc(p.title)}</strong>${p.summary ? `<span>${esc(p.summary)}</span>` : ''}</a></li>`;
  const overview = `<h1>WireHub documentation</h1>
<p class="lede">How to run WireHub, make your first design and get a build sheet out of it. Then the reference: modules, exports, the resolver, products, revisions, part numbers, rules, webhooks and the catalog store.</p>
<h2 id="guide">Start here<a class="anchor" href="#guide" aria-label="Link to this section">#</a></h2>
<ol class="cards">${pages.filter((p) => p.kind === 'guide').map(overviewCards).join('')}</ol>
<h2 id="reference">Reference<a class="anchor" href="#reference" aria-label="Link to this section">#</a></h2>
<ul class="cards compact">${pages.filter((p) => p.kind === 'reference').map(overviewCards).join('')}</ul>
`;
  files.push(['index.html', layout({ repoRoot, title: 'WireHub docs', description: 'Documentation for WireHub: install, first design, concepts and reference.', depth: 0, pages, current: undefined, bodyHtml: overview, headings: [], shell })]);
  search.push({ t: 'WireHub documentation', h: '', u: '', x: 'How to run WireHub, make your first design and get a build sheet out of it.' });

  for (const page of pages) {
    const raw = read(repoRoot, page.source);
    const { body } = page.kind === 'guide' ? frontmatter(raw) : { body: raw };
    const depth = page.kind === 'reference' ? 2 : 1;
    const { html, headings, sections } = renderMarkdown({ markdown: body, source: page.source, pages, depth, repoRoot, siteRelative: page.kind === 'guide' });
    const lead = page.kind === 'reference' ? `<p class="source-note">Reference. Generated from <a href="${REPO}/blob/main/${page.source}" rel="noopener"><code>${page.source}</code></a>.</p>\n` : '';
    // the page's own H1 is kept as the page heading
    const withLead = html.replace(/(<\/h1>\n)/, `$1${lead}`);
    files.push([`${pageDir(page)}index.html`, layout({ repoRoot, title: `${page.title} - WireHub docs`, description: page.summary || `${page.title}: WireHub reference.`, depth, pages, current: page, bodyHtml: withLead, headings, shell })]);
    for (const s of sections) {
      const text = s.text.join(' ');
      search.push(entry(page, s, text));
      if (s.heading === '') appIndex.push({ title: page.title, heading: '', path: ref(page) });
      else if (headings.some((h) => h.id === s.id && h.depth <= 3)) appIndex.push({ title: page.title, heading: s.heading, path: `${ref(page)}#${s.id}` });
    }
  }
  files.push(['search-index.json', `${JSON.stringify(search)}\n`]);
  return { files, pages, appIndex };
}

/** The titles-and-headings index the app's command palette ships (`apps/studio/src/docs-index.json`). */
export function docsIndexJson(repoRoot = root, shell = { favicon: '', header: () => '', footer: '' }) {
  const { appIndex } = buildDocsSite({ repoRoot, shell });
  return `[\n${appIndex.map((e) => JSON.stringify(e)).join(',\n')}\n]\n`;
}

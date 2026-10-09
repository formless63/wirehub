// Builds the whole site into site/dist:
//
//   /                 home
//   /generator/       the config generator
//   /docs/            the documentation (docs.mjs: a Markdown build; guide + reference, search, styled with the app's tokens)
//   /store/index.html the human-browsable module store (reads the store's own index.json)
//
//   node site/build.mjs [outDir]
//   node site/build.mjs store-page <out.html> [--name <store name>]   (the page alone, for third-party stores)
//   node site/build.mjs docs-index <out.json>   (the titles-and-headings index the app's command palette ships)
//
// Every page carries the shared shell (header, nav, footer) and is one self-contained file.
// The generator embeds, at build time, the repository's compose.yaml (the template
// the generator edits — its default output is that file, byte for byte), the
// bundled domain modules' labels and descriptions (modules/*/src/index.ts)
// and the brand marks. Everything is inlined — styles, script, templates — so
// the page makes no request at all, works when saved and opened from disk,
// and has nothing to send anywhere.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Resvg } from '@resvg/resvg-js';

import { buildDocsSite, docsAssets, docsIndexJson, fontAssets, mediaAssets, sharedCss, themeScript } from './docs.mjs';

const site = dirname(fileURLToPath(import.meta.url));
const root = join(site, '..');

export { readModules, readTemplates } from './templates.mjs';
import { readTemplates } from './templates.mjs';

/** An ES module's source as a plain script: imports dropped, `export` keywords removed. */
export function asScript(source) {
  return source
    .split('\n')
    .filter((line) => !/^import\s/.test(line))
    .map((line) => line.replace(/^export (?=(const|function|let|class|async) )/, ''))
    .join('\n');
}

const REPO = 'https://github.com/formless63/wirehub';
const read = (repoRoot, path) => readFileSync(join(repoRoot, path), 'utf8');
const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The site's pages: where each lives, its nav label, and how deep (for relative links; Pages serves under /wirehub/, so nothing is root-absolute). */
export const NAV = [
  { id: 'home', label: 'Home', path: '' },
  { id: 'generator', label: 'Config generator', path: 'generator/' },
  { id: 'store', label: 'Module store', path: 'store/' },
  { id: 'docs', label: 'Docs', path: 'docs/' },
];

export const SITE_URL = 'https://formless63.github.io/wirehub/';
export const SOCIAL_IMAGE = `${SITE_URL}social.png`;
export const TAGLINE = 'Cable assemblies as canonical definitions: schematics, build sheets, BOMs and continuity specs derived from one model.';

/** The description and the OpenGraph / Twitter card tags: the same card (social.png) for every page. */
export function socialMeta(title, description = TAGLINE) {
  const d = escapeHtml(description);
  return `<meta name="description" content="${d}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="WireHub">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${SOCIAL_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="WireHub">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${SOCIAL_IMAGE}">`;
}

/** The social card, rendered from brand/wirehub-social.svg (no text in it, so the same bytes on every machine). */
export function socialCardPng(repoRoot = root) {
  return new Resvg(read(repoRoot, 'brand/wirehub-social.svg'), { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
}

const logoSvg = (repoRoot) => read(repoRoot, 'brand/wirehub-logo.svg').replace(/<\?xml[^>]*>\s*/, '');
const favicon = (repoRoot) => `data:image/svg+xml,${encodeURIComponent(read(repoRoot, 'brand/wirehub-mark.svg'))}`;

/** The shared header and nav. `depth` is how many directories below the site root the page is. */
export function renderHeader({ repoRoot = root, depth, current }) {
  const up = '../'.repeat(depth);
  const links = NAV.map((n) => `<a href="${up}${n.path || './'}"${n.id === current ? ' aria-current="page"' : ''}>${escapeHtml(n.label)}</a>`);
  links.push(`<a href="${REPO}" rel="noopener">GitHub</a>`);
  return `<header class="site-head"><div class="bar">
  <a class="brand" href="${up}./" aria-label="WireHub home">${logoSvg(repoRoot)}</a>
  <nav aria-label="Site">${links.join('\n  ')}</nav>
</div></header>`;
}

const FOOT = `<footer class="site-foot">WireHub is free software (AGPL-3.0). Source and docs: <a href="${REPO}">github.com/formless63/wirehub</a></footer>`;

const PROSE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
export const STORE_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'";
export const GENERATOR_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";

/** A page in the shell. `body` is trusted HTML. */
function page({ repoRoot, title, csp, css, stylesheet, depth, current, body, script = '', description, skip = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(title)}</title>
${socialMeta(title, description)}
<link rel="icon" href="${favicon(repoRoot)}">
${stylesheet === undefined ? `<style>${css}</style>` : `<link rel="stylesheet" href="${stylesheet}">`}
</head>
<body>
${skip ? '<a class="skip" href="#main">Skip to content</a>\n' : ''}${renderHeader({ repoRoot, depth, current })}
${body}
${FOOT}
${script === '' ? '' : `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`}
</body>
</html>
`;
}

/** The home page's own CSP: its stylesheet and fonts come from the site (one request each), nothing from anywhere else. */
export const HOME_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'";

/** The size of a lossy WebP (what the page needs to reserve its box), or undefined for anything else. */
export function webpSize(buf) {
  if (buf.length < 30 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP' || buf.toString('ascii', 12, 16) !== 'VP8 ') return undefined;
  return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
}

/** What the home page shows of the product: the hero, and one thumbnail per document. All from docs/assets/, shared with the README. */
const HOME_DOCS = [
  { file: 'doc-schematic.webp', name: 'Schematic', alt: 'Schematic of an XLR microphone cable with its cross-section', note: 'Laid out for you, with a legend and the stock cross-section.' },
  { file: 'doc-build-sheet.webp', name: 'Build sheet', alt: 'Build sheet: parts to pull and the cut list', note: 'The bench flow, one stage per step.' },
  { file: 'doc-continuity-spec.webp', name: 'Continuity spec', alt: 'Continuity spec: test parameters and the nets to probe', note: 'What must connect, and what must stay isolated.' },
  { file: 'doc-drawing-sheet.webp', name: 'Drawing sheet', alt: 'Drawing sheet with bill of materials and title block', note: 'BOM, outline and title block on a framed sheet.' },
];

/** The home page's assets (site root `assets/`): its stylesheet (the app's tokens, the shared chrome, IBM Plex, then home.css), the fonts and the shared images. */
export function homeAssets(repoRoot = root) {
  const { faces, files } = fontAssets(repoRoot);
  const css = `/* generated by site/build.mjs: IBM Plex, the app's tokens (packages/editor-react/src/tokens.css), the shared chrome, then the home page's own rules */\n${faces}\n${sharedCss(repoRoot)}\n${read(repoRoot, 'site/src/home.css')}`;
  return [['assets/home.css', css], ...files.map(([path, data]) => [`assets/${path}`, data]), ...mediaAssets(repoRoot)];
}

export function buildHome(repoRoot = root) {
  const img = (file, alt, attrs = '') => {
    const size = webpSize(readFileSync(join(repoRoot, 'docs/assets', file)));
    return `<img src="assets/media/${file}" alt="${escapeHtml(alt)}"${size === undefined ? '' : ` width="${size.width}" height="${size.height}"`}${attrs}>`;
  };
  const strip = HOME_DOCS.map((d) => `<li><figure>${img(d.file, d.alt, ' loading="lazy" decoding="async"')}<figcaption><strong>${d.name}</strong><span>${d.note}</span></figcaption></figure></li>`).join('\n      ');
  const body = `<main id="main" class="home">
  <section class="hero" aria-labelledby="hero-title">
    <h1 id="hero-title">Cable assemblies as canonical definitions</h1>
    <p class="lede">Define each cable once. WireHub derives the schematic, build sheet, BOM, continuity spec and drawing from it, the same bytes every time. Self-hosted, free software.</p>
    <div class="cta">
      <a class="primary" href="docs/quick-start/">Quick start</a>
      <a href="docs/">Docs</a>
      <a href="generator/">Config generator</a>
      <a href="${REPO}" rel="noopener">GitHub</a>
    </div>
    <picture class="hero-shot">
      <source media="(prefers-color-scheme: dark)" srcset="assets/media/hero-dark.webp">
      ${img('hero-light.webp', 'The WireHub canvas: an RJ45 patch lead drawn as two plugs and a Cat 5e segment, with the selected joint open in the inspector', ' fetchpriority="high"')}
    </picture>
  </section>
  <section aria-labelledby="get-title">
    <h2 id="get-title">What you get</h2>
    <ul class="docstrip">
      ${strip}
    </ul>
    <p class="more">Also a BOM, formboard, wire labels, CSV and XLSX exports, and WireViz import and export.</p>
  </section>
  <section aria-labelledby="run-title">
    <h2 id="run-title">Run it</h2>
    <p>You need Docker and one file.</p>
    <pre tabindex="0"><code>mkdir wirehub &amp;&amp; cd wirehub
curl -fsSLO https://raw.githubusercontent.com/formless63/wirehub/main/compose.yaml
docker compose up -d
docker compose logs wirehub        # the first-run setup code</code></pre>
    <p>Open <code>http://localhost:5183/setup</code> and enter the setup code. Want your own ports, URL or database? <a href="generator/">Generate a <code>compose.yaml</code> and <code>.env</code></a> in your browser; nothing is sent anywhere.</p>
    <ul class="links">
      <li><a href="docs/">Docs</a>: quick start, your first design, concepts, reference</li>
      <li><a href="store/">Module store</a>: official catalog packs and how to add a store</li>
      <li><a href="${REPO}" rel="noopener">Source on GitHub</a></li>
    </ul>
  </section>
</main>`;
  return page({ repoRoot, title: 'WireHub', csp: HOME_CSP, stylesheet: 'assets/home.css', depth: 0, current: 'home', body, skip: true });
}

/**
 * The browsable module store page: one self-contained file that reads `index.json`,
 * `index.json.minisig` and `wirehub-store.pub` beside it. `shell: 'wirehub'` is the official
 * site's (logo and nav); 'plain' is for a third-party store (its own name, no WireHub
 * branding, a pointer to WireHub).
 */
export function buildStorePage({ repoRoot = root, shell = 'wirehub', name = 'Module store' } = {}) {
  const css = `${read(repoRoot, 'site/src/base.css')}\n${read(repoRoot, 'site/src/shell.css')}\n${read(repoRoot, 'site/src/store.css')}`;
  const script = `"use strict";\n${asScript(read(repoRoot, 'site/src/store.js'))}\n${asScript(read(repoRoot, 'site/src/store-app.js'))}`;
  const intro = `<main>
  <div class="prose store-head">
    <h1 data-store-name>${escapeHtml(name)}</h1>
    <p class="lede">A WireHub module store: catalog packs (signals, connectors, cables) a hub can install. Browse them here; add the store to your hub with the steps below.</p>
  </div>
  <div id="store"><p class="hint">Loading the index…</p></div>
  <noscript><p>This page needs JavaScript to list the packs. The raw files are <a href="index.json">index.json</a>, <a href="index.json.minisig">index.json.minisig</a> and <a href="wirehub-store.pub">wirehub-store.pub</a>.</p></noscript>
</main>`;
  if (shell === 'wirehub') return page({ repoRoot, title: 'WireHub module store', csp: STORE_CSP, css, depth: 1, current: 'store', body: intro, script });
  // a third-party store: no WireHub nav or logo, just its own name and a pointer
  const html = page({ repoRoot, title: name, csp: STORE_CSP, css, depth: 0, current: '', body: intro, script });
  const plainHead = `<header class="site-head"><div class="bar"><strong data-store-name>${escapeHtml(name)}</strong><nav aria-label="Site"><a href="index.json">index.json</a><a href="https://formless63.github.io/wirehub/">About WireHub</a></nav></div></header>`;
  return html.replace(/<header class="site-head">[\s\S]*?<\/header>/, () => plainHead).replace(/<footer class="site-foot">[\s\S]*?<\/footer>/, () => '<footer class="site-foot">A module store for <a href="https://formless63.github.io/wirehub/">WireHub</a>.</footer>');
}

/** The config generator, at /generator/. */
export function buildPage(repoRoot = root) {
  const templates = readTemplates(repoRoot);
  const html = read(repoRoot, 'site/src/index.html');
  const css = `${read(repoRoot, 'site/src/base.css')}\n${read(repoRoot, 'site/src/shell.css')}\n${read(repoRoot, 'site/src/style.css')}`;
  const generate = read(repoRoot, 'site/src/generate.js');
  const app = read(repoRoot, 'site/src/app.js');
  const mark = read(repoRoot, 'brand/wirehub-mark.svg');
  // JSON in a <script> must not close the element early
  const data = JSON.stringify(templates).replace(/</g, '\\u003c');
  const script = `"use strict";\nconst TEMPLATES = ${data};\n${asScript(generate)}\n${asScript(app)}`;
  return html
    .replace('/*STYLE*/', () => css)
    .replace('<!--SOCIAL-->', () => socialMeta('WireHub config generator', 'A compose.yaml and an optional .env for a self-hosted WireHub, made in your browser. Nothing is sent anywhere.'))
    .replace('<!--SHELL-->', () => renderHeader({ repoRoot, depth: 1, current: 'generator' }))
    .replace('<!--FOOT-->', () => FOOT)
    .replace('/*FAVICON*/', () => `data:image/svg+xml,${encodeURIComponent(mark)}`)
    .replace('/*SCRIPT*/', () => script.replace(/<\/script/gi, '<\\/script'));
}

/** The shell the docs pages share with the rest of the site. */
function docsShell(repoRoot) {
  return { favicon: favicon(repoRoot), social: socialMeta, header: (depth) => renderHeader({ repoRoot, depth, current: 'docs' }), footer: FOOT };
}

/** Everything under /docs/ (relative to it): pages, assets, the search index. */
export function buildDocsFiles(repoRoot = root) {
  const { files } = buildDocsSite({ repoRoot, shell: docsShell(repoRoot) });
  return [...files, ...docsAssets(repoRoot), ['assets/theme.js', themeScript()]];
}

/** Every file of the site, as [path, contents]. */
export function buildSite(repoRoot = root) {
  return [
    ['index.html', buildHome(repoRoot)],
    ...homeAssets(repoRoot),
    ['generator/index.html', buildPage(repoRoot)],
    ...buildDocsFiles(repoRoot).map(([path, contents]) => [`docs/${path}`, contents]),
    ['store/index.html', buildStorePage({ repoRoot })],
    ['social.png', socialCardPng(repoRoot)],
    ['.nojekyll', ''],
  ];
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  console.log(`site: wrote ${path}`);
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === 'store-page') {
    const nameAt = args.indexOf('--name');
    write(args[1], buildStorePage({ shell: 'plain', name: nameAt > 0 ? args[nameAt + 1] : 'Module store' }));
  } else if (args[0] === 'docs-index') {
    write(args[1], docsIndexJson(root, docsShell(root)));
  } else {
    const out = args[0] ?? join(site, 'dist');
    for (const [path, contents] of buildSite()) write(join(out, path), contents);
  }
}

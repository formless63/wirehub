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

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDocsSite, docsAssets, docsIndexJson, themeScript } from './docs.mjs';

const site = dirname(fileURLToPath(import.meta.url));
const root = join(site, '..');

/** The bundled domain modules, in the order the app's manifest lists them. */
export function readModules(repoRoot = root) {
  const manifest = readFileSync(join(repoRoot, 'apps/studio/modules.config.ts'), 'utf8');
  const imports = new Map([...manifest.matchAll(/^import \{ (\w+) \} from '@wirehub\/module-([a-z0-9-]+)';$/gm)].map((m) => [m[1], m[2]]));
  const list = /^export const modules[^=]*= \[([^\]]*)\]/m.exec(manifest)?.[1] ?? '';
  const ids = list.split(',').map((name) => imports.get(name.trim())).filter((id) => id !== undefined && readdirSync(join(repoRoot, 'modules')).includes(id));
  // only domain modules (a `setup` contribution) are offered by the generator
  const domains = ids.filter((id) => /\n\s+setup:\s*\{/.test(readFileSync(join(repoRoot, 'modules', id, 'src/index.ts'), 'utf8')));
  return domains.map((id) => {
    const source = readFileSync(join(repoRoot, 'modules', id, 'src/index.ts'), 'utf8');
    const label = /\n\s+label: '([^']+)'/.exec(source)?.[1];
    const description = /\n\s+description:\s*'([^']+)'/.exec(source)?.[1];
    if (label === undefined || description === undefined) throw new Error(`modules/${id}: no label or setup description found`);
    return { id, label, description };
  });
}

/** What the generator works from. */
export function readTemplates(repoRoot = root) {
  return { compose: readFileSync(join(repoRoot, 'compose.yaml'), 'utf8'), modules: readModules(repoRoot) };
}

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
function page({ repoRoot, title, csp, css, depth, current, body, script = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${favicon(repoRoot)}">
<style>${css}</style>
</head>
<body>
${renderHeader({ repoRoot, depth, current })}
${body}
${FOOT}
${script === '' ? '' : `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`}
</body>
</html>
`;
}

export function buildHome(repoRoot = root) {
  const css = `${read(repoRoot, 'site/src/base.css')}\n${read(repoRoot, 'site/src/shell.css')}`;
  const body = `<main class="prose">
  <h1>WireHub</h1>
  <p class="lede">WireHub captures the cable assemblies you build as canonical definitions, and derives everything else from them: wiring schematics, build sheets, BOMs, continuity test specs and drawings. It is self-hosted and free software, with a hierarchical wire model, a connector library and domain modules you can add or write.</p>
  <div class="cta">
    <a class="primary" href="generator/">Config generator</a>
    <a href="store/">Module store</a>
    <a href="docs/">Docs</a>
    <a href="${REPO}">GitHub</a>
  </div>
  <h2>Quick start</h2>
  <p>You need Docker and one file.</p>
  <pre><code>mkdir wirehub &amp;&amp; cd wirehub
curl -fsSLO https://raw.githubusercontent.com/formless63/wirehub/main/compose.yaml
docker compose up -d
docker compose logs wirehub        # the first-run setup code</code></pre>
  <ol>
    <li><a href="https://raw.githubusercontent.com/formless63/wirehub/main/compose.yaml">Download <code>compose.yaml</code></a> (or <a href="generator/">generate one</a> with your own options).</li>
    <li>Run <code>docker compose up -d</code>.</li>
    <li>Open <code>http://localhost:5183/setup</code> and enter the setup code from the log.</li>
  </ol>
  <h2>Links</h2>
  <ul class="linklist">
    <li><a href="generator/">Config generator</a>: pick options, get a ready <code>compose.yaml</code> and <code>.env</code>. It runs in your browser and sends nothing.</li>
    <li><a href="store/">Module store</a>: the official catalog packs, and how to add a store to your hub.</li>
    <li><a href="docs/">Docs</a>: quick start, your first design, the concepts, and the reference.</li>
    <li><a href="${REPO}">Source on GitHub</a>.</li>
  </ul>
</main>`;
  return page({ repoRoot, title: 'WireHub', csp: PROSE_CSP, css, depth: 0, current: 'home', body });
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
    .replace('<!--SHELL-->', () => renderHeader({ repoRoot, depth: 1, current: 'generator' }))
    .replace('<!--FOOT-->', () => FOOT)
    .replace('/*FAVICON*/', () => `data:image/svg+xml,${encodeURIComponent(mark)}`)
    .replace('/*SCRIPT*/', () => script.replace(/<\/script/gi, '<\\/script'));
}

/** The shell the docs pages share with the rest of the site. */
function docsShell(repoRoot) {
  return { favicon: favicon(repoRoot), header: (depth) => renderHeader({ repoRoot, depth, current: 'docs' }), footer: FOOT };
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
    ['generator/index.html', buildPage(repoRoot)],
    ...buildDocsFiles(repoRoot).map(([path, contents]) => [`docs/${path}`, contents]),
    ['store/index.html', buildStorePage({ repoRoot })],
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

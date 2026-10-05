// Builds the config generator into one self-contained page: site/dist/index.html.
//
//   node site/build.mjs [outDir]
//
// The page embeds, at build time, the repository's compose.yaml (the template
// the generator edits — its default output is that file, byte for byte), the
// bundled domain modules' labels and descriptions (modules/*/src/index.ts)
// and the brand marks. Everything is inlined — styles, script, templates — so
// the page makes no request at all, works when saved and opened from disk,
// and has nothing to send anywhere.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = dirname(fileURLToPath(import.meta.url));
const root = join(site, '..');

/** The bundled domain modules, in the order the app's manifest lists them. */
export function readModules(repoRoot = root) {
  const manifest = readFileSync(join(repoRoot, 'apps/studio/modules.config.ts'), 'utf8');
  const imports = new Map([...manifest.matchAll(/^import \{ (\w+) \} from '@wirehub\/module-([a-z0-9-]+)';$/gm)].map((m) => [m[1], m[2]]));
  const list = /^export const modules[^=]*= \[([^\]]*)\]/m.exec(manifest)?.[1] ?? '';
  const ids = list.split(',').map((name) => imports.get(name.trim())).filter((id) => id !== undefined && readdirSync(join(repoRoot, 'modules')).includes(id));
  return ids.map((id) => {
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

/** The finished page. */
export function buildPage(repoRoot = root) {
  const templates = readTemplates(repoRoot);
  const html = readFileSync(join(site, 'src/index.html'), 'utf8');
  const css = readFileSync(join(site, 'src/style.css'), 'utf8');
  const generate = readFileSync(join(site, 'src/generate.js'), 'utf8');
  const app = readFileSync(join(site, 'src/app.js'), 'utf8');
  const logo = readFileSync(join(repoRoot, 'brand/wirehub-logo.svg'), 'utf8').replace(/<\?xml[^>]*>\s*/, '');
  const mark = readFileSync(join(repoRoot, 'brand/wirehub-mark.svg'), 'utf8');
  // JSON in a <script> must not close the element early
  const data = JSON.stringify(templates).replace(/</g, '\\u003c');
  const script = `"use strict";\nconst TEMPLATES = ${data};\n${asScript(generate)}\n${asScript(app)}`;
  return html
    .replace('/*STYLE*/', () => css)
    .replace('<!--LOGO-->', () => logo)
    .replace('/*FAVICON*/', () => `data:image/svg+xml,${encodeURIComponent(mark)}`)
    .replace('/*SCRIPT*/', () => script.replace(/<\/script/gi, '<\\/script'));
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const out = process.argv[2] ?? join(site, 'dist');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'index.html'), buildPage());
  writeFileSync(join(out, '.nojekyll'), '');
  console.log(`site: wrote ${join(out, 'index.html')}`);
}

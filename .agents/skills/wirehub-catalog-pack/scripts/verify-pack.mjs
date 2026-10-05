#!/usr/bin/env node
// Verify a WireHub catalog pack directory the way the bundled modules' tests do:
//   node .agents/skills/wirehub-catalog-pack/scripts/verify-pack.mjs <pack-dir> [<other-pack-dir> ...]
//
// 1. reads the manifest (wirehub-pack.json);
// 2. lays the pack over the starter catalog and runs validateDb and validateDesign
//    on every design (errors fail; warnings are printed);
// 3. installs the pack into a temporary copy of the starter catalog (no conflicts);
// 4. with other pack directories: installs each of them first into the same copy,
//    then this pack, and again in the opposite order (the order must not matter);
// 5. checks the pack's own files for a `src` on every record, the manifest's `partNumberScheme`
//    (a declarative numbering scheme it offers) and `validation-rules.json` (declarative rules);
// 6. for a pack that carries a code module (`module` in the manifest, specs/runtime-modules.md):
//    the block is sound and names entries the pack has, and no other file sits under code/.
// Writes nothing outside a temporary directory. Exits 1 on any problem.

import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const { createCatalog, dataPath, fsCatalogSource, installPack, layeredCatalogSource, packAssetFiles, packDocumentSrcProblems, packFiles, readPackManifest } = await import(
  new URL('packages/catalog/src/index.ts', `file://${root}`).href
);
const { benchRuleProblems, declarativeSchemeProblems, ruleListProblems, validateDb, validateDesign } = await import(new URL('packages/model/src/index.ts', `file://${root}`).href);
const { codeModuleManifestProblems, isCodeFilePath } = await import(new URL('packages/modules/src/index.ts', `file://${root}`).href);
const { MAX_PACK_FONT_BYTES, MAX_PACK_PDF_BYTES, fontProblem, isPackDocPath, isPackFontPath, pdfProblem } = await import(new URL('apps/studio/server/pack-archive.ts', `file://${root}`).href);

const dirs = process.argv.slice(2).map((d) => resolve(d));
if (dirs.length === 0) {
  console.error('usage: verify-pack.mjs <pack-dir> [<other-pack-dir> ...]');
  process.exit(2);
}
const [packDir, ...others] = dirs;
let failed = false;
const fail = (message) => {
  failed = true;
  console.error(`FAIL ${message}`);
};

for (const dir of dirs) {
  if (!existsSync(join(dir, 'wirehub-pack.json'))) {
    console.error(`${dir} has no wirehub-pack.json`);
    process.exit(2);
  }
}

const manifest = readPackManifest(packDir);
console.log(`pack ${manifest.id}@${manifest.version} (${manifest.license})`);

// a numbering scheme the manifest offers, and the declarative rules the pack ships, must be usable
if (manifest.partNumberScheme !== undefined) for (const problem of declarativeSchemeProblems(manifest.partNumberScheme)) fail(`manifest partNumberScheme: ${problem}`);
if (existsSync(join(packDir, 'bench-rules.json'))) for (const problem of benchRuleProblems(JSON.parse(readFileSync(join(packDir, 'bench-rules.json'), 'utf8')), 'bench-rules.json')) fail(problem);
if (existsSync(join(packDir, 'validation-rules.json'))) for (const problem of ruleListProblems(JSON.parse(readFileSync(join(packDir, 'validation-rules.json'), 'utf8')))) fail(`validation-rules.json: ${problem}`);

// vendor PDFs (docs/, assets/) and fonts (fonts/) are what a studio would install: the path, the header, the size, no active content
for (const relative of packAssetFiles(packDir).filter((p) => /^(docs|assets|fonts)\//.test(p))) {
  const bytes = new Uint8Array(readFileSync(join(packDir, relative)));
  if (relative.endsWith('.pdf')) {
    if (!isPackDocPath(relative)) fail(`${relative}: a pack's PDFs live under docs/ or assets/ with a plain file name`);
    if (bytes.length > MAX_PACK_PDF_BYTES) fail(`${relative}: larger than a pack PDF may be (${MAX_PACK_PDF_BYTES / 1024 / 1024} MiB)`);
    const problem = pdfProblem(bytes);
    if (problem !== undefined) fail(`${relative} ${problem}`);
  } else {
    if (!isPackFontPath(relative)) fail(`${relative}: a pack's fonts live under fonts/ with a plain file name`);
    if (bytes.length > MAX_PACK_FONT_BYTES) fail(`${relative}: larger than a pack font may be (${MAX_PACK_FONT_BYTES / 1024 / 1024} MiB)`);
    const problem = fontProblem(relative, bytes);
    if (problem !== undefined) fail(`${relative} ${problem}`);
  }
}

// every record of the pack's own files cites a source
for (const relative of packFiles(packDir)) {
  const value = JSON.parse(readFileSync(join(packDir, relative), 'utf8'));
  for (const problem of packDocumentSrcProblems(relative, value)) fail(problem);
}

// a code module: its manifest block, its entries
if (manifest.module !== undefined) {
  for (const problem of codeModuleManifestProblems(manifest.module)) fail(`module: ${problem}`);
  const named = [manifest.module.server, manifest.module.browser, manifest.module.css].filter((p) => typeof p === 'string');
  for (const path of named) if (!existsSync(join(packDir, path))) fail(`module: ${path} is named but not in the pack`);
  const walk = (relative) =>
    existsSync(join(packDir, relative))
      ? readdirSync(join(packDir, relative), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${relative}/${e.name}`) : [`${relative}/${e.name}`]))
      : [];
  for (const path of walk('code')) if (!isCodeFilePath(path) || !named.includes(path)) fail(`module: ${path} is under code/ but not one of the module's entries`);
  console.log(`code module ${manifest.module.id}@${manifest.module.version} (module API ${manifest.module.apiVersion}): ${manifest.module.extensionPoints.join(', ')}`);
}

// the pack over the starter catalog
const starter = fsCatalogSource(dataPath(''), 'starter');
const layered = createCatalog(layeredCatalogSource([starter, fsCatalogSource(packDir, manifest.id)]));
const db = layered.loadDb();
for (const issue of validateDb(db)) {
  if (issue.severity === 'error') fail(`${issue.code} ${issue.where}: ${issue.message}`);
  else console.log(`warning ${issue.code} ${issue.where}: ${issue.message}`);
}
for (const id of layered.listDesignIds()) {
  for (const issue of validateDesign(layered.loadDesign(id), db)) {
    if (issue.severity === 'error') fail(`design ${id}: ${issue.code} ${issue.where}: ${issue.message}`);
  }
}

// install into a copy of the starter, alone and beside the other packs, in both orders
const installs = [[packDir], ...(others.length > 0 ? [[...others, packDir], [packDir, ...others]] : [])];
for (const order of installs) {
  const work = mkdtempSync(join(tmpdir(), 'wirehub-verify-pack-'));
  try {
    cpSync(dataPath(''), work, { recursive: true });
    for (const dir of order) {
      const plan = installPack(work, dir);
      if (plan.conflicts.length > 0) fail(`installing ${plan.manifest.id} after [${order.map((d) => readPackManifest(d).id).join(', ')}]: ${plan.conflicts.join('; ')}`);
    }
    const installed = createCatalog(fsCatalogSource(work));
    const all = installed.loadDb();
    for (const issue of validateDb(all)) if (issue.severity === 'error') fail(`installed ${order.map((d) => readPackManifest(d).id).join('+')}: ${issue.code} ${issue.where}: ${issue.message}`);
    for (const id of installed.listDesignIds()) {
      for (const issue of validateDesign(installed.loadDesign(id), all)) {
        if (issue.severity === 'error') fail(`installed design ${id}: ${issue.code} ${issue.where}: ${issue.message}`);
      }
    }
    console.log(`install ok: ${order.map((d) => readPackManifest(d).id).join(' + ')}`);
  } catch (error) {
    fail(String(error instanceof Error ? error.message : error));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

console.log(failed ? 'FAILED' : 'verified');
process.exit(failed ? 1 : 0);

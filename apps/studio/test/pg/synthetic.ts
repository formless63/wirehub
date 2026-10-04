/**
 * Catalogs for the import gate beyond the starter: the starter with every
 * bundled pack installed, and a synthetic catalog that exercises every file
 * kind the codec maps (saved revisions with artwork, an unlocked revision,
 * working state, a draft, an uploaded asset with a drawing photo, a legacy
 * photo, a model link, a depiction) and scales to the S4 size (100 designs,
 * 1,000 definitions) by copying the starter's records under new ids.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCatalog, dataPath, fsCatalogSource, installPack } from '@wirehub/catalog';
import { createVersion, formatVersionJson, unlockVersion, type CableDesign } from '@wirehub/model';

const modulesRoot = fileURLToPath(new URL('../../../../modules', import.meta.url));
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

function write(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** The starter catalog with every bundled module pack installed, at `<root>/data`. */
export function starterWithPacks(root: string): string {
  cpSync(dataPath(''), join(root, 'data'), { recursive: true });
  for (const name of readdirSync(modulesRoot).sort()) {
    const pack = join(modulesRoot, name, 'pack');
    if (existsSync(join(pack, 'wirehub-pack.json'))) installPack(join(root, 'data'), pack);
  }
  return root;
}

/** A 1×1 PNG (the bytes do not need to be a real picture for the gate, but they are). */
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n';

export function syntheticCatalog(root: string, scale: { designs: number; definitions: number } = { designs: 100, definitions: 1000 }): string {
  const data = join(root, 'data');
  cpSync(dataPath(''), data, { recursive: true });
  const starter = createCatalog(fsCatalogSource(data));
  const db = starter.loadDb();
  const baseDesigns = starter.loadDesigns();

  // designs: copies of the starter's under new ids
  let n = baseDesigns.length;
  for (let i = 1; n < scale.designs; i += 1) {
    for (const design of baseDesigns) {
      if (n >= scale.designs) break;
      const copy: CableDesign = { ...structuredClone(design), id: `${design.id}-s${i}`, label: `${design.label} (copy ${i})` };
      write(join(data, 'designs', `${copy.id}.json`), json(copy));
      n += 1;
    }
  }

  // definitions: components copied under new ids until the library holds `scale.definitions`
  const kinds = ['connectors', 'components', 'wires', 'pcbas', 'bodies', 'interfaces', 'mechanicals', 'kits'];
  const count = (): number => kinds.reduce((sum, kind) => sum + ((starter.readJsonFile<unknown[]>(`${kind}.json`) ?? []).length), 0);
  const components = starter.loadComponents();
  const extra: unknown[] = [];
  for (let i = 1; count() + extra.length < scale.definitions; i += 1) {
    for (const c of components) {
      if (count() + extra.length >= scale.definitions) break;
      extra.push({ ...structuredClone(c), id: `${c.id}-s${i}`, label: `${c.label} (copy ${i})` });
    }
  }
  write(join(data, 'components.json'), json([...components, ...extra]));

  // saved versions of the first design: rev 1 locked with artwork, rev 2 unlocked; working state; a draft
  const first = baseDesigns[0] as CableDesign;
  const svgHash = sha(SVG);
  const versions = join(data, 'designs/_versions', first.id);
  const rev1 = createVersion({ design: first, db, rev: 1, at: '2026-01-01T00:00:00.000Z', by: 'Synthetic', note: 'first', depictions: { 'de9-female': { 'face.svg': `sha256:${svgHash}` } } });
  write(join(versions, '1.json'), formatVersionJson(rev1));
  write(join(versions, 'artwork', `${svgHash}.svg`), SVG);
  const rev2 = unlockVersion(createVersion({ design: first, db, rev: 2, at: '2026-01-02T00:00:00.000Z', by: 'Synthetic', note: 'second', basedOnRev: 1 }), '2026-01-03T00:00:00.000Z', 'Synthetic', 'fix a label');
  write(join(versions, '2.json'), formatVersionJson(rev2));
  write(join(versions, 'working.json'), json({ basedOnRev: 2 }));
  write(join(versions, 'drafts', '1.json'), json({ savedAt: '2026-01-04T00:00:00.000Z', savedBy: 'Synthetic', basedOnRev: 2, reason: 'New version from this', design: first }));

  // an uploaded photo, used by a drawing; a legacy per-design photo; a model link
  const photo = sha(PNG);
  write(join(data, 'assets', `${photo}.png`), PNG);
  write(join(data, 'assets', 'index.json'), json([{ id: photo, mime: 'image/png', originalName: 'photo.png', src: 'synthetic example', bytes: PNG.length }]));
  const second = (baseDesigns[1] as CableDesign).id;
  write(join(data, 'drawings', `${second}.photo-ref.json`), json({ assetId: photo }));
  if (!existsSync(join(data, 'drawings', `${second}.json`))) write(join(data, 'drawings', `${second}.json`), json({ title: 'Synthetic drawing', src: 'synthetic example' }));
  write(join(data, 'drawings', `${(baseDesigns[2] as CableDesign).id}.photo.png`), PNG);
  write(
    join(data, 'models.json'),
    json({
      src: 'Library 3D model links (synthetic).',
      links: [
        { record: 'connectors/de9-female', asset: photo, name: 'photo.png', sourceKind: 'uploaded', src: 'synthetic example' },
        { record: 'kits/no-such-kit', asset: 'f'.repeat(64), sourceKind: 'vendor', src: 'synthetic example: a link to a record the catalog does not have' },
      ],
    }),
  );

  // a depiction: meta.json and its artwork
  write(join(root, 'depictions', 'de9-female', 'meta.json'), json({ src: 'synthetic example', views: { face: 'face.svg' } }));
  write(join(root, 'depictions', 'de9-female', 'face.svg'), SVG);
  // a module's own data file and a markdown report
  write(join(data, 'module-x', 'register.json'), json({ src: 'synthetic example', entries: [] }));
  write(join(data, 'module-x', 'report.md'), '# Synthetic report\n\nNothing to see.\n');
  return root;
}

/** Read a JSON file of a generated catalog (tests). */
export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

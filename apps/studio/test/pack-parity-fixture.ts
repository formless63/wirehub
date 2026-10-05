/**
 * A hub whose installed pack supplies every kind the file stores must layer for the S1 gate
 * (`api-parity-file-stores`): a board build file, a drawing's facts and photo pointer, a saved
 * version, a revision's model link, art as a blob, a definition. The pack is shipped the way an
 * upload ships (compact JSON, links out of order) and installed as a layer; the catalog's own
 * files hold the photo it points at. Nothing here names a real shop: it is all synthetic.
 */

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCatalog, fsCatalogSource, installPackLayer } from '@wirehub/catalog';
import { createVersion, formatVersionJson, type CableDesign } from '@wirehub/model';

/** the starter catalog, whatever `WIREHUB_CATALOG_DIR` says right now */
const STARTER = fileURLToPath(new URL('../../../packages/catalog/data', import.meta.url));
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const SRC = 'synthetic example: parity pack';
/** a 1x1 PNG */
export const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
/** a different 1x1 PNG: the drawing's product photo, which the pack ships (cs-8re) */
export const PHOTO = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>\n';

function put(path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** The pack's files as a bundle would carry them: path → JSON value, or text/bytes for art. */
export function parityPackFiles(designId: string, photo: string): Record<string, unknown> {
  return {
    'components.json': [{ id: 'parity-r', label: 'Parity resistor', kind: 'resistor', value: '10 Ω', terminals: [{ id: 'a' }, { id: 'b' }], src: SRC }],
    // the wire library: parts, a stock's recipe and the bench's strip practice (cs-kqy), layered under the catalog's own
    'wire-parts.json': [{ id: 'parity-conductor', kind: 'conductor', label: 'Parity conductor', src: SRC }],
    'wire-recipes.json': [{ id: 'parity-stock', label: 'Parity stock', cores: [{ id: 'core-red', colour: 'red', part: 'parity-conductor' }], src: SRC }],
    'strip-practice.json': [{ id: 'parity-practice', label: 'As stripped for the parity board', appliesTo: 'any', jacketMm: 30, shield: 'trim', insulationMm: 6, drain: { source: 'landed', destination: 'cut' }, src: SRC }],
    'builds/parity-board-rev1.json': { board: 'PCA-00001', revision: 'Rev1', label: 'Parity board', end: 'destination', builds: [{ key: 'terminated', build: 'terminated', src: SRC }] },
    [`drawings/${designId}.json`]: { title: 'Parity drawing', revision: 'C', partNumber: 'CBL-00099-XX' },
    [`drawings/${designId}.photo-ref.json`]: { assetId: photo },
    // the photo's entry in the shared asset library: the pack adds the image (`assets/<sha>.png`) and says what it is
    'assets/index.json': [{ id: photo, mime: 'image/png', originalName: 'parity-photo.png', src: SRC, bytes: PHOTO.length }],
    // out of the store's order on purpose: installing sorts them
    'models.json': {
      src: SRC,
      links: [
        // a part number, upper case, as a shop's own ids are (cs-9ar)
        { record: 'revisions/ABC-123456-00/Rev1', asset: 'c'.repeat(64), sourceKind: 'vendor', src: SRC, status: 'released' },
        { record: 'revisions/parity-board/rev2', asset: 'b'.repeat(64), sourceKind: 'vendor', src: SRC, status: 'wip' },
        { record: 'revisions/parity-board/rev1', asset: 'a'.repeat(64), sourceKind: 'vendor', src: SRC, status: 'superseded' },
      ],
    },
  };
}

export interface ParityHub {
  root: string;
  data: string;
  packs: string;
  designId: string;
  photo: string;
  /** sha256 of the pack's art file */
  art: string;
}

/** The starter catalog with the parity pack installed under it as a layer. */
export function parityHub(prefix = 'wirehub-parity-'): ParityHub {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const data = join(root, 'data');
  const packs = join(root, 'packs');
  cpSync(STARTER, data, { recursive: true });
  // the pack carries the photo; the catalog holds none of its own
  const photo = sha(PHOTO);
  const catalog = createCatalog(fsCatalogSource(data));
  const designId = 'de9-crossover';
  const design = catalog.loadDesign(designId) as CableDesign;
  const version = createVersion({ design, db: catalog.loadDb(), rev: 3, at: '2026-01-01T00:00:00.000Z', by: 'Synthetic', note: 'from the pack' });

  const pack = join(root, 'parity-pack-src');
  put(join(pack, 'wirehub-pack.json'), JSON.stringify({ format: 1, id: 'parity', name: 'Parity', version: '1.0.0', license: 'CC0-1.0' }));
  for (const [path, value] of Object.entries(parityPackFiles(designId, photo))) put(join(pack, path), JSON.stringify(value));
  put(join(pack, `assets/${photo}.png`), PHOTO);
  put(join(pack, `designs/_versions/${designId}/3.json`), formatVersionJson(version).trim());
  put(join(pack, 'depictions/parity-part/meta.json'), JSON.stringify({ src: SRC, views: { face: 'face.svg' } }));
  put(join(pack, 'depictions/parity-part/face.svg'), SVG);
  // art outside depictions/: a blob of its own, served by content address
  put(join(pack, 'art/parity.svg'), `${SVG}<!-- art -->\n`);
  installPackLayer(data, packs, pack);
  return { root, data, packs, designId, photo, art: sha(`${SVG}<!-- art -->\n`) };
}

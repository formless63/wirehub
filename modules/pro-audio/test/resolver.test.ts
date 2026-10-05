/** The device resolver with the pro-audio pack: a line output into a microphone input needs a pad; into a line input it does not. */

import { createCatalog, dataPath, fsCatalogSource, layeredCatalogSource } from '@wirehub/catalog';
import { deriveCable, resolve, validateDb, validateDesign } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

const catalog = createCatalog(layeredCatalogSource([fsCatalogSource(dataPath(''), 'starter'), fsCatalogSource(new URL('../pack/', import.meta.url).pathname, 'pro-audio')]));
const db = catalog.loadDb();
const query = (port: string) => ({ source: { device: 'audio-interface' }, destination: { device: 'mixer', port } });

describe('the resolver with the pro-audio pack', () => {
  it('validates', () => expect(validateDb(db)).toEqual([]));

  it('pads a line output into a microphone input, and wires a line input straight', () => {
    const mic = resolve(db, query('mic-in-1')).options[0]!;
    expect(mic.kind).toBe('conditioned');
    expect(mic.links.map((l) => l.recipes)).toEqual([['line-to-mic-pad-40db'], ['line-to-mic-pad-40db']]);
    expect(mic.parts).toBe(4);
    const line = resolve(db, query('line-in-1')).options[0]!;
    expect(line.kind).toBe('direct');
    expect(line.parts).toBe(0);
  });

  it('derives a clean XLR lead with the pad in the far plug: series in each leg, each leg to pin 1', () => {
    const d = deriveCable(db, query('mic-in-1'));
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.design.instances.connectors.map((c) => c.def)).toEqual(['xlr3-female', 'xlr3-male']);
    expect(d.design.instances.components.map((c) => `${c.def}@${c.location}`)).toEqual(['r-6k8@dest-head', 'r-68@dest-head', 'r-6k8@dest-head', 'r-68@dest-head']);
    const toPin1 = d.design.joints.filter((j) => j.b.instance === 'j2' && j.b.terminal === '1').map((j) => j.a.instance);
    expect(toPin1).toEqual(expect.arrayContaining(['r2', 'r4']));
    expect(validateDesign(d.design, db)).toEqual([]);
  });
});

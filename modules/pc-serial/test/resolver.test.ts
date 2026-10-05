/**
 * The device resolver over the starter catalog and this pack: a PC's RS-232 port to an RS-485
 * field device (only through the converter board; a straight cable would put the device's 5 V
 * onto the PC's DSR), a PC to another DTE (a null modem by signal pairing), and the pack's
 * null-modem cable recognised as that recipe.
 */

import { fileURLToPath } from 'node:url';

import { createCatalog, dataPath, fsCatalogSource, layeredCatalogSource } from '@wirehub/catalog';
import { deriveCable, inferCableRecipe, resolve, validateDb, validateDesign, type Db } from '@wirehub/model';
import { describe, expect, it } from 'vitest';

import { PC_SERIAL_PACK } from '../src/index.ts';

const catalog = createCatalog(layeredCatalogSource([fsCatalogSource(dataPath(''), 'starter'), fsCatalogSource(fileURLToPath(PC_SERIAL_PACK), 'pc-serial')]));
const db: Db = catalog.loadDb();
const toRs485 = { source: { device: 'desktop-pc' }, destination: { device: 'rs485-field-device' } };

describe('the resolver with the PC & serial pack', () => {
  it('ships devices, a recipe and a converter board that validate', () => {
    expect(validateDb(db)).toEqual([]);
    expect(db.devices?.map((d) => d.id)).toEqual(['desktop-pc', 'serial-instrument', 'rs485-field-device', 'rs232-rs485-converter']);
  });

  it('reaches an RS-485 device from a PC only through the converter, terminated', () => {
    const r = resolve(db, toRs485);
    const best = r.options[0]!;
    expect(best.kind).toBe('board');
    expect(best.missing).toEqual([]);
    expect(best.boards.map((b) => b.device)).toEqual(['rs232-rs485-converter']);
    expect(best.requirements.map((q) => q.recipe)).toEqual(['rs485-termination-120r']);
    // plain wire pairs nothing: the two speak different signals
    expect(r.options.find((o) => o.boards.length === 0)?.missing.map((m) => m.code)).toContain('nothing-paired');
    // a straight DE-9 cable would join the device's +5 V to the PC's DSR
    expect(r.rejected.find((x) => x.option.kind === 'straight')?.why.map((w) => w.code)).toContain('hazard:power-into-signal');
  });

  it('derives a clean design: the board on the PC, a twisted pair with a screen, the terminator in the far plug', () => {
    const d = deriveCable(db, toRs485, undefined, { lengthMm: 2000 });
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.design.instances.pcbas.map((p) => p.def)).toEqual(['rs232-rs485-converter']);
    expect(d.design.instances.connectors.map((c) => c.def)).toEqual(['de9-male-profibus']);
    expect(d.design.instances.segments[0]?.def).toBe('shielded-2pair-24awg');
    expect(d.design.instances.components.map((c) => c.def)).toEqual(['r-120']);
    expect(validateDesign(d.design, db)).toEqual([]);
  });

  it('pairs two DTEs as a null modem, and recognises the pack\'s null modem as that recipe', () => {
    const r = resolve(db, { source: { device: 'desktop-pc' }, destination: { device: 'serial-instrument' } });
    const best = r.options[0]!;
    expect(best.kind).toBe('direct');
    expect(best.links.filter((l) => l.signal === 'rs232-txd' || l.signal === 'rs232-rxd').map((l) => `${l.from}->${l.to}`).sort()).toEqual(['2->3', '3->2']);
    const inferred = inferCableRecipe(catalog.loadDesign('db9-null-modem'), db);
    expect(inferred.ok).toBe(true);
    if (!inferred.ok) return;
    expect(inferred.recipe).toMatchObject({ source: { device: 'desktop-pc' }, destination: { device: 'serial-instrument' }, option: 'direct', stock: 'shielded-2pair-24awg' });
    // the data lines and the return are the recipe's; the local loopbacks and backshells are the hand's
    const added = (inferred.recipe.overrides ?? []).filter((o) => o.op === 'add-joint');
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((o) => o.op === 'add-joint' && o.joint.a.instance === o.joint.b.instance)).toBe(true);
  });
});

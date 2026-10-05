/**
 * Crimp contacts on the documents: the starter's JST XH ends carry their
 * contacts (`dc-led-lead`), so the BOM counts them per cavity, the bench
 * sheet prints a crimp table and lists the tool, and a design with no crimp
 * housing on record prints none of it.
 */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign } from '@wirehub/catalog';
import { withCavities } from '@wirehub/model';

import { bomSheetMarkdown, crimpListTable, deriveBom, deriveBomSheet, renderBuildSheet, unaccountedInstances } from '../src/index.ts';

const db = loadDb();

describe('crimp contacts on the documents', () => {
  const lead = loadDesign('dc-led-lead');

  it('the BOM has one contact line counted per cavity, in its own section, and no tool line', () => {
    const bom = deriveBom(lead, db);
    const contacts = bom.lines.filter((l) => l.category === 'termination');
    expect(contacts.map((l) => [l.ref, l.qty, l.provenance])).toEqual([['xh-contact-socket', 2, ['j2:1', 'j2:2']]]);
    expect(bom.lines.some((l) => l.ref === 'xh-crimp-tool')).toBe(false);
    expect(unaccountedInstances(lead, bom)).toEqual([]);
    const sheet = deriveBomSheet(lead, db);
    const line = sheet.lines.find((l) => l.section === 'terminations');
    expect(line).toMatchObject({ sku: 'MEC-00003', quantity: '2', location: 'Destination end · LED module connector' });
    expect(bomSheetMarkdown(sheet)).toContain('## Contacts, seals & plugs');
  });

  it('the bench sheet prints the crimp table at its end and the tool on the kit page', () => {
    const html = renderBuildSheet(lead, db, { depictions: false });
    expect(html).toContain('Crimp — j2');
    expect(html).toContain('MEC-00003 Crimp socket contact');
    expect(html).toContain('w1.red (0.205 mm²)');
    expect(html).toContain('<h3 class="cs-block__h">Tools</h3>');
    expect(html).toContain('MEC-00004 Hand crimp tool');
  });

  it('without contacts on record the housing still lists its cavities, and nothing is counted', () => {
    const bare = withCavities(lead, 'j2', []);
    expect(deriveBom(bare, db).lines.some((l) => l.category === 'termination')).toBe(false);
    const html = renderBuildSheet(bare, db, { depictions: false });
    expect(html).not.toContain('<h3 class="cs-block__h">Tools</h3>');
    expect(crimpListTable(bare, db).rows.map((r) => r[5])).toEqual(['', '']);
  });

  it('a design with no crimp housing prints no crimp table', () => {
    const crossover = loadDesign('de9-crossover');
    expect(renderBuildSheet(crossover, db, { depictions: false })).not.toContain('Crimp —');
    expect(crimpListTable(crossover, db).rows).toEqual([]);
  });
});

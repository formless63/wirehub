/** Breakouts on the starter catalog's Y cable: every conductor accounted for, once. */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesign } from '@wirehub/catalog';

import { breakoutFates, breakoutIssues, removeBreakout, type CableDesign } from '../src/index.ts';

const db = loadDb();
const y = (): CableDesign => structuredClone(loadDesign('trs-to-2rca-y'));

describe('the Y breakout', () => {
  it('accounts for every conductor and screen of the stem and both legs', () => {
    expect(breakoutIssues(y(), db)).toEqual([]);
    const fates = breakoutFates(y(), db);
    expect(fates.get('w2:right@a')?.fate).toBe('nc');
    expect(fates.get('w1:left@b')?.fate).toBe('terminated');
  });

  it('names a conductor left out', () => {
    const d = y();
    d.instances.breakouts![0]!.conductors = d.instances.breakouts![0]!.conductors.filter((c) => !(c.segment === 'w3' && c.path === 'left'));
    expect(breakoutIssues(d, db).map((i) => i.code)).toContain('breakout-conductor-missing');
  });

  it('names a conductor accounted for twice', () => {
    const d = y();
    d.instances.breakouts![0]!.conductors.push({ segment: 'w1', path: 'left', fate: 'terminated' });
    expect(breakoutIssues(d, db).map((i) => i.code)).toContain('breakout-conductor-twice');
  });

  it('wants a reason for every NC end', () => {
    const d = y();
    const nc = d.instances.breakouts![0]!.conductors.find((c) => c.fate === 'nc')!;
    delete nc.reason;
    expect(breakoutIssues(d, db).map((i) => i.code)).toContain('breakout-nc-reason');
  });

  it('refuses to "remove" a breakout that is more than a split of one segment', () => {
    expect(() => removeBreakout(y(), db, 'bk1')).toThrow(/undo its legs by hand/);
  });
});

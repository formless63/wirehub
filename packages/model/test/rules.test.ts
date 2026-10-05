/** Declarative validation rules: the four example rules, the language's bounds, and validateDesign/validateDb integration. */

import { describe, expect, it } from 'vitest';
import { loadDb, loadDesigns } from '@wirehub/catalog';

import { ruleIssuesForDesign, ruleIssuesForLibrary, ruleListProblems, ruleProblems, validateDb, validateDesign, type CableDesign, type Db, type ValidationRule } from '../src/index.ts';

const db = loadDb();
const design = (id: string): CableDesign => structuredClone(loadDesigns().find((d) => d.id === id) as CableDesign);
const withRules = (rules: ValidationRule[]): Db => ({ ...db, validationRules: rules });
const rule = (r: Partial<ValidationRule> & Pick<ValidationRule, 'id' | 'each' | 'require'>): ValidationRule => ({ severity: 'warning', message: 'rule {id} failed', src: 'test', ...r });

describe('the four example rules', () => {
  it('a connector of family X on a design tagged Y must have pin Z joined', () => {
    const r = rule({
      id: 'dsub-pin-9',
      severity: 'error',
      each: 'connector',
      where: { all: [{ eq: [{ path: 'family' }, 'D-Sub'] }, { contains: [{ path: 'design.tags' }, 'mil'] }] },
      require: { contains: [{ path: 'pinsJoined' }, '9'] },
      message: '{id} ({family}) on {design.id} needs pin 9 joined',
    });
    const plain = design('de9-crossover');
    // untagged: the rule does not apply
    expect(ruleIssuesForDesign(plain, withRules([r]))).toEqual([]);
    const tagged = { ...plain, tags: ['mil'] };
    const issues = ruleIssuesForDesign(tagged, withRules([r]));
    expect(issues.map((i) => [i.code, i.severity, i.where])).toEqual([
      ['rule:dsub-pin-9', 'error', 'j1'],
      ['rule:dsub-pin-9', 'error', 'j2'],
    ]);
    expect(issues[0]?.message).toBe('j1 (d-sub) on de9-crossover needs pin 9 joined');
    // once pin 9 is joined on j1, only j2 remains
    const joined = { ...tagged, joints: [...tagged.joints, { a: { instance: 'j1', terminal: '9' }, b: { instance: 'w1', terminal: 'pair-1.a', end: 'a' as const } }] };
    expect(ruleIssuesForDesign(joined, withRules([r])).map((i) => i.where)).toEqual(['j2']);
  });

  it('wire area must be at least N mm² when the signal has the power kind', () => {
    const r = rule({
      id: 'power-min-area',
      severity: 'error',
      each: 'conductor',
      where: { contains: [{ path: 'signalKinds' }, 'power'] },
      require: { gte: [{ path: 'areaMm2' }, 0.5] },
      message: '{id} carries {signals} at {areaMm2} mm²',
    });
    const issues = ruleIssuesForDesign(design('dc-led-lead'), withRules([r]));
    expect(issues.map((i) => i.where)).toEqual(['w1:red']);
    expect(issues[0]?.message).toBe('w1:red carries pwr-v at 0.205 mm²');
    expect(ruleIssuesForDesign(design('dc-led-lead'), withRules([{ ...r, require: { gte: [{ path: 'areaMm2' }, 0.2] } }]))).toEqual([]);
    // a rule over a design with no power signal says nothing
    expect(ruleIssuesForDesign(design('de9-crossover'), withRules([r]))).toEqual([]);
  });

  it('every connector of family F needs a mechanical of kind boot', () => {
    const r = rule({
      id: 'dsub-boot',
      each: 'connector',
      where: { eq: [{ path: 'family' }, 'd-sub'] },
      require: { contains: [{ path: 'mechanicalKinds' }, 'boot'] },
      message: '{id} has no boot',
    });
    expect(ruleIssuesForDesign(design('de9-crossover'), withRules([r])).map((i) => i.message)).toEqual(['j1 has no boot', 'j2 has no boot']);
    // a mechanical of that kind attached to j1 satisfies it for j1 only
    const lib: Db = { ...db, mechanicals: [...(db.mechanicals ?? []), { id: 'strain-boot', label: 'Strain relief boot', kind: 'boot', src: 'test' }], validationRules: [r] };
    const d = design('de9-crossover');
    d.instances.mechanical = [...(d.instances.mechanical ?? []), { id: 'm9', def: 'strain-boot', qty: 1, attachedTo: 'j1' }];
    expect(ruleIssuesForDesign(d, lib).map((i) => i.message)).toEqual(['j2 has no boot']);
  });

  it('an attenuator-like component is required on signal S between the ends', () => {
    const d = design('dc-led-lead');
    // the lead's supply end is a terminal block, untagged: use the DC connector at both ends so both ends carry pwr-v
    d.instances.connectors[0] = { ...(d.instances.connectors[0] as object), def: 'jst-xh-2-dc' } as never;
    const needs = (category: string): ValidationRule =>
      rule({
        id: 'series-part',
        severity: 'error',
        each: 'signal-path',
        where: { eq: [{ path: 'signal' }, 'pwr-v'] },
        require: { some: { in: 'components', where: { eq: [{ path: 'category' }, category] } } },
        message: '{signal} from {from.instance} to {to.instance} has no {componentCategories}',
      });
    expect(ruleIssuesForDesign(d, withRules([needs('resistor')]))).toEqual([]);
    const missing = ruleIssuesForDesign(d, withRules([needs('attenuator')]));
    expect(missing).toHaveLength(1);
    expect(missing[0]?.severity).toBe('error');
    expect(missing[0]?.message).toBe('pwr-v from j1 to j2 has no resistor');
  });
});

describe('the language', () => {
  const d = design('de9-crossover');
  const one = (require: ValidationRule['require'], where?: ValidationRule['where']): number =>
    ruleIssuesForDesign(d, withRules([rule({ id: 'x', each: 'connector', require, ...(where === undefined ? {} : { where }) })])).length;

  it('compares, combines, counts and aggregates', () => {
    expect(one({ eq: [{ path: 'pinCount' }, 10] })).toBe(0);
    expect(one({ ne: [{ path: 'pinCount' }, 10] })).toBe(2);
    expect(one({ all: [{ gt: [{ path: 'pinCount' }, 9] }, { lte: [{ path: 'pinCount' }, 10] }] })).toBe(0);
    expect(one({ any: [{ lt: [{ path: 'pinCount' }, 1] }, { in: [{ path: 'family' }, ['d-sub', 'rj45']] }] })).toBe(0);
    expect(one({ not: { startsWith: [{ path: 'def' }, 'de9'] } })).toBe(2);
    expect(one({ endsWith: [{ path: 'def' }, 'FEMALE'] })).toBe(0);
    expect(one({ exists: { path: 'nonsense' } })).toBe(2);
    expect(one({ empty: { path: 'nonsense' } })).toBe(0);
    expect(one({ eq: [{ count: { in: 'mechanicals', where: { eq: [{ path: 'kind' }, 'shell'] } } }, 1] })).toBe(0);
    expect(one({ eq: [{ sum: { in: 'mechanicals', field: 'qty' } }, 1] })).toBe(0);
    expect(one({ lte: [{ max: { in: 'pins', field: 'joined' } }, 1] })).toBe(2); // booleans are not numbers: unknown fails
    expect(one({ every: { in: 'pins', where: { exists: { path: 'id' } } } })).toBe(0);
    expect(one({ none: { in: 'pins', where: { eq: [{ path: 'id' }, 'zz'] } } })).toBe(0);
    expect(one({ gte: [{ length: 'pinsOpen' }, 1] })).toBe(0);
  });

  it('reads the enclosing scope from inside a quantifier', () => {
    expect(one({ some: { in: 'mechanicals', where: { eq: [{ path: 'def' }, { outer: 'def' }] } } })).toBe(2);
    expect(one({ some: { in: 'mechanicals', where: { eq: [{ path: 'def' }, 'de9-backshell'] } } })).toBe(0);
  });

  it('a missing value fails a comparison instead of passing it', () => {
    expect(one({ gte: [{ path: 'nonsense' }, 0] })).toBe(2);
    expect(one({ eq: [{ path: 'nonsense' }, null] })).toBe(2);
  });

  it('does not run a disabled rule, and fills missing placeholders with ?', () => {
    const off = rule({ id: 'off', enabled: false, each: 'connector', require: { eq: [1, 2] } });
    expect(ruleIssuesForDesign(d, withRules([off]))).toEqual([]);
    const msg = rule({ id: 'm', each: 'design', require: { eq: [1, 2] }, message: '{id} {nope} {design.tags}' });
    expect(ruleIssuesForDesign(d, withRules([msg]))[0]?.message).toBe('de9-crossover ? (none)');
  });
});

describe('bounds and safety', () => {
  it('refuses rules that are malformed, too big or too deep', () => {
    const ok = rule({ id: 'ok', each: 'connector', require: { eq: [1, 1] } });
    expect(ruleProblems(ok)).toEqual([]);
    expect(ruleProblems({ ...ok, id: 'Bad Id' }).join()).toMatch(/kebab/);
    expect(ruleProblems({ ...ok, severity: 'fatal' }).join()).toMatch(/severity/);
    expect(ruleProblems({ ...ok, each: 'galaxy' }).join()).toMatch(/each is one of/);
    expect(ruleProblems({ ...ok, message: 'x'.repeat(400) }).join()).toMatch(/longer than 300/);
    expect(ruleProblems({ ...ok, src: '' }).join()).toMatch(/src/);
    expect(ruleProblems({ ...ok, require: { eq: [1] } }).join()).toMatch(/two operands/);
    expect(ruleProblems({ ...ok, require: { eval: 'process.exit()' } }).join()).toMatch(/not a condition/);
    expect(ruleProblems({ ...ok, require: { eq: [{ path: 'a b' }, 1] } }).join()).toMatch(/names a field/);
    expect(ruleProblems({ ...ok, require: { eq: [{ fn: 'x' }, 1] } }).join()).toMatch(/not an operand/);
    let deep: unknown = { eq: [1, 1] };
    for (let i = 0; i < 12; i += 1) deep = { not: deep };
    expect(ruleProblems({ ...ok, require: deep }).join()).toMatch(/nested more than 8/);
    const wide = { all: Array.from({ length: 150 }, () => ({ eq: [1, 1] })) };
    expect(ruleProblems({ ...ok, require: wide }).join()).toMatch(/larger than 100/);
    expect(ruleListProblems([ok, ok]).join()).toMatch(/used twice/);
    expect(ruleListProblems(Array.from({ length: 201 }, (_, i) => ({ ...ok, id: `r-${i}` }))).join()).toMatch(/at most 200/);
  });

  it('cannot reach prototype members or run code through a path', () => {
    const d = design('de9-crossover');
    const probe = rule({ id: 'p', each: 'connector', require: { exists: { path: '__proto__.constructor' } } });
    expect(ruleIssuesForDesign(d, withRules([probe]))).toHaveLength(2);
    const ctor = rule({ id: 'c', each: 'connector', require: { exists: { path: 'constructor' } } });
    expect(ruleIssuesForDesign(d, withRules([ctor]))).toHaveLength(2);
  });

  it('stops when the step budget is spent, with a warning', () => {
    // a wide aggregate inside a conductor-heavy loop, repeated many times
    const heavy = Array.from({ length: 200 }, (_, i) =>
      rule({ id: `heavy-${i}`, each: 'connector', require: { all: Array.from({ length: 90 }, () => ({ some: { in: 'pins', where: { all: Array.from({ length: 8 }, () => ({ exists: { path: 'id' } })) } } })) } }),
    );
    const issues = ruleIssuesForDesign(design('de9-crossover'), withRules(heavy));
    expect(issues.some((i) => i.code === 'rule-budget')).toBe(true);
  });

  it('skips an invalid rule in a design and reports it from validateDb', () => {
    const bad = { id: 'bad', severity: 'error', each: 'connector', require: { oops: 1 }, message: 'm', src: 's' } as unknown as ValidationRule;
    expect(ruleIssuesForDesign(design('de9-crossover'), withRules([bad]))).toEqual([]);
    const lib = ruleIssuesForLibrary(withRules([bad]));
    expect(lib.map((i) => i.code)).toEqual(['rule-invalid']);
    expect(lib[0]?.message).toMatch(/'bad' cannot be used/);
    expect(ruleIssuesForLibrary(withRules([rule({ id: 'a', each: 'design', require: { eq: [1, 1] } }), rule({ id: 'a', each: 'design', require: { eq: [1, 1] } })])).map((i) => i.message)).toEqual(["two validation rules are called 'a'"]);
  });
});

describe('inside validateDesign and validateDb', () => {
  it('a design rule is an issue of validateDesign, with its severity', () => {
    const r = rule({ id: 'tagged-needs-pn', severity: 'error', each: 'design', where: { contains: [{ path: 'tags' }, 'release'] }, require: { exists: { path: 'productRef' } }, message: '{id} is tagged release but has no product reference' });
    const d = { ...design('de9-crossover'), tags: ['release'] };
    const issues = validateDesign(d, withRules([r])).filter((i) => i.code.startsWith('rule:'));
    expect(issues).toEqual([{ code: 'rule:tagged-needs-pn', severity: 'error', message: 'de9-crossover is tagged release but has no product reference', where: 'de9-crossover' }]);
    expect(validateDesign(design('de9-crossover'), withRules([r])).filter((i) => i.code.startsWith('rule:'))).toEqual([]);
  });

  it('a library rule runs in validateDb over definitions', () => {
    const r = rule({ id: 'connector-pn', each: 'connector-def', where: { eq: [{ path: 'family' }, 'd-sub'] }, require: { eq: [{ path: 'gender' }, 'male'] }, message: '{id} is {gender}, not male' });
    const issues = validateDb(withRules([r])).filter((i) => i.code === 'rule:connector-pn');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.where).toMatch(/^connectors\//);
  });

  it('the starter catalog with no rules is untouched, and tags are checked', () => {
    expect(validateDb(db).some((i) => i.code.startsWith('rule'))).toBe(false);
    const bad = { ...design('de9-crossover'), tags: ['ok', 7 as unknown as string] };
    expect(validateDesign(bad, db).some((i) => i.code === 'invalid-tags')).toBe(true);
  });
});

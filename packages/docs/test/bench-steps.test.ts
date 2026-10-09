/**
 * The work-instruction hook: a registered provider replaces the generic bench
 * steps for the phases it answers, and removing it restores them byte for byte.
 */

import { listDesignIds, loadDb, loadDesign } from '@wirehub/catalog';
import { describe, expect, it } from 'vitest';

import { registerBenchSteps, renderBuildSheet } from '../src/index.ts';

const db = loadDb();
const design = loadDesign(listDesignIds()[0]!);

describe('registerBenchSteps', () => {
  it('swaps the generic steps for a shop\'s own and restores them', () => {
    const before = renderBuildSheet(design, db);
    expect(before).not.toContain('SHOP-WI-7');
    const off = registerBenchSteps({
      prep: () => [{ text: 'Strip per SHOP-WI-7.', src: 'shop work instruction 7' }],
      solder: { text: 'Solder per SHOP-WI-9.', src: 'shop work instruction 9' },
      qa: [{ text: 'Final check per SHOP-WI-11.', src: 'shop work instruction 11' }],
    });
    try {
      const during = renderBuildSheet(design, db);
      expect(during).toContain('SHOP-WI-7');
      expect(during).toContain('SHOP-WI-9');
      expect(during).toContain('SHOP-WI-11');
      expect(during).not.toContain('Cut to length');
    } finally {
      off();
    }
    expect(renderBuildSheet(design, db)).toBe(before);
  });

  it('prints a rule\'s images, tools and checks, from data alone', async () => {
    const { benchRulesProvider, benchRuleProblems } = await import('@wirehub/model');
    const rules = [
      { id: 'prep-all', phase: 'prep' as const, steps: [{ text: 'Strip per SHOP-WI-3.', src: 'shop wi 3', tools: ['wire stripper'], checks: ['No nicked strands'], images: ['data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg"/>'] }] },
      { id: 'never', phase: 'prep' as const, when: { wire: ['no-such-wire'] }, steps: [{ text: 'NEVER-SHOWN', src: 'x' }] },
    ];
    expect(benchRuleProblems(rules)).toEqual([]);
    const off = registerBenchSteps(benchRulesProvider(rules));
    try {
      const html = renderBuildSheet(design, db);
      expect(html).toContain('Strip per SHOP-WI-3.');
      expect(html).toContain('Tools: wire stripper');
      expect(html).toContain('No nicked strands');
      expect(html).toContain('class="cs-stepimg"');
      expect(html).not.toContain('NEVER-SHOWN');
    } finally {
      off();
    }
  });

  it('refuses bad rules with a sentence each', async () => {
    const { benchRuleProblems } = await import('@wirehub/model');
    const bad = [{ id: 'Bad Id', phase: 'prep', steps: [{ text: '', src: '' }] }, { id: 'q', phase: 'qa', when: { family: ['x'] }, steps: [{ text: 't', src: 's', images: ['file:///etc/passwd'] }] }];
    const problems = benchRuleProblems(bad as never);
    expect(problems.join('\n')).toMatch(/kebab-case/);
    expect(problems.join('\n')).toMatch(/text is empty/);
    expect(problems.join('\n')).toMatch(/qa rule takes no when/);
    expect(problems.join('\n')).toMatch(/images must be/);
  });

  it('prints the catalog\'s own rules (Db.benchRules, bench-rules.json) with no registration, and a module\'s provider still wins', async () => {
    const { validateDb } = await import('@wirehub/model');
    const rules = [
      { id: 'data-prep', phase: 'prep' as const, steps: [{ text: 'Strip per DATA-WI-1.', src: 'shop wi 1' }] },
      { id: 'data-qa', phase: 'qa' as const, steps: [{ text: 'Check per DATA-WI-2.', src: 'shop wi 2' }] },
      { id: 'Broken Rule', phase: 'prep' as const, steps: [{ text: 'BROKEN-SHOWN', src: 'x' }] },
    ];
    const withRules = { ...db, benchRules: rules };
    const html = renderBuildSheet(design, withRules);
    expect(html).toContain('Strip per DATA-WI-1.');
    expect(html).toContain('Check per DATA-WI-2.');
    expect(html).not.toContain('BROKEN-SHOWN');
    // without them the sheet is the generic one again (nothing was registered globally)
    expect(renderBuildSheet(design, db)).not.toContain('DATA-WI-1');
    // a broken rule is a validateDb warning, never an error
    const issues = validateDb(withRules).filter((i) => i.code === 'bench-rule-invalid');
    expect(issues.map((i) => i.severity)).toEqual(['warning']);
    // a module's registered provider answers first
    const off = registerBenchSteps({ prep: () => [{ text: 'Strip per MODULE-WI-9.', src: 'module' }] });
    try {
      const during = renderBuildSheet(design, withRules);
      expect(during).toContain('MODULE-WI-9');
      expect(during).not.toContain('Strip per DATA-WI-1.');
      expect(during).toContain('Check per DATA-WI-2.');
    } finally {
      off();
    }
  });
});

describe('the end pages lay out around the strip (cs-ld1m)', () => {
  it('anchors the strip in its own cell at its natural size (112 mm at most), and gives it the row when nothing sits beside it', async () => {
    const { loadDb, loadDesign, listDesignIds } = await import('@wirehub/catalog');
    const { renderBuildSheet } = await import('../src/index.ts');
    const { BENCH_STYLESHEET } = await import('../src/bench/styles.ts');
    expect(BENCH_STYLESHEET).toContain('.cs-endtop__strip .cs-bench-strip{width:100%;max-width:112mm;margin:0}');
    expect(BENCH_STYLESHEET).toContain('.cs-endtop--solo{grid-template-columns:minmax(0,1fr)}');
    let solo = 0;
    let beside = 0;
    for (const id of listDesignIds()) {
      const html = renderBuildSheet(loadDesign(id), loadDb(), { depictions: false });
      for (const m of html.matchAll(/<div class="cs-cols cs-endtop( cs-endtop--solo)?" data-endtop><div class="cs-endtop__strip">(.*?)<\/div><div>(.*?)<\/div><\/div>/gs)) {
        if (m[2] === '') continue;
        expect(m[2]).toContain('cs-bench-strip');
        if (m[1] !== undefined) {
          solo += 1;
          expect(m[3]).toBe('');
        } else {
          beside += 1;
          expect(m[3]).not.toBe('');
        }
      }
    }
    expect(solo + beside).toBeGreaterThan(0);
  });
});

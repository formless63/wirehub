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
});

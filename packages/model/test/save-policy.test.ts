/** Saving preserves work, it does not certify it: only representation-integrity errors refuse a save. */

import { describe, expect, it } from 'vitest';

import { INTEGRITY_CODES, integrityIssues, isIntegrityIssue, type Issue } from '../src/index.ts';

const issue = (code: string, severity: Issue['severity'] = 'error'): Issue => ({ code, severity, message: code });

describe('save policy', () => {
  it('refuses unrepresentable documents', () => {
    for (const code of ['duplicate-instance-id', 'subassembly-cycle', 'invalid-tags', 'duplicate-id']) expect(isIntegrityIssue(issue(code)), code).toBe(true);
  });

  it('saves design findings, however severe', () => {
    for (const code of ['unknown-def', 'unknown-pin', 'incompatible-connection', 'rule-violation']) {
      expect(INTEGRITY_CODES.has(code), code).toBe(false);
      expect(isIntegrityIssue(issue(code)), code).toBe(false);
    }
  });

  it('an integrity code only refuses as an error', () => {
    expect(isIntegrityIssue(issue('duplicate-instance-id', 'warning'))).toBe(false);
    expect(integrityIssues([issue('unknown-def'), issue('duplicate-instance-id'), issue('invalid-status', 'warning')]).map((i) => i.code)).toEqual(['duplicate-instance-id']);
  });
});

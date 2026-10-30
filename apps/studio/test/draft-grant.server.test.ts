/** A `drafts:write` token can edit drafts and nothing else (docs/mcp.md): the scope boundary. */

import { describe, expect, it } from 'vitest';

import { isDraftWrite, isFreeWrite } from '../server/auth/draft-grant.ts';

describe('draft-work grant', () => {
  it('allows creating and editing drafts, locks and jobs', () => {
    for (const [m, p] of [['POST', '/api/designs'], ['PUT', '/api/designs/d1'], ['POST', '/api/designs/d1/duplicate'], ['PUT', '/api/definitions/parts/x'], ['POST', '/api/batch'], ['POST', '/api/locks/acquire'], ['POST', '/api/jobs'], ['POST', '/api/explore/pick'], ['put', '/api/designs/d1?dryRun=1']] as const) {
      expect(isDraftWrite(m, p), `${m} ${p}`).toBe(true);
    }
  });

  it('refuses delete, rename, versions, imports, settings and packs', () => {
    for (const [m, p] of [['DELETE', '/api/designs/d1'], ['DELETE', '/api/definitions/parts/x'], ['PATCH', '/api/designs/d1'], ['POST', '/api/designs/d1/versions'], ['POST', '/api/designs/d1/rename'], ['PUT', '/api/settings'], ['POST', '/api/imports/abc/publish'], ['POST', '/api/packs/install'], ['PUT', '/api/designs/d1/extra/segment'], ['POST', '/api/history/checkpoints/00000000-0000-0000-0000-000000000000/restore'], ['POST', '/api/history/records/design:d1/restore'], ['PUT', '/api/explore/saved']] as const) {
      expect(isDraftWrite(m, p), `${m} ${p}`).toBe(false);
    }
  });

  it('spends no budget on dry runs and lock leases, but does on real writes', () => {
    expect(isFreeWrite('PUT', '/api/designs/d1?dryRun=1')).toBe(true);
    expect(isFreeWrite('POST', '/api/locks/heartbeat')).toBe(true);
    expect(isFreeWrite('PUT', '/api/designs/d1')).toBe(false);
    expect(isFreeWrite('DELETE', '/api/locks/acquire')).toBe(false);
  });
});

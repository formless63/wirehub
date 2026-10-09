import { describe, expect, it } from 'vitest';
import type { CableDesign } from '@wirehub/model';

import { captureDesign, restoreDesign } from '../src/design-undo.ts';

const design = { id: 'demo-cable', label: 'Demo cable' } as unknown as CableDesign;

describe('undoing a design delete', () => {
  it('captures the design and its drawing details, and puts both back', async () => {
    const created: CableDesign[] = [];
    const saved: unknown[] = [];
    const photos: unknown[] = [];
    const captured = await captureDesign(
      { load: async () => ({ ok: true, value: design }) },
      { load: async () => ({ ok: true, value: { meta: { title: 'T' } as never, photo: 'data:image/png;base64,AA' } }) },
      'demo-cable',
    );
    expect(captured?.sidecar?.photo).toBeDefined();
    const back = await restoreDesign(captured!, { create: async (d) => (created.push(d), { ok: true, value: d }) }, { save: async (_id, meta) => (saved.push(meta), { ok: true, value: meta }), savePhoto: async (_id, p) => (photos.push(p), { ok: true, value: {} }) });
    expect(back.ok).toBe(true);
    expect(created).toEqual([design]);
    expect(saved).toEqual([{ title: 'T' }]);
    expect(photos).toEqual(['data:image/png;base64,AA']);
  });

  it('offers no undo for a design that cannot be read, skips an empty sidecar, and reports a refused create', async () => {
    expect(await captureDesign({ load: async () => ({ ok: false, message: 'gone' }) }, { load: async () => ({ ok: false, message: 'x' }) }, 'a')).toBeUndefined();
    const captured = await captureDesign({ load: async () => ({ ok: true, value: design }) }, { load: async () => ({ ok: true, value: { meta: {} as never } }) }, 'demo-cable');
    expect(captured?.sidecar).toBeUndefined();
    const refused = await restoreDesign(captured!, { create: async () => ({ ok: false, message: 'id in use' }) }, { save: async () => { throw new Error('not called'); }, savePhoto: async () => { throw new Error('not called'); } });
    expect(refused).toEqual({ ok: false, message: 'id in use' });
  });
});

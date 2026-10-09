import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { cableListKey, designsKey, dropDesignFromLists } from '../src/queries.ts';

describe('optimistic design delete', () => {
  it('takes the design out of both lists at once, and puts it back for a refused delete', () => {
    const client = new QueryClient();
    client.setQueryData(designsKey, { designs: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], offline: false });
    client.setQueryData(cableListKey, { entries: [{ id: 'a' }, { id: 'b' }], offline: false });
    const putBack = dropDesignFromLists(client, 'a');
    expect((client.getQueryData(designsKey) as { designs: { id: string }[] }).designs.map((d) => d.id)).toEqual(['b']);
    expect((client.getQueryData(cableListKey) as { entries: { id: string }[] }).entries.map((d) => d.id)).toEqual(['b']);
    putBack();
    expect((client.getQueryData(designsKey) as { designs: { id: string }[] }).designs.map((d) => d.id)).toEqual(['a', 'b']);
    expect((client.getQueryData(cableListKey) as { entries: { id: string }[] }).entries.map((d) => d.id)).toEqual(['a', 'b']);
  });
});

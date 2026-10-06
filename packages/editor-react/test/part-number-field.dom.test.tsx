// @vitest-environment jsdom
/** The part-number field warns when the typed number is already another part's (cs-5k1.3). */

import { DEFAULT_PART_NUMBER_SCHEME, declarativePartNumberScheme, type ConnectorDefinition } from '@wirehub/model';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PartNumberContext, partNumberScope } from '../src/part-numbers.ts';
import { PartNumberField } from '../src/panels/PartNumberField.tsx';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

const db = loadDbFromDisk();
afterEach(cleanup);

function field(value: string, connector: ConnectorDefinition) {
  const scope = partNumberScope({ scheme: DEFAULT_PART_NUMBER_SCHEME }, db);
  return render(
    <PartNumberContext.Provider value={scope}>
      <PartNumberField value={value} onChange={() => {}} kind="connector" target={() => ({ kind: 'connector', def: connector })} />
    </PartNumberContext.Provider>,
  );
}

describe('PartNumberField', () => {
  const connectors = db.connectors.filter((c) => c.partNumber !== undefined);
  const mine = connectors[0]!;
  const other = connectors[1]!;

  it('proposes the next cable variant, counting the current number and applying only on Use', () => {
    const scheme = declarativePartNumberScheme({
      type: 'declarative', id: 'cable-variants', label: 'Cable variants', template: 'CBL-{seq}-{variant}',
      segments: [{ id: 'seq', type: 'counter', width: 5 }, { id: 'variant', type: 'variant', style: 'numeric', width: 2, first: '00', max: '99' }],
    });
    const suggest = vi.spyOn(scheme, 'suggest');
    const design = { ...loadDesignFromDisk('dc-led-lead'), productRef: 'CBL-00090-05' };
    const scope = partNumberScope({ scheme, extra: [{ pn: 'CBL-00090-03', kind: 'design', source: 'synthetic example' }] }, db);
    const onChange = vi.fn();
    render(<PartNumberContext.Provider value={scope}>
      <PartNumberField value={design.productRef} onChange={onChange} kind="design" target={() => ({ kind: 'design', def: design })} />
    </PartNumberContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }));
    expect(suggest.mock.calls[0]?.[0]).toMatchObject({ kind: 'design', variantOf: 'CBL-00090-05' });
    expect(screen.getByRole('region', { name: 'Part-number suggestion' }).textContent).toContain('CBL-00090-06');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    expect(onChange).toHaveBeenCalledWith('CBL-00090-06');
  });

  it('uses the drawing number, skips variant requests for new/unrecognised numbers and other parts', () => {
    const scheme = { ...DEFAULT_PART_NUMBER_SCHEME, suggest: vi.fn(DEFAULT_PART_NUMBER_SCHEME.suggest) };
    const scope = partNumberScope({ scheme }, db);
    const design = { ...loadDesignFromDisk('dc-led-lead'), productRef: 'CBL-00090' };
    scope.suggest({ kind: 'design', def: design, partNumber: 'CBL-00091' });
    expect(scheme.suggest.mock.calls[0]?.[0]).toMatchObject({ variantOf: 'CBL-00091' });
    for (const target of [
      { kind: 'design' as const, def: { ...design, productRef: undefined } },
      { kind: 'design' as const, def: design, partNumber: 'unknown' },
      { kind: 'connector' as const, def: mine },
    ]) {
      scheme.suggest.mockClear();
      scope.suggest(target);
      expect(scheme.suggest.mock.calls[0]?.[0].variantOf).toBeUndefined();
    }
    // Schemes with no variant segment still offer a new number.
    const plain = declarativePartNumberScheme({ type: 'declarative', id: 'plain', label: 'Plain', template: 'CBL-{seq}', segments: [{ id: 'seq', type: 'counter', width: 5 }] });
    expect(partNumberScope({ scheme: plain }, db).suggest({ kind: 'design', def: design }).items[0]?.suggestion.pn).toBe('CBL-00091');
  });

  it('is quiet about the record\'s own number and about a free one', () => {
    field(mine.partNumber!, mine);
    expect(screen.queryByText(/is already on/)).toBeNull();
    cleanup();
    field('CON-09999', mine);
    expect(screen.queryByText(/is already on/)).toBeNull();
  });

  it('warns, naming the record, when the number is another part\'s', () => {
    field(other.partNumber!.toLowerCase(), mine);
    expect(screen.getByRole('status').textContent).toContain(`connectors/${other.id}`);
    expect(screen.getByRole('status').textContent).toContain('saving will be refused');
  });
});

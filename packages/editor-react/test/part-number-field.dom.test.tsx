// @vitest-environment jsdom
/** The part-number field warns when the typed number is already another part's (cs-5k1.3). */

import { DEFAULT_PART_NUMBER_SCHEME, type ConnectorDefinition } from '@wirehub/model';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PartNumberContext, partNumberScope } from '../src/part-numbers.ts';
import { PartNumberField } from '../src/panels/PartNumberField.tsx';
import { loadDbFromDisk } from './fixture.ts';

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

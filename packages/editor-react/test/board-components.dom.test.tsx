// @vitest-environment jsdom
/**
 * "Components on this board", mounted: grouped by
 * component, qty per refdes group for the build shown, DNP refs named.
 */

import type { BoardPartsEntry, ComponentDefinition } from '@wirehub/model';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoardComponentsSection } from '../src/panels/BoardComponentsSection.tsx';

afterEach(cleanup);

const components: ComponentDefinition[] = [
  { id: 'r-75', label: 'R 0603 75 Ω 1%', kind: 'resistor', category: 'resistor', value: '75 Ω', package: '0603', suppliers: [{ supplier: 'LCSC', number: 'C4275' }], terminals: [], review: 'imported from PCA-00118 Rev1 — review', src: 'x' },
  { id: 'u-lm1881', label: 'LM1881M SOIC-8', kind: 'ic', category: 'ic', mpn: 'LM1881M/NOPB', package: 'SOIC-8', terminals: [], src: 'x' },
  { id: 'j-pj311d', label: 'PJ-311D jack', kind: 'other', category: 'jack', partNumber: 'CMP-00102-00', terminals: [], src: 'x' },
];

const entry: BoardPartsEntry = {
  board: 'PCA-00118',
  revision: 'Rev1',
  sources: [],
  parts: [
    { ref: 'R1', component: 'r-75', src: 'x' },
    { ref: 'R2', component: 'r-75', src: 'x' },
    { ref: 'R3', component: 'r-75', src: 'x' },
    { ref: 'U1', component: 'u-lm1881', src: 'x' },
    { ref: 'J2', component: 'j-pj311d', src: 'x' },
  ],
  builds: [
    { key: 'full', build: 'CPL Full', defIds: ['PCA-00118-rev1-full'], omitted: [], bridged: [] },
    { key: 'basic', build: 'CPL Basic', defIds: ['PCA-00118-rev1-basic'], omitted: ['R3', 'U1'], bridged: [] },
  ],
  src: 'x',
};

describe('BoardComponentsSection', () => {
  it('lists the parts for the definition\'s build, ICs first, with qty and DNP refs', () => {
    const open = vi.fn();
    render(<BoardComponentsSection db={{ components, boardParts: [entry] }} board="PCA-00118" revision="Rev1" defId="PCA-00118-rev1-basic" onOpenComponent={open} />);
    expect(screen.getByText(/PCA-00118 Rev1 · CPL Basic · 3 fitted · 3 parts/)).toBeTruthy();
    const rows = [...document.querySelectorAll('.cs-bc-table tbody tr')].map((tr) => [...tr.querySelectorAll('td')].slice(0, 3).map((td) => td.textContent));
    expect(rows).toEqual([
      ['0', 'DNP U1', 'LM1881M SOIC-8'],
      ['2', 'R1, R2 · DNP R3', 'R 0603 75 Ω 1%review'],
      ['1', 'J2', 'PJ-311D jack'],
    ]);
    expect(screen.getByText('CMP-00102-00')).toBeTruthy();
    fireEvent.click(screen.getByText('PJ-311D jack'));
    expect(open).toHaveBeenCalledWith('j-pj311d');
  });

  it('follows a live population (the build editor) and hides itself for a board with no entry', () => {
    render(<BoardComponentsSection db={{ components, boardParts: [entry] }} board="PCA-00118" population={{ build: 'Edited', omitted: ['R1'] }} />);
    expect(screen.getByText(/Edited · 4 fitted/)).toBeTruthy();
    cleanup();
    const { container } = render(<BoardComponentsSection db={{ components, boardParts: [entry] }} board="PCA-00105" />);
    expect(container.innerHTML).toBe('');
  });
});

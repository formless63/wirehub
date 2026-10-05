// @vitest-environment jsdom
/** The price-break table in the Library's cost section: rows in, the same PartCost out. */

import type { PartCost } from '@wirehub/model';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { breakRowsOf, breaksText, CostFields, savingPct } from '../src/panels/CostFields.tsx';

afterEach(cleanup);

describe('price-break rows', () => {
  it('convert to and from the text the reader takes', () => {
    expect(breakRowsOf('10: 0.8, 100: 0.6')).toEqual([{ qty: '10', price: '0.8' }, { qty: '100', price: '0.6' }]);
    expect(breakRowsOf('')).toEqual([]);
    expect(breaksText([{ qty: '10', price: '0.8' }, { qty: '', price: '' }])).toBe('10: 0.8');
    expect(savingPct('1', '0.75')).toBe(25);
    expect(savingPct('1', '')).toBeUndefined();
  });

  it('shows a record\'s breaks as rows, edits them and reports the cost', () => {
    const onChange = vi.fn<(cost: PartCost | undefined) => void>();
    const cost: PartCost = { unit: 1, breaks: [{ minQty: 10, unit: 0.8 }] };
    render(<CostFields cost={cost} onChange={onChange} />);
    const table = screen.getByTestId('price-breaks');
    expect((within(table).getByLabelText('Break 1 from quantity') as HTMLInputElement).value).toBe('10');
    expect(table.textContent).toContain('20% under the base price');
    fireEvent.click(within(table).getByRole('button', { name: 'Add a break' }));
    fireEvent.change(within(table).getByLabelText('Break 2 from quantity'), { target: { value: '100' } });
    // a half-filled row is a problem, not a change
    expect(table.textContent).toContain('needs a quantity and a price');
    fireEvent.change(within(table).getByLabelText('Break 2 unit price'), { target: { value: '0.6' } });
    expect(onChange).toHaveBeenLastCalledWith({ unit: 1, breaks: [{ minQty: 10, unit: 0.8 }, { minQty: 100, unit: 0.6 }] });
    fireEvent.click(within(table).getByRole('button', { name: 'Remove break 1' }));
    expect(onChange).toHaveBeenLastCalledWith({ unit: 1, breaks: [{ minQty: 100, unit: 0.6 }] });
    fireEvent.click(within(table).getByRole('button', { name: 'Remove break 1' }));
    expect(onChange).toHaveBeenLastCalledWith({ unit: 1 });
    expect(table.textContent).toContain('No breaks');
  });

  it('refuses a duplicate quantity next to the table, not under the unit price', () => {
    render(<CostFields cost={{ unit: 1, breaks: [{ minQty: 10, unit: 0.8 }] }} onChange={() => undefined} />);
    const table = screen.getByTestId('price-breaks');
    fireEvent.click(within(table).getByRole('button', { name: 'Add a break' }));
    fireEvent.change(within(table).getByLabelText('Break 2 from quantity'), { target: { value: '10' } });
    fireEvent.change(within(table).getByLabelText('Break 2 unit price'), { target: { value: '0.7' } });
    expect(table.textContent).toContain('The break at 10 is listed twice.');
    expect(screen.getByTestId('cost-fields').textContent?.match(/listed twice/g)).toHaveLength(1);
  });
});

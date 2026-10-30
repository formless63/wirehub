import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ReturnLeftoverButton } from '../src/inventory/ReturnLeftover.tsx';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('returns material from a completed build by named lot and refuses an excessive quantity', async () => {
  const requests: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const reservation = { id: 'opaque-reservation', status: 'closed', lines: [{ item: { kind: 'wires', id: 'wire' }, dim: 'length', allocations: [{ lot: 'opaque-lot', consumed: 1050, returned: 0 }] }] };
    let value: unknown;
    if (init?.method === 'POST') { requests.push({ url, body: JSON.parse(String(init.body)) }); value = { reservation }; }
    else if (url.includes('/reservations/')) value = { reservation };
    else value = { lots: [{ id: 'opaque-lot', lotCode: 'Reel A', location: 'shelf' }], locations: [{ id: 'shelf', name: 'Workshop shelf' }], labels: { 'wires:wire': 'Red power wire' } };
    return new Response(JSON.stringify(value), { status: 200 });
  }));
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ReturnLeftoverButton reservation="opaque-reservation" /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Return leftover…' }));
  await screen.findByText(/Red power wire · Reel A · Workshop shelf/);
  expect(screen.getByRole('dialog').textContent).not.toContain('opaque-');
  fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '50' } });
  fireEvent.blur(screen.getByRole('textbox', { name: 'Quantity' }));
  fireEvent.click(screen.getByRole('button', { name: 'Return' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Only 1.05 m'); expect(requests).toHaveLength(0);
  fireEvent.change(screen.getByRole('textbox', { name: 'Quantity' }), { target: { value: '0.05' } });
  fireEvent.blur(screen.getByRole('textbox', { name: 'Quantity' }));
  fireEvent.click(screen.getByRole('button', { name: 'Return' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(requests).toEqual([{ url: '/api/inventory/reservations/opaque-reservation/return', body: { lot: 'opaque-lot', qty: 0.05, unit: 'm' } }]);
});

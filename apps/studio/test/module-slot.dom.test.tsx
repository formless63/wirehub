// @vitest-environment jsdom
/**
 * ModuleSlot (`src/modules/ModuleSlot.tsx`): module panels on core pages sit in a titled,
 * collapsible frame, collapsed by default, in the host's order; a pin keeps one open for the
 * user; a module whose required settings are empty shows one "not set up" line, never its form.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRegistry, defineModule, type PanelProps } from '@wirehub/modules';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupIncomplete } from '../src/modules/ModuleSlot.tsx';
import { MODULE_SLOT_ORDER, ModulePanels, slotModules } from '../src/modules/slots.tsx';

const db = { connectors: [], wires: [], components: [], pcbas: [] };
const Form = (props: PanelProps) => <form data-testid={`form-${props.module}`}>form of {props.module}</form>;
const panel = (module: string) => ({ id: 'p', label: `${module} panel`, slot: 'library-detail' as const, component: Form });
const plain = defineModule({ id: 'plain', label: 'Plain module', version: '1.0.0', panels: [panel('plain')] });
const keyed = defineModule({ id: 'keyed', label: 'Keyed module', version: '1.0.0', settings: [{ key: 'apiKey', label: 'API key', required: true }], panels: [panel('keyed')] });
const registry = createRegistry([plain, keyed]);
const context = { db, record: { kind: 'components', id: 'r1' }, readOnly: false };

const mountSlot = (settingsBody: unknown) => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(settingsBody), { status: 200, headers: { 'content-type': 'application/json' } }));
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ModulePanels registry={registry} slot="library-detail" context={context} framed />
    </QueryClientProvider>,
  );
};
const settings = (status: string, extra: Record<string, unknown> = {}) => ({ groups: [], secrets: { available: true }, problems: [], modules: [{ module: 'keyed', title: 'Keyed module', editable: true, etag: 'e', fields: [{ key: 'apiKey', label: 'API key', help: '', kind: 'secret', secret: true, required: true, source: 'settings', status }], ...extra }] });

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ModuleSlot', () => {
  it('frames each module with its name and a module chip, collapsed, panels unmounted until opened', async () => {
    mountSlot(settings('configured'));
    const slot = await screen.findByLabelText('Plain module (module)');
    expect(within(slot).getByText('module')).toBeTruthy();
    expect(slot.getAttribute('data-state')).toBe('collapsed');
    expect(screen.queryByTestId('form-plain')).toBeNull();
    fireEvent.click(within(slot).getByRole('button', { name: /^Plain module/ }));
    expect(await screen.findByTestId('form-plain')).toBeTruthy();
  });

  it('remembers a pinned slot per user, and opens it next time', async () => {
    const first = mountSlot(settings('configured'));
    const slot = await screen.findByLabelText('Plain module (module)');
    fireEvent.click(within(slot).getByRole('button', { name: 'Pin open Plain module' }));
    expect(screen.getByTestId('form-plain')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem('wirehub:prefs:local') ?? '{}').values['slot-pins']).toEqual(['library-detail/plain']);
    first.unmount();
    mountSlot(settings('configured'));
    expect(await screen.findByTestId('form-plain')).toBeTruthy();
    expect(screen.queryByTestId('form-keyed')).toBeNull();
  });

  it('still honours a pin an earlier version kept in this browser', async () => {
    window.localStorage.setItem('wirehub:module-slot-pins:local', JSON.stringify(['library-detail/plain']));
    mountSlot(settings('configured'));
    expect(await screen.findByTestId('form-plain')).toBeTruthy();
  });

  it('shows one "not set up" line, linking to Module settings, instead of the form when required settings are missing', async () => {
    mountSlot(settings('missing'));
    const line = await screen.findByText(/Keyed module is not set up/);
    const slot = line.closest('[data-module-slot]') as HTMLElement;
    expect(slot.getAttribute('data-state')).toBe('not-set-up');
    expect(within(slot).getByRole('link', { name: /Set up/ }).getAttribute('href')).toBe('/settings?section=module-settings');
    expect(slot.querySelector('button')).toBeNull();
    expect(screen.queryByTestId('form-keyed')).toBeNull();
  });

  it('treats a restricted (non-owner) settings view as set up', async () => {
    mountSlot(settings('missing', { restricted: true }));
    await waitFor(() => expect(screen.getByLabelText('Keyed module (module)').getAttribute('data-state')).toBe('collapsed'));
  });

  it('counts a module with several providers as set up once one provider is complete', () => {
    const field = (key: string, gates: string | undefined, status: 'configured' | 'missing') => ({ key, label: key, help: '', kind: 'secret' as const, required: true as const, ...(gates === undefined ? {} : { gates }), source: 'settings' as const, status });
    expect(setupIncomplete([field('a', 'one', 'configured'), field('b', 'two', 'missing'), field('c', 'two', 'missing')])).toBe(false);
    expect(setupIncomplete([field('a', 'one', 'missing'), field('b', 'two', 'configured'), field('c', 'two', 'missing')])).toBe(true);
    expect(setupIncomplete([field('a', undefined, 'missing'), field('b', 'two', 'configured')])).toBe(true);
    expect(setupIncomplete([])).toBe(false);
  });

  it('orders modules by the host, then manifest order', () => {
    expect(slotModules(registry, 'library-detail')).toEqual(['plain', 'keyed']);
    const listed = MODULE_SLOT_ORDER['library-detail'] ?? [];
    expect(Array.isArray(listed)).toBe(true);
    const other = createRegistry([plain, defineModule({ id: 'suppliers', label: 'Suppliers', version: '1.0.0', panels: [panel('suppliers')] })]);
    // the host names `suppliers` first for the Library detail
    expect(slotModules(other, 'library-detail')).toEqual(['suppliers', 'plain']);
  });
});

// @vitest-environment jsdom
/** The phone's read-only design summary (O-8): parts, wiring and notes, no editor. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCatalog, fsCatalogSource } from '@wirehub/catalog';
import type { CableDesign } from '@wirehub/model';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PhoneDesignSummary } from '../src/routes/PhoneDesignSummary.tsx';

const DATA = join(process.cwd(), '..', '..', 'packages', 'catalog', 'data');
const db = createCatalog(fsCatalogSource(DATA, 'the catalog')).loadDb();
const design = JSON.parse(readFileSync(join(DATA, 'designs', 'dc-y-splitter.json'), 'utf8')) as CableDesign;

afterEach(cleanup);

describe('PhoneDesignSummary', () => {
  it('lists the wire, the parts, every joint and the notes, and says the editor is for a desktop', async () => {
    const root = createRootRoute({ component: () => <PhoneDesignSummary design={design} db={db} id={design.id} /> });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
    render(<RouterProvider router={router} />);
    expect((await screen.findByTestId('phone-edit-note')).textContent).toContain('Open on a desktop to edit');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(design.label);
    expect(within(screen.getByTestId('phone-segments')).getAllByRole('listitem')).toHaveLength(design.instances.segments.length);
    expect(within(screen.getByTestId('phone-wiring')).getAllByRole('listitem')).toHaveLength(design.joints.length);
    expect(screen.getByTestId('phone-notes').textContent).toContain(design.notes?.[0] ?? '');
    expect(screen.getByTestId('phone-parts').textContent).toContain('J1');
  });
});

// @vitest-environment jsdom
/**
 * Documents targeting a saved revision: the default is
 * the latest saved revision (loaded through the release adapter, its number
 * in the title block); the working copy prints marked UNRELEASED and the
 * an export refuses it.
 */

import './reactflow-jsdom.ts';

import type { CableDesign, Db } from '@wirehub/model';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DocumentsPane, type DocumentsProps } from '../src/panels/Documents.tsx';
import { defaultDocumentTarget, withUnreleasedMark, type DocumentRelease } from '../src/release.ts';
import type { DocumentKind } from '../src/documents.ts';
import { loadDbFromDisk, loadDesignFromDisk } from './fixture.ts';

Object.assign(Element.prototype, { hasPointerCapture: () => false, setPointerCapture: () => undefined, releasePointerCapture: () => undefined, scrollIntoView: () => undefined });
function choose(name: string, option: string): void {
  fireEvent.keyDown(screen.getByRole('combobox', { name }), { key: 'ArrowDown' });
  fireEvent.click(screen.getByRole('option', { name: option }));
}

const db: Db = loadDbFromDisk();
const design: CableDesign = loadDesignFromDisk('de9-terminal-board');

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type Derive = NonNullable<DocumentsProps['render']>;

describe('release helpers', () => {
  it('defaults to the viewed rev, else the latest, else the working copy', () => {
    const load = async (): Promise<undefined> => undefined;
    expect(defaultDocumentTarget(undefined)).toBe('working');
    expect(defaultDocumentTarget({ revisions: [], showing: { kind: 'working', unreleased: true }, load })).toBe('working');
    expect(defaultDocumentTarget({ revisions: [0, 1, 2], showing: { kind: 'working', unreleased: true }, load })).toBe(2);
    expect(defaultDocumentTarget({ revisions: [0, 1, 2], showing: { kind: 'rev', rev: 1 }, load })).toBe(1);
  });

  it('stamps a document that did not carry its state, in the corner, before </body>', () => {
    expect(withUnreleasedMark('<html><body><p>x</p></body></html>')).toMatch(/<p>x<\/p><div class="cs-state-stamp".*UNRELEASED.*<\/div><\/body>/);
  });
});

describe('<DocumentsPane release>', () => {
  it('prints the latest saved revision by default and the working copy as UNRELEASED', async () => {
    vi.useFakeTimers();
    const saved = { ...design, label: 'as released in Rev 2' };
    const load = vi.fn(async () => ({ design: saved, db }));
    const release: DocumentRelease = { revisions: [1, 2], showing: { kind: 'working', unreleased: true }, load };
    const derive = vi.fn<Derive>((kind: DocumentKind, d: CableDesign, _db: Db, options) => ({
      html: `<!doctype html><body><p>${kind}|${d.label}|${options?.document?.revision ?? ''}|${options?.document?.status ?? ''}</p></body>`,
    }));
    render(<DocumentsPane design={design} db={db} saved={design} debounceMs={10} render={derive} release={release} />);
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50);
      });
    }
    expect(load).toHaveBeenCalledWith(2);
    expect(derive.mock.calls.at(-1)?.[1].label).toBe('as released in Rev 2');
    expect(derive.mock.calls.at(-1)?.[3]?.document).toMatchObject({ revision: '2', status: 'RELEASED' });

    choose('Revision to print', 'Working · unreleased');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(derive.mock.calls.at(-1)?.[1].label).toBe(design.label);
    expect(derive.mock.calls.at(-1)?.[3]?.document).toMatchObject({ revision: '—', status: 'UNRELEASED' });
    // the sheets carry their own state in the title block and the corner stamp (`@wirehub/docs` frame): the pane hands every kind its state
    expect(document.querySelector('iframe')?.getAttribute('srcdoc')).toContain('UNRELEASED');
  });
});

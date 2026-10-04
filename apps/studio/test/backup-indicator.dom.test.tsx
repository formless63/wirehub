// @vitest-environment jsdom
/**
 * The top bar's backup indicator: one compact line
 * per state, details on click, Retry when blocked.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BackupStatus } from '../server/backup/status.ts';
import { BACKUP_DISABLED } from '../server/backup/status.ts';
import { BackupIndicator } from '../src/shell/BackupIndicator.tsx';

const NOW = new Date('2026-09-26T12:00:00Z');

const OK: BackupStatus = {
  enabled: true,
  state: 'ok',
  message: '',
  lastCommit: { sha: 'abcdef0123456789', at: '2026-09-26T11:57:00Z', author: 'Alex <alex@example.com>', subject: 'studio: update design xlr-mic-cable' },
  lastPush: { sha: 'abcdef0123456789', at: '2026-09-26T11:58:00Z' },
  pendingCommits: 0,
  remote: 'origin',
  branch: 'master',
  nextAttemptAt: null,
};

function mount(status: BackupStatus, onRetry?: () => BackupStatus): { calls: string[] } {
  const calls: string[] = [];
  let current = status;
  vi.stubGlobal('fetch', async (input: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? 'GET'} ${input}`);
    // the server's state: Retry changes what later GETs answer too
    if (input.endsWith('/retry') && onRetry !== undefined) current = onRetry();
    const body = current;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BackupIndicator now={() => NOW} />
    </QueryClientProvider>,
  );
  return { calls };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BackupIndicator', () => {
  it('says when it last backed up', async () => {
    mount(OK);
    const button = await screen.findByTestId('backup-indicator');
    expect(button.textContent).toBe('Backed up 2 min ago');
    expect(button.getAttribute('data-tone')).toBe('ok');
  });

  it('counts the changes waiting', async () => {
    mount({ ...OK, pendingCommits: 3 });
    expect((await screen.findByTestId('backup-indicator')).textContent).toBe('3 changes waiting to back up');
  });

  it('says off when the backup is not enabled', async () => {
    mount(BACKUP_DISABLED);
    expect((await screen.findByTestId('backup-indicator')).textContent).toBe('Backup off');
  });

  it('blocked: needs attention; the details say why and Retry asks the server', async () => {
    const blocked: BackupStatus = { ...OK, state: 'blocked', pendingCommits: 2, message: 'origin/master has changes that conflict with studio saves (data/a.json).' };
    const { calls } = mount(blocked, () => ({ ...OK }));
    const button = await screen.findByTestId('backup-indicator');
    expect(button.textContent).toBe('Backup blocked — needs attention');
    expect(button.getAttribute('data-tone')).toBe('error');

    fireEvent.click(button);
    const details = await screen.findByRole('dialog');
    expect(details.textContent).toContain('origin/master');
    expect(details.textContent).toContain('2 commits');
    expect(details.textContent).toContain('update design xlr-mic-cable');
    expect(details.textContent).toContain('Alex <alex@example.com>');
    expect(screen.getByTestId('backup-message').textContent).toContain('data/a.json');

    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    await waitFor(() => expect(calls).toContain('POST /api/backup/retry'));
    await waitFor(() => expect(screen.getByTestId('backup-indicator').textContent).toBe('Backed up 2 min ago'));
  });
});

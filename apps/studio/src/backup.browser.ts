/**
 * The git backup's status (`GET /api/backup`,) and the
 * words the shell's indicator says for it. Nothing here throws.
 */

import type { BackupStatus } from '../server/backup/status.ts';
import { request } from './definitions.browser.ts';

export type { BackupStatus };

export const backupKey = ['backup'] as const;

/** `undefined` when the workbench cannot be reached. */
export async function loadBackup(base = '/api'): Promise<BackupStatus | undefined> {
  const out = await request<BackupStatus>(`${base}/backup`);
  return out.ok ? out.value : undefined;
}

export async function retryBackup(base = '/api'): Promise<BackupStatus | undefined> {
  const out = await request<BackupStatus>(`${base}/backup/retry`, { method: 'POST' });
  return out.ok ? out.value : undefined;
}

/** "just now", "2 min ago", "3 h ago", "4 d ago" */
export function ago(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export type BackupTone = 'ok' | 'pending' | 'error' | 'off';

/** The indicator's one line. */
export function backupLabel(status: BackupStatus, now: Date): { text: string; tone: BackupTone } {
  // the database backend: every save is in the database (plan §7.6)
  if (status.state === 'database') return { text: status.lastChangeSet === undefined || status.lastChangeSet === null ? 'Saved' : `Saved ${ago(status.lastChangeSet.at, now)}`, tone: 'ok' };
  if (!status.enabled) return { text: 'Backup off', tone: 'off' };
  if (status.state === 'blocked') return { text: 'Backup blocked — needs attention', tone: 'error' };
  if (status.pendingCommits > 0) {
    const n = status.pendingCommits;
    return { text: `${n} change${n === 1 ? '' : 's'} waiting to back up`, tone: 'pending' };
  }
  if (status.state === 'pushing') return { text: 'Backing up…', tone: 'pending' };
  if (status.state === 'offline') return { text: 'Backup offline', tone: 'pending' };
  return { text: status.lastPush === null ? 'Backed up' : `Backed up ${ago(status.lastPush.at, now)}`, tone: 'ok' };
}

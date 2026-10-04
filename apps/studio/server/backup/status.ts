/**
 * The shape of `GET /api/backup` — kept free of any
 * Node import so the pure API router (and the browser) can share it.
 */

export type BackupState = 'ok' | 'pushing' | 'offline' | 'blocked';

export interface BackupCommitInfo {
  sha: string;
  at: string;
  author: string;
  subject: string;
}

export interface BackupStatus {
  enabled: boolean;
  state: BackupState;
  /** what went wrong or what is happening; '' when there is nothing to say */
  message: string;
  lastCommit: BackupCommitInfo | null;
  /** the last time the remote was confirmed to hold every commit */
  lastPush: { sha: string; at: string } | null;
  /** commits made here that the remote does not have yet */
  pendingCommits: number;
  remote: string;
  branch: string;
  /** when the next push attempt is due, if one is scheduled */
  nextAttemptAt: string | null;
}

export const BACKUP_DISABLED: BackupStatus = {
  enabled: false,
  state: 'ok',
  message: 'Backup is off (STUDIO_GIT_AUTOCOMMIT is not true).',
  lastCommit: null,
  lastPush: null,
  pendingCommits: 0,
  remote: '',
  branch: '',
  nextAttemptAt: null,
};

/** What the API router needs from the backup. */
export interface BackupControl {
  status(): BackupStatus;
  retry(): void;
}

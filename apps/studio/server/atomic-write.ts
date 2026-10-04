/**
 * Every store's one way to write a file (review fix, 2026-09-26): the bytes go
 * to a temp file in the same directory, are fsynced, and are renamed over the
 * target — a rename within one filesystem is atomic, so a crash or a full
 * disk mid-write leaves either the old file or the new one, never a truncated
 * `connectors.json`. The directory is fsynced too, best effort, so the rename
 * itself survives a power cut.
 *
 * The temp name starts with `.` and ends `.tmp`, so no store's directory
 * listing (`*.json`) ever mistakes one for a record.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { recordWrite } from './write-journal.ts';

export function writeFileAtomic(path: string, data: string | Uint8Array, _encoding?: 'utf8'): void {
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const fd = openSync(temp, 'wx', 0o644);
  try {
    let written = 0;
    while (written < bytes.byteLength) written += writeSync(fd, bytes, written, bytes.byteLength - written);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  // the backup's auto-commit stages exactly what a request reported
  recordWrite(path);
  try {
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // not every platform lets a directory be fsynced; the rename already happened
  }
}

/**
 * Secret scan (`specs/postgres-backend.md` §10): no tracked file holds a
 * personal-API-token-shaped string, and no `.env` is committed.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const TOKEN = /cst_(dev|prod)_[0-9a-f]{12}_[a-z2-7]{52}/;

function tracked(): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter((f) => f !== '');
  } catch {
    return [];
  }
}

describe('secret scan', () => {
  const files = tracked();

  it.skipIf(files.length === 0)('no tracked file holds a token-shaped string', () => {
    const offenders = files.filter((file) => {
      const path = join(root, file);
      try {
        if (statSync(path).size > 5_000_000) return false;
        return TOKEN.test(readFileSync(path, 'utf8'));
      } catch {
        return false;
      }
    });
    expect(offenders).toEqual([]);
  });

  it.skipIf(files.length === 0)('no .env is committed', () => {
    expect(files.filter((f) => /(^|\/)\.env(\.[^/]*)?$/.test(f) && !f.endsWith('.env.example'))).toEqual([]);
  });
});

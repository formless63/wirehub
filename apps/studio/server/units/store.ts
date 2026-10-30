/**
 * Where unit test results live (`src/units.ts`): written once, read by unit or design. In memory,
 * on files beside the inventory (`data/.inventory/unit-tests.jsonl`, append-only), or on Postgres
 * (`pg/unit-tests.ts`, migration 0034).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { UnitTest } from '../../src/units.ts';

export interface UnitTestFilter {
  unit?: string;
  design?: string;
}

export interface UnitTestStore {
  /** newest first */
  list(filter: UnitTestFilter): Promise<UnitTest[]>;
  add(test: UnitTest): Promise<void>;
}

const matches = (t: UnitTest, f: UnitTestFilter): boolean => (f.unit === undefined || t.unit === f.unit) && (f.design === undefined || t.design === f.design);
const newestFirst = (a: UnitTest, b: UnitTest): number => b.at.localeCompare(a.at) || b.id.localeCompare(a.id);

export function memoryUnitTestStore(): UnitTestStore {
  const all: UnitTest[] = [];
  return {
    list: async (f) => structuredClone(all.filter((t) => matches(t, f)).sort(newestFirst)),
    add: async (t) => {
      if (all.some((x) => x.id === t.id)) throw new Error(`test ${t.id} already recorded`);
      all.push(structuredClone(t));
    },
  };
}

/** One JSON line per result; a torn last line (a crash mid-write) is skipped. */
export function fileUnitTestStore(dir: string): UnitTestStore {
  const path = join(dir, 'unit-tests.jsonl');
  const load = (): UnitTest[] => {
    if (!existsSync(path)) return [];
    const out: UnitTest[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as UnitTest);
      } catch {
        // not committed
      }
    }
    return out;
  };
  return {
    list: async (f) => load().filter((t) => matches(t, f)).sort(newestFirst),
    add: async (t) => {
      mkdirSync(dir, { recursive: true });
      appendFileSync(path, `${JSON.stringify(t)}\n`);
    },
  };
}

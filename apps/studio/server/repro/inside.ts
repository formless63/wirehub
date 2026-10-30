/**
 * Look inside container outputs when comparing two runs: a zip (a Gerber set, a 3MF) member by
 * member, and a GLB by its JSON chunk (as text) and its binary buffer (by hash). A container that
 * differs only in members whose differing lines all carry a date or time reads as timestamp-only.
 */

import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import { isTextual, lineDiff, type TextDiff } from './compare.ts';

export interface MemberSide { sha256: string; size: number }

export interface MemberCompare {
  path: string;
  state: 'same' | 'differs' | 'added' | 'removed';
  a?: MemberSide;
  b?: MemberSide;
  text?: TextDiff;
}

export interface InsideCompare {
  kind: 'zip' | 'glb';
  /** members on either side */
  total: number;
  same: number;
  /** every differing member is text whose differing lines all carry a date or time */
  onlyTimes: boolean;
  /** the members that are not the same (at most MEMBERS_SHOWN) */
  members: MemberCompare[];
}

const MEMBERS_SHOWN = 40;
const MAX_MEMBERS = 4000;
/** the most a container is unpacked to, per side */
const MAX_UNPACKED = 128 * 1024 * 1024;

export function isZipOutput(mediaType: string, path: string): boolean {
  return /zip|3mf/.test(mediaType) || /\.(zip|3mf)$/i.test(path);
}
export function isGlbOutput(mediaType: string, path: string): boolean {
  return mediaType === 'model/gltf-binary' || /\.glb$/i.test(path);
}
/** an output this module can look inside */
export function isContainer(mediaType: string, path: string): boolean {
  return isZipOutput(mediaType, path) || isGlbOutput(mediaType, path);
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const u16 = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u32 = (b: Uint8Array, at: number): number => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

/** A zip's files (stored or deflated; no zip64, no encryption), or undefined when it cannot be read. */
export function zipEntries(bytes: Uint8Array): Map<string, Uint8Array> | undefined {
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65_535); at -= 1) {
    if (u32(bytes, at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return undefined;
  const count = u16(bytes, eocd + 10);
  let at = u32(bytes, eocd + 16);
  if (count === 0xffff || count > MAX_MEMBERS || at === 0xffffffff) return undefined;
  const out = new Map<string, Uint8Array>();
  let total = 0;
  try {
    for (let i = 0; i < count; i += 1) {
      if (at + 46 > bytes.length || u32(bytes, at) !== 0x02014b50) return undefined;
      const flags = u16(bytes, at + 8);
      const method = u16(bytes, at + 10);
      const compressed = u32(bytes, at + 20);
      const size = u32(bytes, at + 24);
      const nameLength = u16(bytes, at + 28);
      const local = u32(bytes, at + 42);
      const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
      at += 46 + nameLength + u16(bytes, at + 30) + u16(bytes, at + 32);
      if (name.endsWith('/')) continue;
      if ((flags & 1) !== 0 || compressed === 0xffffffff || size === 0xffffffff) return undefined;
      total += size;
      if (total > MAX_UNPACKED || local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) return undefined;
      const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
      const raw = bytes.subarray(start, start + compressed);
      const data = method === 0 ? raw : method === 8 ? new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) })) : undefined;
      if (data === undefined || data.length !== size) return undefined;
      out.set(name, data);
    }
  } catch {
    return undefined;
  }
  return out;
}

const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, v]) => [k, stable(v)]))
  : value;

/** A GLB as two members: `json` (its JSON chunk, keys sorted, one value per line) and `bin` (its buffer). */
export function glbMembers(bytes: Uint8Array): Map<string, Uint8Array> | undefined {
  if (bytes.byteLength < 20 || u32(bytes, 0) !== 0x46546c67 || u32(bytes, 4) !== 2) return undefined;
  const out = new Map<string, Uint8Array>();
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const length = u32(bytes, at);
    const type = u32(bytes, at + 4);
    const chunk = bytes.subarray(at + 8, at + 8 + length);
    if (type === 0x4e4f534a && !out.has('json')) {
      try {
        out.set('json', new TextEncoder().encode(JSON.stringify(stable(JSON.parse(new TextDecoder().decode(chunk))), null, 1)));
      } catch {
        return undefined;
      }
    } else if (type === 0x004e4942 && !out.has('bin')) out.set('bin', chunk);
    at += 8 + length;
  }
  return out.has('json') ? out : undefined;
}

const textOf = (bytes: Uint8Array): string | undefined => bytes.subarray(0, 8192).includes(0) ? undefined : new TextDecoder('utf-8', { fatal: false }).decode(bytes);

/** Compare two containers member by member, or undefined when either cannot be read. */
export function compareInside(a: Uint8Array, b: Uint8Array, mediaType: string, path: string): InsideCompare | undefined {
  const kind = isGlbOutput(mediaType, path) ? 'glb' : isZipOutput(mediaType, path) ? 'zip' : undefined;
  if (kind === undefined) return undefined;
  const read = kind === 'glb' ? glbMembers : zipEntries;
  const left = read(a);
  const right = read(b);
  if (left === undefined || right === undefined) return undefined;
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  let same = 0;
  let onlyTimes = true;
  const members: MemberCompare[] = [];
  for (const name of names) {
    const x = left.get(name);
    const y = right.get(name);
    const sx = x === undefined ? undefined : { sha256: sha256(x), size: x.byteLength };
    const sy = y === undefined ? undefined : { sha256: sha256(y), size: y.byteLength };
    if (sx !== undefined && sy !== undefined && sx.sha256 === sy.sha256) {
      same += 1;
      continue;
    }
    const m: MemberCompare = { path: name, state: sx === undefined ? 'added' : sy === undefined ? 'removed' : 'differs', ...(sx === undefined ? {} : { a: sx }), ...(sy === undefined ? {} : { b: sy }) };
    if (x !== undefined && y !== undefined && (name === 'json' && kind === 'glb' || isTextual('', name))) {
      const ta = textOf(x);
      const tb = textOf(y);
      if (ta !== undefined && tb !== undefined) m.text = lineDiff(ta, tb);
    }
    if (m.text?.onlyTimes !== true) onlyTimes = false;
    if (members.length < MEMBERS_SHOWN) members.push(m);
  }
  return { kind, total: names.length, same, onlyTimes: onlyTimes && same < names.length, members };
}

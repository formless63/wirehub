// The built site: the shared nav on every page, the store page and its own CSP, the
// generator at /generator/ still the repository's compose.yaml and still request-free.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildSite, buildStorePage } from '../build.mjs';
import { DEFAULTS, generateCompose } from '../src/generate.js';
import { formatSize, keyFingerprint, parsePublicKey, resolveUrl, reviewLabel, signatureStatus, yankedNotice } from '../src/store.js';
import { storeKeyFingerprint } from '../../packages/catalog/src/store-index.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const files = new Map(buildSite(root));
const pages = [...files].filter(([path]) => path.endsWith('.html'));
const topPages = pages.filter(([path]) => !path.startsWith('docs/') || path === 'docs/index.html');
const csp = (html) => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];

describe('the built site', () => {
  it('has home, generator, docs and the store page', () => {
    expect(topPages.map(([p]) => p).sort()).toEqual(['docs/index.html', 'generator/index.html', 'index.html', 'store/index.html']);
  });

  it('carries the nav on every page, with the current page marked', () => {
    for (const [path, html] of pages) {
      const depth = path.split('/').length - 1;
      const up = '../'.repeat(depth);
      for (const [label, href] of [['Home', `${up}./`], ['Config generator', `${up}generator/`], ['Module store', `${up}store/`], ['Docs', `${up}docs/`], ['GitHub', 'https://github.com/formless63/wirehub']]) {
        expect(html, `${path}: ${label}`).toMatch(new RegExp(`<a href="${href.replace(/[./]/g, '\\$&')}"[^>]*>${label}</a>`));
      }
      expect(html, path).toContain('aria-current="page"');
      expect(html, path).toContain('aria-label="WireHub home"');
      expect(html, path).toContain('prefers-color-scheme: dark');
      expect(html, path).toContain('name="viewport"');
    }
  });

  it('makes no external request from any page but the store', () => {
    for (const [path, html] of pages) {
      // the docs read their own stylesheet, script and search index (CSP 'self'); every other page is one self-contained file
      if (path.startsWith('docs/')) continue;
      expect(html, path).not.toMatch(/<script[^>]+src=|<link[^>]+rel="?stylesheet|@import/i);
      if (path !== 'store/index.html') expect(csp(html), path).not.toContain('connect-src \'self\'');
    }
  });

  it('keeps the generator strict, at /generator/, and equal to compose.yaml', () => {
    const html = files.get('generator/index.html');
    expect(csp(html)).toContain("connect-src 'none'");
    expect(html).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
    const compose = readFileSync(join(root, 'compose.yaml'), 'utf8');
    expect(html).toContain(JSON.stringify(compose).replace(/</g, '\\u003c'));
    expect(generateCompose(compose, DEFAULTS)).toBe(compose);
  });

  it('gives home a quick start and a way to the generator', () => {
    const home = files.get('index.html');
    expect(home).toContain('docker compose up -d');
    expect(home).toContain('/setup');
    expect(home).toContain('href="generator/"');
  });
});

describe('the store page', () => {
  const html = files.get('store/index.html');

  it('has its own CSP: same-origin fetch only', () => {
    expect(csp(html)).toContain("connect-src 'self'");
    expect(csp(html)).toContain("default-src 'none'");
    expect(html).toContain('How to add this store to your hub');
    expect(html).toContain('Store sources');
    expect(html).not.toMatch(/\/\*[A-Z]+\*\//);
  });

  it('is a single file also in the plain (third-party) shell, without WireHub branding', () => {
    const plain = buildStorePage({ repoRoot: root, shell: 'plain', name: 'My <shop>' });
    expect(plain).toContain('My &lt;shop&gt;');
    expect(plain).not.toContain('aria-label="WireHub home"');
    expect(csp(plain)).toContain("connect-src 'self'");
    expect(plain).toContain('index.json.minisig');
  });

  it('the action emits it', () => {
    const script = readFileSync(join(root, '.github/actions/build-store/build-store.sh'), 'utf8');
    expect(script).toContain('site/build.mjs" store-page');
    const out = mkdtempSync(join(tmpdir(), 'store-page-'));
    execFileSync('node', [join(root, 'site/build.mjs'), 'store-page', join(out, 'index.html'), '--name', 'Acme']);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('<title>Acme</title>');
  });
});

describe('store page logic', () => {
  // a real minisign-shaped key: 'Ed' + 8 key id bytes + 32 key bytes
  const bytes = Uint8Array.from({ length: 42 }, (_, i) => (i < 2 ? [0x45, 0x64][i] : (i * 7 + 3) % 256));
  const key = Buffer.from(bytes).toString('base64');

  it('parses the .pub file and the bare key, and refuses other text', () => {
    expect(parsePublicKey(`untrusted comment: x\n${key}\n`).key).toBe(key);
    expect(parsePublicKey(key).key).toBe(key);
    expect(parsePublicKey('<html>404</html>')).toBeNull();
    expect(parsePublicKey('A'.repeat(56))).toBeNull();
  });

  it('computes the same key id and fingerprint as the hub', async () => {
    const mine = await keyFingerprint(parsePublicKey(key).bytes, webcrypto.subtle);
    expect(mine).toEqual(storeKeyFingerprint(key));
  });

  it('says plainly when the index is unsigned', () => {
    const s = signatureStatus({ signaturePublished: false, key: null, official: true });
    expect(s.tone).toBe('err');
    expect(s.title).toBe('Not signed');
    expect(s.text).toContain('until the maintainer adds the store signing key');
    expect(signatureStatus({ signaturePublished: true, key: { key }, official: false }).title).toBe('Signed');
    expect(signatureStatus({ signaturePublished: true, key: null, official: false }).tone).toBe('warn');
  });

  it('labels review, yank, size and downloads', () => {
    expect(reviewLabel(undefined).text).toBe('Unreviewed');
    expect(reviewLabel({ status: 'reviewed', by: 'alice', on: '2026-10-01' }).text).toBe('Reviewed by alice on 2026-10-01');
    expect(reviewLabel({ status: 'flagged', reason: 'bad pinout' })).toEqual({ text: 'Flagged: bad pinout', tone: 'err' });
    expect(yankedNotice({ reason: 'wrong pins', on: '2026-10-02' })).toContain('Yanked (2026-10-02): wrong pins');
    expect(yankedNotice(undefined)).toBeNull();
    expect(formatSize(40071)).toBe('39.1 KiB');
    expect(resolveUrl('a-0.1.0.zip', 'https://x.io/store/index.json')).toBe('https://x.io/store/a-0.1.0.zip');
    expect(resolveUrl('javascript:alert(1)', 'https://x.io/')).toBeNull();
  });
});

describe('the official index with a publisher', () => {
  const run = (...a) => execFileSync('node', [join(root, 'scripts/store-index.mjs'), ...a], { encoding: 'utf8', env: { ...process.env, WIREHUB_PACK_SIGNING_KEY: '' } });

  it('records the wirehub publisher key', () => {
    expect(run('official-publisher-key').trim()).toBe('RWS7FUOto59buesmRailZTdc4XlAWM8BZoyFe8NeXwcHfLyeJVAIMl+h');
  });

  it('lists the publisher and records signedBy once the packs are signed (throwaway key)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'official-publisher-'));
    const keys = join(tmp, 'keys');
    const out = run('publisher-keygen', '--out', keys, '--id', 'wirehub', '--name', 'WireHub');
    const pub = /public key:\s+(RW\S+)/.exec(out)[1];
    const meta = join(tmp, 'store-meta.json');
    writeFileSync(meta, JSON.stringify({ publishers: [{ id: 'wirehub', name: 'WireHub', key: pub }] }));
    // a copy of the bundled packs: signing rewrites each manifest, never the repository's
    const modules = join(tmp, 'modules');
    for (const id of readdirSync(join(root, 'modules'))) {
      if (!existsSync(join(root, 'modules', id, 'pack', 'wirehub-pack.json'))) continue;
      mkdirSync(join(modules, id), { recursive: true });
      cpSync(join(root, 'modules', id, 'pack'), join(modules, id, 'pack'), { recursive: true });
    }
    const key = join(keys, 'wirehub-publisher.key');
    for (const id of readdirSync(modules)) {
      if (id === 'example') continue;
      run('sign-pack', join(modules, id, 'pack'), '--key', key);
      run('verify-pack-signature', join(modules, id, 'pack'), '--pubkey', pub);
    }
    const dist = join(tmp, 'dist');
    run('official', '--out', dist, '--meta', meta, '--modules', modules);
    const index = JSON.parse(readFileSync(join(dist, 'index.json'), 'utf8'));
    expect(index.publishers.map((p) => p.id)).toEqual(['wirehub']);
    const versions = index.packs.flatMap((p) => p.versions);
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) expect(v.signedBy).toEqual([pub]);

    // the index refuses an unsigned pack of a listed publisher
    const unsigned = mkdtempSync(join(tmpdir(), 'official-unsigned-'));
    cpSync(join(root, 'modules'), join(unsigned, 'modules'), { recursive: true });
    expect(() => run('official', '--out', join(unsigned, 'dist'), '--meta', meta, '--modules', join(unsigned, 'modules'))).toThrow();
  }, 60_000);
});

describe('the social card', () => {
  it('is a deterministic 1200x630 PNG, and every page points at it with OpenGraph and Twitter tags', () => {
    const png = files.get('social.png');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect(buildSite(root).find(([path]) => path === 'social.png')[1].equals(png)).toBe(true);
    for (const [path, html] of pages) {
      expect(html, path).toContain('<meta property="og:image" content="https://formless63.github.io/wirehub/social.png">');
      expect(html, path).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(html, path).toMatch(/<meta property="og:title" content="[^"]+">/);
    }
  });
});

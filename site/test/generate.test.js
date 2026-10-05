// The config generator (site/src/generate.js) against the repository's own
// files: its default output is compose.yaml byte for byte, the choices edit
// only what they should, and the built page makes no request of any kind.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildPage, readTemplates } from '../build.mjs';
import { browserSecrets, DEFAULTS, defaultImage, envValue, generate, generateCompose, generateEnv, PDF_ENGINE_URL, setupCode, stripBlocks } from '../src/generate.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const templates = readTemplates(root);
const repoCompose = readFileSync(join(root, 'compose.yaml'), 'utf8');

/** A deterministic stand-in for WebCrypto. */
function counter() {
  let n = 0;
  return (size) => Uint8Array.from({ length: size }, () => (n++ * 37) % 256);
}

const services = (compose) => [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);

describe('the default output', () => {
  it('is the repository\'s compose.yaml, byte for byte', () => {
    expect(generateCompose(templates.compose, DEFAULTS)).toBe(repoCompose);
    expect(generate(templates, {}).compose).toBe(repoCompose);
  });

  it('needs no .env: nothing is set', () => {
    const { env, notes } = generate(templates, {});
    expect(env.split('\n').filter((line) => /^[A-Z]/.test(line))).toEqual([]);
    expect(env).toContain('Nothing to set');
    expect(notes).toEqual([]);
  });

  it('offers the bundled domain modules from their own sources', () => {
    expect(templates.modules.map((m) => m.id)).toEqual(['pc-serial', 'networking', 'pro-audio', 'av-video', 'automotive']);
    expect(templates.modules.every((m) => m.description.length > 20)).toBe(true);
  });
});

describe('choices', () => {
  it('your own Postgres drops the bundled one and sets DATABASE_ADMIN_URL', () => {
    const options = { postgres: { mode: 'external', url: 'postgres://me:pw@db.example.com:5432/hub' } };
    const { compose, env } = generate(templates, options);
    expect(services(compose)).not.toContain('postgres');
    expect(compose).not.toContain('pg_data');
    expect(compose).not.toContain('bundled-postgres');
    expect(services(compose)).toEqual(expect.arrayContaining(['bootstrap', 'wirehub', 'garage', 'garage-init', 'backup-dump']));
    expect(env).toContain('DATABASE_ADMIN_URL=postgres://me:pw@db.example.com:5432/hub');
    expect(services(compose)).toContain('migrate');
  });

  it('your own S3 drops Garage and sets the S3 variables', () => {
    const options = { s3: { mode: 'external', endpoint: 'https://s3.example.com', region: 'eu-west-1', bucket: 'hub', accessKeyId: 'AKIA1', secretAccessKey: 'sec/ret+1' } };
    const { compose, env, notes } = generate(templates, options);
    expect(services(compose)).not.toContain('garage');
    expect(services(compose)).not.toContain('garage-init');
    expect(compose).not.toContain('garage_data');
    expect(compose).toContain('postgres:');
    expect(env).toContain('S3_ENDPOINT=https://s3.example.com');
    expect(env).toContain('S3_SECRET_ACCESS_KEY=sec/ret+1');
    expect(notes).toEqual([]);
  });

  it('says what is missing', () => {
    const { notes } = generate(templates, { postgres: { mode: 'external' }, s3: { mode: 'external' }, backups: { mode: 'repository' } });
    expect(notes.filter((n) => n.level === 'error').length).toBe(3);
  });

  it('backups turn the profile on, with the repository and schedule', () => {
    const local = generate(templates, { backups: { mode: 'local' } });
    expect(local.env).toContain('COMPOSE_PROFILES=backup');
    expect(local.env).not.toContain('BACKUP_REPOSITORY=');
    expect(local.notes.some((n) => n.level === 'warn' && n.text.includes('this machine'))).toBe(true);
    const remote = generate(templates, { backups: { mode: 'repository', repository: 'rest:https://u:p@nas:8000/wh', schedule: '15 2 * * *', port: '9899' } });
    expect(remote.env).toContain('BACKUP_REPOSITORY=rest:https://u:p@nas:8000/wh');
    expect(remote.env).toContain('BACKUP_SCHEDULE="15 2 * * *"');
    expect(remote.env).toContain('BACKREST_PORT=9899');
    expect(remote.compose).toBe(repoCompose);
  });

  it('the browser PDF engine turns the pdf profile on and points the app at it', () => {
    const pdf = generate(templates, { pdf: { enabled: true } });
    expect(pdf.env).toContain('COMPOSE_PROFILES=pdf\n');
    expect(pdf.env).toContain(`WIREHUB_PDF_ENGINE_URL=${PDF_ENGINE_URL}\n`);
    // a runtime setting: the .env says it can be set in the app instead
    expect(pdf.env).toContain('can also be set later in Settings');
    expect(pdf.compose).toBe(repoCompose);
    expect(pdf.notes).toEqual([]);
    // the service the profile starts is the one the URL names
    const host = new URL(PDF_ENGINE_URL).hostname;
    expect(services(repoCompose)).toContain(host);
    expect(repoCompose).toMatch(new RegExp(`\\n  ${host}:\\n    profiles: \\[pdf\\]`));
    expect(generate(templates, { pdf: { enabled: true }, backups: { mode: 'local' } }).env).toContain('COMPOSE_PROFILES=backup,pdf\n');
    expect(generate(templates, {}).env).not.toContain('WIREHUB_PDF_ENGINE_URL');
  });

  it('address, image and modules; nothing the app sets in Settings', () => {
    const { env, notes } = generate(templates, {
      publicUrl: 'https://wirehub.example.com/',
      bind: '0.0.0.0',
      port: '8080',
      imageTag: '9.9.9-test', // never the released default, which the generator leaves out,
      modules: ['networking', 'pc-serial'],
      // an option from an older page: sign-in methods are set in the app now
      oidc: { enabled: true, issuer: 'https://id.example.com', clientId: 'wh', clientSecret: 's3cr3t' },
    });
    expect(env).toContain('WIREHUB_PUBLIC_URL=https://wirehub.example.com\n');
    expect(env).toContain('WIREHUB_BIND=0.0.0.0');
    expect(env).toContain('WIREHUB_PORT=8080');
    expect(env).toContain(`WIREHUB_IMAGE=${defaultImage(templates.compose).replace(/:[^:]+$/, '')}:9.9.9-test`);
    // in the order setup lists them
    expect(env).toContain('WIREHUB_SUGGESTED_MODULES=pc-serial,networking');
    expect(env).not.toMatch(/AUTH_|WIREHUB_NOTIFY|WIREHUB_GIT_MIRROR|WIREHUB_CONVERT_WINDOW/);
    expect(env).toContain('set in the app (Settings)');
    expect(notes.some((n) => n.level === 'warn' && n.text.includes('every interface'))).toBe(true);
    // the release the page was built with needs no WIREHUB_IMAGE
    const pinned = defaultImage(templates.compose).split(':').pop();
    expect(generateEnv(templates, { imageTag: pinned }).text).not.toContain('WIREHUB_IMAGE');
  });

  it('offers no runtime setting the compose file no longer passes to the app', () => {
    // every variable the generator can write reaches a service of compose.yaml (or picks a profile / the image)
    const { env } = generate(templates, { publicUrl: 'https://h.example', bind: '0.0.0.0', port: '8080', timezone: 'Europe/Berlin', modules: ['networking'], postgres: { mode: 'external', url: 'postgres://a:b@db/x' }, s3: { mode: 'external', endpoint: 'https://s3.example', region: 'r', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', backupAccessKeyId: 'bk', backupSecretAccessKey: 'bs' }, backups: { mode: 'repository', repository: 'rest:https://nas/x', password: 'p', awsAccessKeyId: 'a', awsSecretAccessKey: 's', schedule: '1 2 * * *', port: '9899', bind: '0.0.0.0' }, pdf: { enabled: true }, secrets: 'browser' }, counter());
    const names = [...env.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    const consumedByCompose = (name) => new RegExp(`\\$\\{${name}[:}]|^\\s+${name}:`, 'm').test(repoCompose);
    const special = new Set(['COMPOSE_PROFILES', 'WIREHUB_PUBLIC_URL', 'WIREHUB_BIND', 'WIREHUB_PORT', 'WIREHUB_IMAGE']);
    expect(names.length).toBeGreaterThan(15);
    for (const name of names) expect(special.has(name) || consumedByCompose(name), name).toBe(true);
  });

  it('warns about an open port', () => {
    expect(generate(templates, { bind: '0.0.0.0' }).notes.some((n) => n.level === 'warn' && n.text.includes('TLS reverse proxy'))).toBe(true);
  });
});

describe('secrets made in the browser', () => {
  it('are the ones the bootstrap service would make, in the same shapes', () => {
    const secrets = browserSecrets(DEFAULTS, counter());
    expect(Object.keys(secrets)).toEqual(['POSTGRES_PASSWORD', 'BETTER_AUTH_SECRET', 'WIREHUB_SETTINGS_KEY', 'GARAGE_RPC_SECRET', 'GARAGE_ADMIN_TOKEN', 'WIREHUB_SETUP_CODE']);
    expect(secrets.WIREHUB_SETTINGS_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secrets.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    expect(secrets.GARAGE_RPC_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.BETTER_AUTH_SECRET).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secrets.WIREHUB_SETUP_CODE).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('leave out what your own services do not need, and add the repository password', () => {
    const secrets = browserSecrets({ postgres: { mode: 'external' }, s3: { mode: 'external' }, backups: { mode: 'local' } }, counter());
    expect(Object.keys(secrets)).toEqual(['BETTER_AUTH_SECRET', 'WIREHUB_SETTINGS_KEY', 'WIREHUB_SETUP_CODE', 'BACKUP_REPOSITORY_PASSWORD']);
  });

  it('go into the .env only when asked for', () => {
    expect(generate(templates, { secrets: 'browser' }, counter()).env).toMatch(/\nPOSTGRES_PASSWORD=[0-9a-f]{48}\n/);
    expect(generate(templates, {}, counter()).env).not.toContain('POSTGRES_PASSWORD');
    expect(setupCode(counter())).toMatch(/^[A-Z2-9]{4}-/);
  });
});

describe('helpers', () => {
  it('quotes values compose would read differently', () => {
    expect(envValue('plain-value_1.2')).toBe('plain-value_1.2');
    expect(envValue('0 3 * * *')).toBe('"0 3 * * *"');
    expect(envValue('a$b"c')).toBe('"a\\$b\\"c"');
  });

  it('refuses an unpaired marker', () => {
    expect(() => stripBlocks('a\n# >>> x\nb\n', ['x'])).toThrow(/has no/);
    expect(stripBlocks('a\n  # >>> x: note\nb\n  # <<< x\nc', ['x'])).toBe('a\nc');
  });
});

describe('the built page', () => {
  const page = buildPage(root);

  it('is one self-contained file that makes no request', () => {
    expect(page).not.toMatch(/<script[^>]+src=/i);
    expect(page).not.toMatch(/<link[^>]+rel="?stylesheet/i);
    expect(page).not.toMatch(/@import|url\(\s*['"]?https?:/i);
    expect(page).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|localStorage|sessionStorage|indexedDB/);
    expect(page).toContain("connect-src 'none'");
    expect(page).toContain('Everything happens in this browser');
  });

  it('embeds the compose template and the modules', () => {
    expect(page).toContain(JSON.stringify(repoCompose).replace(/</g, '\\u003c'));
    expect(page).toContain('"id":"automotive"');
    expect(page).not.toContain('/*SCRIPT*/');
    expect(page).not.toMatch(/^\s*import\s/m);
    expect(page).not.toMatch(/^export /m);
  });
});

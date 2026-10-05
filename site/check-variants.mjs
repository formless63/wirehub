// Writes the generator's main variants (your own Postgres, your own S3, both
// with backups and sign-in) into a temporary directory and has
// `docker compose config` validate each, with and without the backup and pdf profiles.
// CI runs it; so can you: node site/check-variants.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTemplates } from './build.mjs';
import { generate } from './src/generate.js';

const external = { postgres: { mode: 'external', url: 'postgres://u:p@db.example.com:5432/x' } };
const s3 = { s3: { mode: 'external', endpoint: 'https://s3.example.com', region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 'b' } };
const variants = {
  default: {},
  'own-postgres': external,
  'own-s3': s3,
  everything: { ...external, ...s3, backups: { mode: 'repository', repository: 'rest:http://nas:8000/x' }, oidc: { enabled: true, issuer: 'https://id.example.com', clientId: 'c', clientSecret: 'd' }, secrets: 'browser', modules: ['pc-serial'], pdf: { enabled: true } },
};

const templates = readTemplates();
const work = mkdtempSync(join(tmpdir(), 'wirehub-variants-'));
try {
  for (const [name, options] of Object.entries(variants)) {
    const { compose, env } = generate(templates, options);
    writeFileSync(join(work, 'compose.yaml'), compose);
    writeFileSync(join(work, '.env'), env);
    for (const profiles of ['', 'backup', 'pdf', 'backup,pdf']) {
      execFileSync('docker', ['compose', 'config', '--quiet'], { cwd: work, env: { ...process.env, COMPOSE_PROFILES: profiles }, stdio: 'inherit' });
    }
    const services = execFileSync('docker', ['compose', 'config', '--services'], { cwd: work, encoding: 'utf8' }).trim().split('\n');
    console.log(`variants: ${name} ok (${services.join(', ')})`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

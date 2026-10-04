// WireHub config generator — the pure part: options in, compose.yaml and .env
// out. No DOM, no network, no clock; randomness only through the `random`
// argument (WebCrypto in the browser). The page (app.js) and the tests
// (site/test) both use it. The compose template is the repository's own
// compose.yaml, embedded at build time (build.mjs), so the default output IS
// that file, byte for byte. `templates` is { compose, modules }: the modules
// are the bundled domain modules' ids, labels and descriptions, read from
// modules/*/src/index.ts at build time.

/** Every option, at the value that reproduces the repository's compose.yaml and needs no .env. */
export const DEFAULTS = Object.freeze({
  publicUrl: '',
  bind: '127.0.0.1',
  port: '5183',
  imageTag: '',
  timezone: '',
  modules: [],
  secrets: 'bootstrap', // 'bootstrap' (recommended) | 'browser'
  postgres: { mode: 'bundled', url: '' },
  s3: { mode: 'bundled', endpoint: '', region: '', bucket: '', accessKeyId: '', secretAccessKey: '', backupAccessKeyId: '', backupSecretAccessKey: '' },
  backups: { mode: 'off', repository: '', password: '', awsAccessKeyId: '', awsSecretAccessKey: '', schedule: '0 3 * * *', bind: '127.0.0.1', port: '9898' },
  oidc: { enabled: false, issuer: '', clientId: '', clientSecret: '', name: '', providerId: '', allowedEmails: '' },
});

/** Options with every field present: `DEFAULTS` overlaid with what was given. */
export function withDefaults(options = {}) {
  return {
    ...DEFAULTS,
    ...options,
    modules: [...(options.modules ?? DEFAULTS.modules)],
    postgres: { ...DEFAULTS.postgres, ...(options.postgres ?? {}) },
    s3: { ...DEFAULTS.s3, ...(options.s3 ?? {}) },
    backups: { ...DEFAULTS.backups, ...(options.backups ?? {}) },
    oidc: { ...DEFAULTS.oidc, ...(options.oidc ?? {}) },
  };
}

/** Drop every `# >>> name` … `# <<< name` block (markers included) for the names given. */
export function stripBlocks(text, names) {
  const out = [];
  let skipping;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (skipping === undefined) {
      const open = names.find((name) => trimmed === `# >>> ${name}` || trimmed.startsWith(`# >>> ${name}:`));
      if (open !== undefined) {
        skipping = open;
        continue;
      }
      out.push(line);
    } else if (trimmed === `# <<< ${skipping}`) {
      skipping = undefined;
    }
  }
  if (skipping !== undefined) throw new Error(`compose template: "# >>> ${skipping}" has no "# <<< ${skipping}"`);
  return out.join('\n');
}

/** The image the template pins (`${WIREHUB_IMAGE:-<this>}`). */
export function defaultImage(template) {
  const match = /\$\{WIREHUB_IMAGE:-([^}]+)\}/.exec(template);
  if (match === null) throw new Error('compose template: no ${WIREHUB_IMAGE:-…} default');
  return match[1];
}

/** compose.yaml for these options: the template, minus the bundled services replaced by your own. */
export function generateCompose(template, options) {
  const o = withDefaults(options);
  const drop = [];
  if (o.postgres.mode === 'external') drop.push('bundled-postgres');
  if (o.s3.mode === 'external') drop.push('bundled-s3');
  return drop.length === 0 ? template : stripBlocks(template, drop);
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** `random(n)` returns n random bytes (Uint8Array): WebCrypto's getRandomValues in the browser. */
export function browserRandom(n) {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const toBase64url = (bytes) => {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** A setup code, XXXX-XXXX-XXXX, from unbiased random bytes. */
export function setupCode(random) {
  const chars = [];
  while (chars.length < 12) {
    for (const byte of random(16)) {
      if (byte < 248 && chars.length < 12) chars.push(CODE_ALPHABET[byte % 31]);
    }
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}

/** The secrets the bootstrap service would generate, made here instead. */
export function browserSecrets(options, random) {
  const o = withDefaults(options);
  const secrets = {};
  if (o.postgres.mode === 'bundled') secrets.POSTGRES_PASSWORD = toHex(random(24));
  secrets.BETTER_AUTH_SECRET = toBase64url(random(32));
  if (o.s3.mode === 'bundled') {
    secrets.GARAGE_RPC_SECRET = toHex(random(32));
    secrets.GARAGE_ADMIN_TOKEN = toBase64url(random(32));
  }
  secrets.WIREHUB_SETUP_CODE = setupCode(random);
  if (o.backups.mode !== 'off' && o.backups.password.trim() === '') secrets.BACKUP_REPOSITORY_PASSWORD = toBase64url(random(32));
  return secrets;
}

/** One `.env` value: quoted when it holds anything a shell or compose would read differently. */
export function envValue(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@,+=%-]*$/.test(text) ? text : `"${text.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * .env for these options: only what differs from the defaults, with a comment
 * per group. `secrets` (from `browserSecrets`) are written when given.
 * Returns the text and notes (warnings and next steps) for the page.
 */
export function generateEnv(templates, options, secrets = {}) {
  const template = templates.compose;
  const modules = templates.modules ?? [];
  const o = withDefaults(options);
  const notes = [];
  const groups = [];
  const group = (title, entries) => {
    const lines = entries.filter(([, value]) => value !== undefined && value !== '').map(([name, value]) => `${name}=${envValue(value)}`);
    if (lines.length > 0) groups.push([`# --- ${title}`, ...lines].join('\n'));
  };
  const trim = (value) => (typeof value === 'string' ? value.trim() : value);

  const image = defaultImage(template);
  const tag = trim(o.imageTag);
  const imageBase = image.replace(/:[^:/]+$/, '');
  const pinned = image.slice(imageBase.length + 1);
  group('optional parts', [['COMPOSE_PROFILES', o.backups.mode === 'off' ? '' : 'backup']]);
  group('the app', [
    ['WIREHUB_IMAGE', tag === '' || tag === pinned ? '' : `${imageBase}:${tag}`],
    ['WIREHUB_PUBLIC_URL', trim(o.publicUrl).replace(/\/+$/, '')],
    ['WIREHUB_BIND', trim(o.bind) === DEFAULTS.bind ? '' : trim(o.bind)],
    ['WIREHUB_PORT', trim(o.port) === DEFAULTS.port ? '' : trim(o.port)],
    ['TZ', trim(o.timezone)],
    ['WIREHUB_SUGGESTED_MODULES', modules.filter((m) => o.modules.includes(m.id)).map((m) => m.id).join(',')],
  ]);
  if (o.postgres.mode === 'external') {
    if (trim(o.postgres.url) === '') notes.push({ level: 'error', text: 'Your own Postgres: give its connection URL (postgres://user:password@host:5432/db).' });
    group('your own PostgreSQL', [['DATABASE_URL', trim(o.postgres.url)]]);
  }
  if (o.s3.mode === 'external') {
    if (trim(o.s3.endpoint) === '' || trim(o.s3.accessKeyId) === '' || trim(o.s3.secretAccessKey) === '') {
      notes.push({ level: 'error', text: 'Your own S3: give the endpoint and the access key id and secret.' });
    }
    group('your own S3', [
      ['S3_ENDPOINT', trim(o.s3.endpoint)],
      ['S3_REGION', trim(o.s3.region)],
      ['S3_BUCKET', trim(o.s3.bucket)],
      ['S3_ACCESS_KEY_ID', trim(o.s3.accessKeyId)],
      ['S3_SECRET_ACCESS_KEY', trim(o.s3.secretAccessKey)],
      ['S3_BACKUP_ACCESS_KEY_ID', trim(o.s3.backupAccessKeyId)],
      ['S3_BACKUP_SECRET_ACCESS_KEY', trim(o.s3.backupSecretAccessKey)],
    ]);
  }
  if (o.oidc.enabled) {
    if (trim(o.oidc.issuer) === '' || trim(o.oidc.clientId) === '' || trim(o.oidc.clientSecret) === '') {
      notes.push({ level: 'error', text: 'Sign-in with OIDC: give the issuer, the client id and the client secret.' });
    }
    if (trim(o.publicUrl) === '') notes.push({ level: 'warn', text: 'Sign-in needs the public URL people open WireHub at; the redirect URI is built from it.' });
    const base = trim(o.publicUrl).replace(/\/+$/, '') || 'http://localhost:5183';
    notes.push({ level: 'info', text: `Register this redirect URI with your identity provider: ${base}/api/auth/callback/${trim(o.oidc.providerId) || 'oidc'}` });
    group('sign-in (OIDC)', [
      ['AUTH_ENABLED', 'true'],
      ['AUTH_ALLOWED_EMAILS', trim(o.oidc.allowedEmails)],
      ['AUTH_OIDC_ISSUER', trim(o.oidc.issuer)],
      ['AUTH_OIDC_CLIENT_ID', trim(o.oidc.clientId)],
      ['AUTH_OIDC_CLIENT_SECRET', trim(o.oidc.clientSecret)],
      ['AUTH_OIDC_NAME', trim(o.oidc.name)],
      ['AUTH_OIDC_PROVIDER_ID', trim(o.oidc.providerId)],
    ]);
  }
  if (o.backups.mode !== 'off') {
    if (o.backups.mode === 'local') {
      notes.push({ level: 'warn', text: 'Backups go to a volume on this machine: they protect against mistakes, not against losing the disk. A repository on another machine is better.' });
    } else if (trim(o.backups.repository) === '') {
      notes.push({ level: 'error', text: 'Backups to an existing repository: give its URL (rest:…, s3:…, sftp:…).' });
    }
    if (o.backups.mode === 'repository' && trim(o.backups.password) === '') {
      notes.push({ level: 'info', text: 'No repository password given: a new repository gets a generated one. An existing repository needs its own password here.' });
    }
    notes.push({ level: 'info', text: 'Keep a copy of the restic repository password somewhere else: a backup cannot be restored without it.' });
    group('backups', [
      ['BACKUP_REPOSITORY', o.backups.mode === 'repository' ? trim(o.backups.repository) : ''],
      ['BACKUP_REPOSITORY_PASSWORD', trim(o.backups.password)],
      ['BACKUP_AWS_ACCESS_KEY_ID', o.backups.mode === 'repository' ? trim(o.backups.awsAccessKeyId) : ''],
      ['BACKUP_AWS_SECRET_ACCESS_KEY', o.backups.mode === 'repository' ? trim(o.backups.awsSecretAccessKey) : ''],
      ['BACKUP_SCHEDULE', trim(o.backups.schedule) === DEFAULTS.backups.schedule ? '' : trim(o.backups.schedule)],
      ['BACKREST_BIND', trim(o.backups.bind) === DEFAULTS.backups.bind ? '' : trim(o.backups.bind)],
      ['BACKREST_PORT', trim(o.backups.port) === DEFAULTS.backups.port ? '' : trim(o.backups.port)],
    ]);
  }
  group('secrets, generated in this browser', Object.entries(secrets));
  if (trim(o.bind) === '0.0.0.0' && !o.oidc.enabled) {
    notes.push({ level: 'warn', text: 'WireHub is published on every interface with sign-in off: anyone who reaches the port can edit. Turn sign-in on, and put a TLS reverse proxy in front.' });
  }

  const header = [
    '# WireHub .env — written by the config generator (https://formless63.github.io/wirehub/).',
    '# Every variable is explained in .env.example. Secrets not listed here are',
    '# generated by the bootstrap service on first start and kept in the `secrets` volume.',
  ];
  const body = groups.length === 0 ? ['', '# Nothing to set: the defaults need no .env at all.'] : ['', groups.join('\n\n')];
  return { text: `${[...header, ...body].join('\n')}\n`, notes };
}

/** Both files and the notes. `random` is used only when the options ask for secrets made here. */
export function generate(templates, options, random = browserRandom) {
  const o = withDefaults(options);
  const secrets = o.secrets === 'browser' ? browserSecrets(o, random) : {};
  const env = generateEnv(templates, o, secrets);
  return { compose: generateCompose(templates.compose, o), env: env.text, notes: env.notes, secrets };
}

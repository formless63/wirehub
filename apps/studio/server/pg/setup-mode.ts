/**
 * Setup mode (`specs/postgres-backend.md` §9.1–9.2; task S3): a database
 * backend with no organisation yet. Every API route but `/api/setup` answers
 * 503 `{ state: 'setup' }`; `/setup` (with the one-time setup code) creates:
 *
 * 1. the organisation (name and slug) and its catalog — the **starter**
 *    catalog, or an **empty** one (the three required lists, the base
 *    vocabulary) — imported as the first change set (`source='import'`);
 * 2. the admin: a person with the owner role and, with local accounts on, an
 *    email + password account the browser then signs in with;
 * 3. the chosen domain modules' packs, through the ordinary setup (one more
 *    change set), which also stores the completed `setup.json`.
 *
 * Then the backend's deps are filled in place with the org's stores and setup
 * mode ends — no restart. A failure before the catalog is in removes the org
 * again, so a retried setup starts clean.
 */

import { dataPath } from '@wirehub/catalog';
import { readCatalogTree } from '@wirehub/catalog/src/codec/tree.ts';
import type { CatalogFiles } from '@wirehub/catalog/src/codec/index.ts';
import { sql } from 'kysely';

import type { ApiResponse, WorkbenchDeps } from '../api.ts';
import type { StudioAuth } from '../auth/studio-auth.ts';
import { pgPeople } from '../auth/people.ts';
import type { BlobStore } from '../blobs.ts';
import type { DepictionStore } from '../depictions.ts';
import { localStudioUser } from '../me.ts';
import { registry } from '../modules.ts';
import { codeMatches, handleSetupRequest, type SetupDeps } from '../setup.ts';
import { inOrg, type Db } from './db.ts';
import { ensureOrg, ImportError, importCatalog } from './import.ts';

export interface SetupModeOptions {
  db: Db;
  blobs?: BlobStore;
  code?: string;
  suggested?: readonly string[];
  auth: () => StudioAuth | undefined;
  /** fill the backend's deps with the new org's stores; answers the filled deps */
  activate: (orgId: string) => Promise<WorkbenchDeps>;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const MIN_PASSWORD = 12;

const json = (status: number, body: unknown): ApiResponse => ({ status, body });
const refuse = (status: number, error: string, hint?: string): ApiResponse => json(status, { error, ...(hint === undefined ? {} : { hint }) });

/** The catalog a new org starts from (§9.4): the image's starter, or the three required lists and the base vocabulary. */
export function initialCatalog(kind: 'starter' | 'empty', root = dataPath('..')): CatalogFiles {
  const starter = readCatalogTree(root);
  if (kind === 'starter') return starter;
  const files = new Map<string, string | Uint8Array>();
  for (const list of ['connectors', 'wires', 'components']) files.set(`data/${list}.json`, '[]\n');
  for (const [path, content] of starter) {
    if (path.startsWith('data/vocab/') || path === 'data/tags/review.json' || path === 'data/LICENSE') files.set(path, content as string);
  }
  return files;
}

/** A depiction store with nothing in it (setup mode serves no artwork). */
export function emptyDepictionStore(): DepictionStore {
  return {
    listDefIds: () => [],
    readMeta: () => undefined,
    writeMeta: () => {
      throw new Error('this hub is not set up yet');
    },
    readAsset: () => undefined,
    writeAsset: () => {
      throw new Error('this hub is not set up yet');
    },
    dirFor: () => undefined,
  };
}

function notSetUp(): never {
  throw new Error('this hub is not set up yet: open /setup');
}

/** What the setup page needs to know about the admin it is about to create. */
function adminMode(auth: StudioAuth | undefined): 'password' | 'oidc' | 'none' {
  if (auth === undefined) return 'none';
  return auth.config.localAccounts ? 'password' : 'oidc';
}

export function setupModeDeps(options: SetupModeOptions): WorkbenchDeps {
  const { db } = options;
  let creating = false;

  const view = async (request: { method: string; body?: unknown }): Promise<ApiResponse> => {
    // the domains, as the ordinary setup lists them, over the starter catalog
    const base = await handleSetupRequest(
      { method: 'GET' },
      { dataDir: dataPath(''), packsDir: '/nonexistent-wirehub-packs', prompt: true, now: () => new Date().toISOString(), ...(options.code === undefined ? {} : { code: options.code }), ...(options.suggested === undefined ? {} : { suggested: options.suggested }) },
      registry,
    );
    void request;
    return json(200, {
      ...(base.body as object),
      needed: true,
      completed: false,
      create: { catalogs: ['starter', 'empty'], admin: adminMode(options.auth()), minPassword: MIN_PASSWORD },
    });
  };

  const create = async (request: { method: string; body?: unknown; user?: { name: string } }): Promise<ApiResponse> => {
    const method = request.method.toUpperCase();
    if (method === 'GET') return view(request);
    if (method !== 'POST') return refuse(405, `${method} is not something this address accepts.`, 'It answers GET and POST.');
    const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as {
      code?: unknown;
      modules?: unknown;
      org?: { name?: unknown; slug?: unknown };
      admin?: { name?: unknown; email?: unknown; password?: unknown };
      catalog?: unknown;
    };
    if (options.code !== undefined && !codeMatches(options.code, body.code)) {
      return refuse(403, body.code === undefined || body.code === '' ? 'Enter the setup code.' : 'That is not the setup code.', "The server prints it to its log at startup: `docker compose logs wirehub`, or the wirehub container's logs in your Docker UI.");
    }
    const orgName = typeof body.org?.name === 'string' ? body.org.name.trim() : '';
    const slug = typeof body.org?.slug === 'string' ? body.org.slug.trim() : '';
    if (orgName === '' || orgName.length > 120) return refuse(400, 'Name the organisation.', 'The shop or team this hub is for, as people call it.');
    if (!SLUG.test(slug)) return refuse(400, `${JSON.stringify(slug)} cannot be the organisation's short name.`, 'Lowercase letters, digits and hyphens, like example-shop.');
    const catalog = body.catalog === undefined ? 'starter' : body.catalog;
    if (catalog !== 'starter' && catalog !== 'empty') return refuse(400, 'Pick the starter catalog or an empty one.');
    const modules = body.modules === undefined ? [] : body.modules;
    if (!Array.isArray(modules) || !modules.every((m): m is string => typeof m === 'string')) return refuse(400, 'Say which domain modules to enable.', 'Send { "modules": [...] } — an empty list is fine.');
    const unknown = modules.filter((id) => !registry.domains().some((m) => m.id === id));
    if (unknown.length > 0) return refuse(400, `Not a domain module of this build: ${unknown.join(', ')}.`);
    const auth = options.auth();
    const mode = adminMode(auth);
    const adminName = typeof body.admin?.name === 'string' ? body.admin.name.trim() : '';
    const adminEmail = typeof body.admin?.email === 'string' ? body.admin.email.trim().toLowerCase() : '';
    const password = typeof body.admin?.password === 'string' ? body.admin.password : '';
    if (mode !== 'none' || adminEmail !== '') {
      if (adminName === '') return refuse(400, 'Give the admin a name.');
      if (!EMAIL.test(adminEmail)) return refuse(400, `${JSON.stringify(adminEmail)} is not an email address.`, 'The admin signs in with it.');
    }
    if (mode === 'password' && password.length < MIN_PASSWORD) return refuse(400, `The admin's password needs ${MIN_PASSWORD} characters or more.`);
    if (creating) return refuse(409, 'Setup is already running.', 'Reload in a moment.');
    creating = true;
    let orgId: string | undefined;
    try {
      // 1. the organisation and its catalog, the first change set
      orgId = await ensureOrg(db, slug, orgName, true);
      await importCatalog(db, {
        org: { slug },
        files: initialCatalog(catalog),
        ...(options.blobs === undefined ? {} : { blobs: options.blobs }),
        actorLabel: adminName === '' ? (localStudioUser(process.env)?.name ?? 'WireHub (local)') : adminName,
        message: `Initial catalog: ${catalog}`,
      });
    } catch (error) {
      creating = false;
      if (orgId !== undefined) await removeOrg(db, orgId).catch(() => {});
      if (error instanceof ImportError) return refuse(500, error.message);
      throw error;
    }
    try {
      // 2. the admin: the org's owner
      if (adminEmail !== '') await pgPeople(db, orgId).ensurePerson(adminEmail, adminName, 'owner');
      // 3. the org's stores; then the domain modules through the ordinary setup (it stores setup.json)
      const deps = await options.activate(orgId);
      const installed = await handleSetupRequest({ method: 'POST', body: { modules, ...(options.code === undefined ? {} : { code: options.code }) } }, deps.setup as SetupDeps, registry);
      if (installed.status >= 400) return installed;
      if (mode === 'password' && auth?.createAccount !== undefined) await auth.createAccount(adminEmail, adminName, password);
      return json(200, { ...(installed.body as object), created: { org: slug, catalog, admin: adminEmail === '' ? null : adminEmail, signIn: mode } });
    } finally {
      creating = false;
    }
  };

  const setup: SetupDeps = {
    dataDir: '',
    prompt: true,
    now: () => new Date().toISOString(),
    ...(options.code === undefined ? {} : { code: options.code }),
    ...(options.suggested === undefined ? {} : { suggested: options.suggested }),
    create,
  };
  return {
    designs: { list: () => [], has: () => false, read: () => undefined, write: notSetUp, remove: notSetUp },
    loadDb: notSetUp,
    setupMode: () => true,
    setup,
    modules: registry,
    localUser: localStudioUser(process.env),
  };
}

/** Undo a half-made org (setup failed before its catalog was in). */
async function removeOrg(db: Db, orgId: string): Promise<void> {
  await inOrg(db, orgId, async (tx) => {
    await sql`DELETE FROM studio.catalog_head`.execute(tx);
    await sql`DELETE FROM studio.person`.execute(tx);
    await sql`DELETE FROM studio.org WHERE id = ${orgId}::uuid`.execute(tx);
  });
}

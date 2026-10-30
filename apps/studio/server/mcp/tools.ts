/**
 * WireHub's MCP server (`docs/mcp.md`): workflow-level tools over the same
 * `/api/*` operations the editor uses, through `api-client.ts`. A tool never
 * writes anything the caller's token could not write over plain HTTP; a write
 * quotes the ETag it read (If-Match), so a record someone changed in between
 * is refused (409) rather than overwritten, and every write tool takes
 * `dryRun` to preview the would-be change set first.
 *
 * One server instance per HTTP request (`createMcpHandler`'s factory), so the
 * tools close over that request's credentials and nothing else.
 */

import { McpServer, ResourceTemplate, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';

import type { ApiAnswer, ApiClient } from './api-client.ts';

export const MCP_SERVER_NAME = 'wirehub';
export const MCP_SERVER_VERSION = '0.1.0';

const DEFINITION_KINDS = ['connectors', 'components', 'wires', 'pcbas', 'bodies', 'interfaces', 'mechanicals', 'kits'] as const;
/** a text document bigger than this is cut, with a note and the address to fetch it whole */
const MAX_TEXT = 200_000;
/** a binary document bigger than this is not inlined, only addressed */
const MAX_BLOB = 4_000_000;

export const GUIDE = `WireHub over MCP — how the tools fit together.

- You act as the person who owns the API token. Their role and the token's scopes apply to every call.
- Read first: list_designs / search_library, then get_design / get_library_item. Each answer carries an
  "etag": quote it as "ifMatch" when you write that record. A 409 means somebody changed it since you
  read it: read again, re-apply your change, and say so; never retry blindly. A 423 means a person holds
  an edit lock on it.
- Every write tool takes "dryRun": true to preview the change set (per record: op, RFC 6902 patch, line
  diff, derived records) without writing anything. Dry runs never spend a draft grant's budget.
- update_design takes a JSON merge patch (RFC 7396) or a whole design. validate_design reports the
  checks' errors and warnings; a save with errors is refused (422) with the same list.
- A draft-work grant (scope drafts:write) creates and edits designs and library items only: no deletes,
  renames, version saves, approvals, publishing or settings. whoami shows its remaining write budget.
- Every committed write is a change set in History, attributed to the token's person; any record can be
  restored from there. Saving a version or releasing stays a person's deliberate act in the app.
- Documents (schematic, build-sheet, bom, test-spec, drawing, labels, formboard) render from the stored
  design: generate_document returns text formats inline and small binaries as embedded resources.
- Jobs: list_jobs, get_job, submit_job, cancel_job. A job runs in the background; poll get_job.
- Your writes form one checkpoint in History (all change sets made with this token): the person reviews
  them together and can undo them together. whoami names it. You cannot undo it yourself.
- Explore: explore lists ranked combinations for a requirement (connect two devices, or enclose a board),
  each valid, invalid (why) or unknown (which facts nobody stated). explore_pick turns one into a draft
  design or shell part and records the pick; say which combination and why.`;

/* ------------------------------ helpers ------------------------------ */

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** An API refusal as a tool error: the status and the API's own `{ error, hint, issues }`. */
function refused(answer: ApiAnswer, doing: string): CallToolResult {
  const body = (answer.body ?? {}) as Record<string, unknown>;
  const advice =
    answer.status === 409
      ? 'The record changed since its etag was read: read it again, re-apply the change, and report the conflict.'
      : answer.status === 423
        ? 'A person holds an edit lock on it. Leave it, or ask them.'
        : answer.status === 428
          ? 'Quote the etag you read as ifMatch.'
          : answer.status === 403
            ? 'The token may not do this. Do not look for another way round; tell the person.'
            : undefined;
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ status: answer.status, doing, ...body, ...(advice === undefined ? {} : { advice }) }, null, 2) }],
  };
}

/** A dry run's answer without the would-be document itself: the change set (per record op, RFC 6902 patch, line diff) and what it would derive. */
function preview(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const { body: _document, ...rest } = body as Record<string, unknown>;
  return rest;
}

const lower = (v: unknown): string => (typeof v === 'string' ? v.toLowerCase() : '');

/** RFC 7396 JSON merge patch. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> = typeof target === 'object' && target !== null && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

/** The fields of a library record worth showing in a list. */
function itemRow(kind: string, record: Record<string, unknown>, etag?: string): Record<string, unknown> {
  const keep = ['id', 'label', 'name', 'partNumber', 'mpn', 'manufacturer', 'revision', 'family', 'status'];
  const row: Record<string, unknown> = { kind };
  for (const key of keep) if (record[key] !== undefined && typeof record[key] !== 'object') row[key] = record[key];
  if (etag !== undefined) row['etag'] = etag;
  row['uiPath'] = `/library/${kind}/${String(record['id'])}`;
  return row;
}

function matches(record: Record<string, unknown>, query: string): boolean {
  if (query === '') return true;
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== '');
  const hay = ['id', 'label', 'name', 'partNumber', 'mpn', 'manufacturer', 'family', 'description', 'src'].map((k) => lower(record[k])).join(' ');
  return words.every((w) => hay.includes(w));
}

/** A record's resolved cover (the shared cover resolver): which picture stands for it, and how faithful it is. */
function coverOf(answer: ApiAnswer | undefined): Record<string, unknown> | undefined {
  if (answer?.ok !== true) return undefined;
  const resolution = ((answer.body ?? {}) as { resolution?: { state?: string; selected?: Record<string, unknown> } }).resolution;
  if (resolution === undefined) return undefined;
  const s = resolution.selected;
  return { state: resolution.state, ...(s === undefined ? {} : { view: s['view'], label: s['label'], fidelity: s['fidelity'], sourceKind: s['sourceKind'], asset: s['asset'] }) };
}

const etagSchema = z.string().min(1).describe('The etag you read with the record (sent as If-Match).');
const dryRunSchema = z.boolean().optional().describe('Preview the change set without writing anything (default false).');
const designId = z.string().min(1).max(120).describe('A design id (kebab-case).');

/* ------------------------------ the server ------------------------------ */

export function createWireHubMcpServer(api: ApiClient): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION, title: 'WireHub' },
    { instructions: GUIDE },
  );

  server.registerTool(
    'whoami',
    {
      title: 'Who am I here',
      description: 'The person this token acts as, their role, the token scopes and (for a draft-work grant) its remaining write budget.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const me = await api.call('GET', '/api/me');
      if (!me.ok) return refused(me, 'reading who you are');
      const user = ((me.body ?? {}) as { user?: Record<string, unknown> }).user ?? {};
      const writes = user['apiTokenWrites'] as { budget: number; used: number } | undefined;
      const token = typeof user['apiTokenId'] === 'string' ? user['apiTokenId'] : undefined;
      return json({
        name: user['name'],
        role: user['role'] ?? null,
        scopes: user['apiTokenScopes'] ?? null,
        ...(writes === undefined ? {} : { writeBudget: writes.budget, writesUsed: writes.used, writesLeft: writes.budget - writes.used }),
        // every change set this token makes is one checkpoint in History, reviewed and undone together
        ...(token === undefined ? {} : { checkpoint: { token, uiPath: `/history?token=${token}` } }),
      });
    },
  );

  server.registerTool(
    'list_designs',
    {
      title: 'List designs',
      description: 'The cable/assembly designs in this hub, optionally filtered by words in their id, label, ends or product names.',
      inputSchema: z.object({ query: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const answer = await api.call('GET', '/api/designs');
      if (!answer.ok) return refused(answer, 'listing designs');
      const rows = (((answer.body ?? {}) as { designs?: Record<string, unknown>[] }).designs ?? []).filter((d) => {
        if (query === undefined || query.trim() === '') return true;
        const hay = [d['id'], d['label'], d['source'], d['destination'], ...((d['productSearch'] as string[] | undefined) ?? [])].map(lower).join(' ');
        return query.toLowerCase().split(/\s+/).filter((w) => w !== '').every((w) => hay.includes(w));
      });
      const max = limit ?? 100;
      return json({
        total: rows.length,
        designs: rows.slice(0, max).map((d) => ({ id: d['id'], label: d['label'], status: d['status'], source: d['source'], destination: d['destination'], uiPath: `/cables/${String(d['id'])}` })),
        ...(rows.length > max ? { truncated: true } : {}),
      });
    },
  );

  server.registerTool(
    'search_library',
    {
      title: 'Search the library',
      description: `Library items (${DEFINITION_KINDS.join(', ')}) whose id, label, part number, maker or description contain all the words.`,
      inputSchema: z.object({ query: z.string().optional(), kind: z.enum(DEFINITION_KINDS).optional(), limit: z.number().int().min(1).max(500).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, kind, limit }) => {
      const kinds = kind === undefined ? DEFINITION_KINDS : [kind];
      const found: Record<string, unknown>[] = [];
      for (const k of kinds) {
        const answer = await api.call('GET', `/api/definitions/${k}`);
        if (!answer.ok) return refused(answer, `listing ${k}`);
        const body = (answer.body ?? {}) as { records?: Record<string, unknown>[]; etags?: Record<string, string> };
        for (const record of body.records ?? []) if (matches(record, query ?? '')) found.push(itemRow(k, record, body.etags?.[String(record['id'])]));
      }
      const max = limit ?? 50;
      return json({ total: found.length, items: found.slice(0, max), ...(found.length > max ? { truncated: true } : {}) });
    },
  );

  server.registerTool(
    'get_design',
    {
      title: 'Get a design',
      description: 'One design: its full JSON (the document update_design edits), its etag, its check results, its resolved cover picture, and the documents it renders.',
      inputSchema: z.object({ id: designId, summaryOnly: z.boolean().optional().describe('Leave the full JSON out.') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, summaryOnly }) => {
      const design = await api.call('GET', `/api/designs/${encodeURIComponent(id)}`);
      if (!design.ok) return refused(design, `reading design ${id}`);
      const issues = await api.call('GET', `/api/designs/${encodeURIComponent(id)}/issues`);
      const exports = await api.call('GET', '/api/exports');
      const cover = coverOf(await api.call('GET', `/api/representations/designs/${encodeURIComponent(id)}`));
      const d = (design.body ?? {}) as Record<string, unknown>;
      const instances = (d['instances'] ?? {}) as Record<string, unknown[] | undefined>;
      const docs = ((exports.body ?? {}) as { documents?: { kind: string; default: string }[] }).documents ?? [];
      const checks = (issues.body ?? {}) as { errors?: number; warnings?: number };
      return json({
        id,
        label: d['label'],
        etag: design.etag,
        uiPath: `/cables/${id}`,
        counts: Object.fromEntries(Object.entries(instances).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0])),
        checks: issues.ok ? { errors: checks.errors, warnings: checks.warnings } : null,
        ...(cover === undefined ? {} : { cover }),
        documents: docs.map((doc) => ({ kind: doc.kind, defaultFormat: doc.default, path: `/api/designs/${id}/documents/${doc.kind}` })),
        ...(summaryOnly === true ? {} : { design: d }),
      });
    },
  );

  server.registerTool(
    'get_library_item',
    {
      title: 'Get a library item',
      description: 'One library record with its etag, where it is used, its 3D model link and, for a board, its resolved cover picture.',
      inputSchema: z.object({ kind: z.enum(DEFINITION_KINDS), id: z.string().min(1).max(160) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ kind, id }) => {
      const base = `/api/definitions/${kind}/${encodeURIComponent(id)}`;
      const record = await api.call('GET', base);
      if (!record.ok) return refused(record, `reading ${kind}/${id}`);
      const usage = await api.call('GET', `${base}/usage`);
      const model = await api.call('GET', `/api/models/${kind}/${encodeURIComponent(id)}`);
      const cover = kind === 'pcbas' ? coverOf(await api.call('GET', `/api/representations/pcbas/${encodeURIComponent(id)}`)) : undefined;
      return json({
        kind,
        id,
        etag: record.etag,
        uiPath: `/library/${kind}/${id}`,
        record: record.body,
        usage: usage.ok ? usage.body : null,
        model: model.ok ? model.body : null,
        ...(cover === undefined ? {} : { cover }),
      });
    },
  );

  server.registerTool(
    'create_design',
    {
      title: 'Create a design',
      description: 'Create a new working design from its full JSON (copy the shape of an existing one from get_design). The checks run first; errors refuse it with the list. Or duplicate an existing design under a new id.',
      inputSchema: z.object({
        design: z.record(z.string(), z.unknown()).optional().describe('The whole new design document; its "id" is the new id.'),
        duplicateOf: z.string().optional().describe('Copy this existing design instead…'),
        newId: z.string().optional().describe('…under this id'),
        newLabel: z.string().optional(),
        dryRun: dryRunSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ design, duplicateOf, newId, newLabel, dryRun }) => {
      if (duplicateOf !== undefined) {
        if (newId === undefined) return { isError: true, content: [{ type: 'text', text: 'Say the copy\'s newId.' }] };
        const answer = await api.call('POST', `/api/designs/${encodeURIComponent(duplicateOf)}/duplicate`, { body: { newId, ...(newLabel === undefined ? {} : { newLabel }) }, dryRun: dryRun === true });
        return answer.ok ? json({ created: dryRun !== true, id: newId, etag: answer.etag, uiPath: `/cables/${newId}`, ...(dryRun === true ? { preview: preview(answer.body) } : {}) }) : refused(answer, `duplicating ${duplicateOf}`);
      }
      if (design === undefined) return { isError: true, content: [{ type: 'text', text: 'Send a design, or duplicateOf + newId.' }] };
      const answer = await api.call('POST', '/api/designs', { body: design, dryRun: dryRun === true });
      if (!answer.ok) return refused(answer, 'creating a design');
      const id = String(design['id']);
      return json({ created: dryRun !== true, id, etag: answer.etag, uiPath: `/cables/${id}`, ...(dryRun === true ? { preview: preview(answer.body) } : {}) });
    },
  );

  server.registerTool(
    'update_design',
    {
      title: 'Update a design',
      description: 'Change a working design: a JSON merge patch (RFC 7396: objects merge, null removes, arrays replace whole) or the whole document. Quote the etag from get_design; a stale one is refused (409). Use dryRun to see the patch and diff first.',
      inputSchema: z.object({
        id: designId,
        ifMatch: etagSchema,
        merge: z.record(z.string(), z.unknown()).optional().describe('RFC 7396 merge patch applied to the design you read.'),
        design: z.record(z.string(), z.unknown()).optional().describe('Or the whole replacement document.'),
        dryRun: dryRunSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, ifMatch, merge, design, dryRun }) => {
      if ((merge === undefined) === (design === undefined)) return { isError: true, content: [{ type: 'text', text: 'Send either merge or design.' }] };
      let next: unknown = design;
      if (merge !== undefined) {
        const current = await api.call('GET', `/api/designs/${encodeURIComponent(id)}`);
        if (!current.ok) return refused(current, `reading design ${id}`);
        // the patch applies to what you read: if the stored copy has moved on, the If-Match below says so
        if (current.etag !== ifMatch) return refused({ ...current, status: 409, body: { error: `Design '${id}' changed since you read it (etag ${ifMatch}; now ${current.etag ?? 'unknown'}).`, hint: 'Nothing was written. Read it again.' } }, `updating design ${id}`);
        next = mergePatch(current.body, merge);
      }
      const answer = await api.call('PUT', `/api/designs/${encodeURIComponent(id)}`, { body: next, ifMatch, dryRun: dryRun === true });
      if (!answer.ok) return refused(answer, `updating design ${id}`);
      return json(dryRun === true ? { written: false, preview: preview(answer.body) } : { written: true, id, etag: answer.etag, uiPath: `/cables/${id}` });
    },
  );

  server.registerTool(
    'save_library_item',
    {
      title: 'Create or update a library item',
      description: 'Create a library record (no ifMatch) or replace one (quote its etag as ifMatch). The whole library is checked against the change first. Records an installed pack ships are read-only: fork them.',
      inputSchema: z.object({
        kind: z.enum(DEFINITION_KINDS),
        item: z.record(z.string(), z.unknown()).describe('The whole record; it needs "id" and a "src" citation.'),
        ifMatch: etagSchema.optional(),
        dryRun: dryRunSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ kind, item, ifMatch, dryRun }) => {
      const id = String(item['id'] ?? '');
      const answer =
        ifMatch === undefined
          ? await api.call('POST', `/api/definitions/${kind}`, { body: item, dryRun: dryRun === true })
          : await api.call('PUT', `/api/definitions/${kind}/${encodeURIComponent(id)}`, { body: item, ifMatch, dryRun: dryRun === true });
      if (!answer.ok) return refused(answer, `${ifMatch === undefined ? 'creating' : 'updating'} ${kind}/${id}`);
      return json(dryRun === true ? { written: false, preview: preview(answer.body) } : { written: true, kind, id, etag: answer.etag, uiPath: `/library/${kind}/${id}` });
    },
  );

  server.registerTool(
    'validate_design',
    {
      title: 'Check a design',
      description: 'Run the design checks: on the stored design (id), or on a candidate document without saving it (design). Returns errors and warnings with where they are.',
      inputSchema: z.object({ id: designId, design: z.record(z.string(), z.unknown()).optional().describe('A candidate to check instead of the stored copy (needs the stored etag as ifMatch).'), ifMatch: etagSchema.optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, design, ifMatch }) => {
      if (design === undefined) {
        const answer = await api.call('GET', `/api/designs/${encodeURIComponent(id)}/issues`);
        return answer.ok ? json(answer.body) : refused(answer, `checking design ${id}`);
      }
      // a candidate: the save's own validation, in a dry run (nothing written, no budget spent)
      const answer = await api.call('PUT', `/api/designs/${encodeURIComponent(id)}`, { body: design, ...(ifMatch === undefined ? {} : { ifMatch }), dryRun: true });
      if (answer.ok) return json({ id, errors: 0, saveable: true, preview: preview(answer.body) });
      if (answer.status === 422) return json({ id, saveable: false, ...((answer.body ?? {}) as object) });
      return refused(answer, `checking a candidate for ${id}`);
    },
  );

  server.registerTool(
    'list_documents',
    {
      title: 'List document kinds',
      description: 'The documents a design renders (and their formats) and the export files.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const answer = await api.call('GET', '/api/exports');
      return answer.ok ? json(answer.body) : refused(answer, 'listing documents');
    },
  );

  server.registerTool(
    'generate_document',
    {
      title: 'Generate a document',
      description: 'Render one document of a design (schematic, build-sheet, bom, test-spec, drawing, labels, formboard) as the editor would download it. Text formats (svg, html, csv) come back inline; pdf/png come back as an embedded resource when small.',
      inputSchema: z.object({
        id: designId,
        kind: z.string().min(1),
        format: z.enum(['html', 'svg', 'pdf', 'csv', 'png', 'lbx']).optional(),
        rev: z.string().optional().describe('A saved revision, or "latest"; default the working copy.'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, kind, format, rev }) => {
      const query = new URLSearchParams();
      if (format !== undefined) query.set('format', format);
      if (rev !== undefined) query.set('rev', rev);
      const path = `/api/designs/${encodeURIComponent(id)}/documents/${encodeURIComponent(kind)}${query.size > 0 ? `?${query}` : ''}`;
      const answer = await api.call('GET', path);
      if (!answer.ok) return refused(answer, `rendering ${kind} of ${id}`);
      const mimeType = answer.contentType.split(';')[0] ?? 'application/octet-stream';
      const uri = `wirehub://designs/${id}/documents/${kind}${format === undefined ? '' : `.${format}`}`;
      const bytes = answer.bytes ?? new TextEncoder().encode(JSON.stringify(answer.body));
      const textual = /^(text\/|image\/svg|application\/(json|xml))/.test(mimeType);
      if (textual) {
        const text = new TextDecoder().decode(bytes);
        const cut = text.length > MAX_TEXT;
        return {
          content: [
            { type: 'text', text: JSON.stringify({ id, kind, mimeType, bytes: bytes.byteLength, path, ...(cut ? { truncated: true, hint: `Fetch ${path} with the same token for the whole file.` } : {}) }) },
            { type: 'resource', resource: { uri, mimeType, text: cut ? text.slice(0, MAX_TEXT) : text } },
          ],
        };
      }
      if (bytes.byteLength > MAX_BLOB) return json({ id, kind, mimeType, bytes: bytes.byteLength, path, hint: `Too big to inline: fetch ${path} with the same token.` });
      return {
        content: [
          { type: 'text', text: JSON.stringify({ id, kind, mimeType, bytes: bytes.byteLength, path }) },
          { type: 'resource', resource: { uri, mimeType, blob: Buffer.from(bytes).toString('base64') } },
        ],
      };
    },
  );

  server.registerTool(
    'apply_batch',
    {
      title: 'Apply several writes as one change',
      description: 'Several JSON write requests (method, path, ifMatch, body) through the same routes, as ONE change set: all commit or none. A later request sees the earlier ones. Use dryRun to preview.',
      inputSchema: z.object({
        message: z.string().min(1).max(200).describe('What the change is, for History.'),
        requests: z.array(z.object({ method: z.enum(['POST', 'PUT', 'PATCH']), path: z.string().startsWith('/api/'), ifMatch: z.string().optional(), body: z.unknown().optional() })).min(1).max(200),
        dryRun: dryRunSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ message, requests, dryRun }) => {
      const answer = await api.call('POST', '/api/batch', { body: { message, dryRun: dryRun === true, requests } });
      return answer.ok ? json(answer.body) : refused(answer, 'applying a batch');
    },
  );

  server.registerTool(
    'list_jobs',
    {
      title: 'List jobs',
      description: 'Recent background jobs (imports, model builds, derive runs, tool runs) with their state, and the worker heartbeat.',
      inputSchema: z.object({ kind: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ kind, limit }) => {
      const query = new URLSearchParams();
      if (kind !== undefined) query.set('kind', kind);
      if (limit !== undefined) query.set('limit', String(limit));
      const answer = await api.call('GET', `/api/jobs${query.size > 0 ? `?${query}` : ''}`);
      return answer.ok ? json(answer.body) : refused(answer, 'listing jobs');
    },
  );

  server.registerTool(
    'get_job',
    {
      title: 'Inspect a job',
      description: 'One job: state, timings, result summary or error, and an import\'s planned files.',
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const answer = await api.call('GET', `/api/jobs/${id}`);
      return answer.ok ? json(answer.body) : refused(answer, `reading job ${id}`);
    },
  );

  server.registerTool(
    'submit_job',
    {
      title: 'Start a job',
      description: 'Start a background job of a kind a person may start by hand (list_jobs shows the hub\'s kinds). Returns the queued job; poll get_job.',
      inputSchema: z.object({ kind: z.string().min(1), params: z.record(z.string(), z.unknown()).optional() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ kind, params }) => {
      const answer = await api.call('POST', '/api/jobs', { body: { ...(params ?? {}), kind } });
      return answer.ok ? json(answer.body) : refused(answer, `starting a ${kind} job`);
    },
  );

  server.registerTool(
    'cancel_job',
    {
      title: 'Cancel a job',
      description: 'Ask a queued or running job to stop.',
      inputSchema: z.object({ id: z.string().uuid() }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const answer = await api.call('POST', `/api/jobs/${id}/cancel`, { body: {} });
      if (answer.status === 404 || answer.status === 405) {
        const body = (answer.body ?? {}) as { error?: string };
        // an unknown job and a hub without cancellation answer alike from the job router
        if (!/no job/i.test(body.error ?? '')) return { isError: true, content: [{ type: 'text', text: 'This hub cannot cancel jobs yet; the job runs to its end.' }] };
      }
      return answer.ok ? json(answer.body) : refused(answer, `cancelling job ${id}`);
    },
  );

  const endSchema = z.object({ device: z.string().min(1).describe('A device profile id (library devices).'), port: z.string().optional().describe('One of its ports; default its only or first one.') });
  const requirementSchema = z
    .union([
      z.object({
        kind: z.literal('connect'),
        source: endSchema,
        destination: endSchema,
        signals: z.array(z.string()).optional().describe('Signal vocabulary ids the connection must carry.'),
        lengthMm: z.number().positive().optional(),
        boards: z.boolean().optional().describe('Consider adapter boards (default true).'),
      }),
      z.object({
        kind: z.literal('enclose'),
        board: z.string().min(1).describe('A board (pcbas) id.'),
        ports: z.array(z.string()).optional().describe('Board ports that need an opening.'),
        firmware: z.boolean().optional().describe('The board needs firmware.'),
      }),
    ])
    .describe('What is needed: connect two devices, or enclose a board.');
  const overridesSchema = z
    .array(z.object({ kind: z.enum(['exclude', 'prefer', 'include', 'assume']), target: z.string().min(1), reason: z.string().optional() }))
    .optional()
    .describe('Decisions to apply instead of the saved ones: exclude/prefer option:|stock:|plug:source:|plug:destination:|firmware:|target:|preset:|combo:<id>, include stock:<id>, assume fact:<key>.');

  server.registerTool(
    'explore',
    {
      title: 'Explore solutions',
      description: 'The combinations of what the library already has that meet a requirement, ranked: each valid, invalid (with reasons) or unknown (with the facts nobody stated), with its choices, facts, BOM size and inventory shortages. The saved decisions for that requirement apply unless overrides are sent. Writes nothing.',
      inputSchema: z.object({
        requirement: requirementSchema,
        overrides: overridesSchema,
        verdict: z.enum(['valid', 'invalid', 'unknown']).optional().describe('Only combinations with this verdict.'),
        limit: z.number().int().min(1).max(48).optional().describe('At most this many combinations (default 10).'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ requirement, overrides, verdict, limit }) => {
      const answer = await api.call('POST', '/api/explore/run', { body: { requirement, ...(overrides === undefined ? {} : { overrides }) } });
      if (!answer.ok) return refused(answer, 'exploring');
      const exploration = ((answer.body ?? {}) as { exploration?: Record<string, unknown> }).exploration ?? {};
      const combos = ((exploration['combos'] ?? []) as Record<string, unknown>[]).filter((c) => verdict === undefined || (c['verdict'] === verdict && c['excluded'] === undefined));
      const max = limit ?? 10;
      return json({
        key: exploration['key'],
        counts: exploration['counts'],
        ...(Array.isArray(exploration['problems']) && exploration['problems'].length > 0 ? { problems: exploration['problems'] } : {}),
        ...(Array.isArray(exploration['stale']) && exploration['stale'].length > 0 ? { staleDecisions: exploration['stale'] } : {}),
        combos: combos.slice(0, max).map((c) => ({
          rank: c['rank'],
          id: c['id'],
          verdict: c['verdict'],
          ...(c['preferred'] === true ? { preferred: true } : {}),
          ...(c['excluded'] === undefined ? {} : { excluded: c['excluded'] }),
          choices: ((c['choices'] ?? []) as { dim: string; id: string; label: string }[]).map((x) => `${x.dim}: ${x.label} (${x.id})`),
          ...(((c['reasons'] ?? []) as unknown[]).length > 0 ? { reasons: c['reasons'] } : {}),
          ...(((c['unknowns'] ?? []) as unknown[]).length > 0 ? { unknowns: c['unknowns'] } : {}),
          ...(((c['assumed'] ?? []) as unknown[]).length > 0 ? { assumed: c['assumed'] } : {}),
          ...(((c['warnings'] ?? []) as unknown[]).length > 0 ? { warnings: c['warnings'] } : {}),
          facts: c['facts'],
          bomLines: ((c['bom'] ?? []) as unknown[]).length,
          ...(typeof c['short'] === 'number' && c['short'] > 0 ? { shortLines: c['short'] } : {}),
          pickable: c['pick'] !== undefined || c['enclosure'] !== undefined,
        })),
        ...(combos.length > max ? { truncated: combos.length - max } : {}),
        ...(typeof exploration['more'] === 'number' && exploration['more'] > 0 ? { morePastEngineLimit: exploration['more'] } : {}),
        uiPath: '/explore',
      });
    },
  );

  server.registerTool(
    'explore_pick',
    {
      title: 'Use an explored combination',
      description: 'Turn one combination from explore into a working draft — a cable design (connect) or a shell part (enclose) — and record the pick on the saved exploration, as one change set. An invalid or unknown combination becomes a draft with findings to fix. Use dryRun to preview.',
      inputSchema: z.object({
        requirement: requirementSchema,
        combo: z.string().min(1).describe('The combination id from explore.'),
        overrides: overridesSchema,
        id: z.string().min(1).max(120).optional().describe('The new record id (default derived from the combination).'),
        label: z.string().max(200).optional(),
        dryRun: dryRunSchema,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ requirement, combo, overrides, id, label, dryRun }) => {
      const answer = await api.call('POST', '/api/explore/pick', {
        body: { requirement, combo, ...(overrides === undefined ? {} : { overrides }), ...(id === undefined ? {} : { id }), ...(label === undefined ? {} : { label }) },
        dryRun: dryRun === true,
      });
      if (!answer.ok) return refused(answer, `using combination ${combo}`);
      if (dryRun === true) return json({ written: false, preview: preview(answer.body) });
      const body = (answer.body ?? {}) as { picked?: { kind: string; id: string }; uiPath?: string; combo?: unknown };
      return json({ written: true, picked: body.picked, combo: body.combo, etag: answer.etag, uiPath: body.uiPath });
    },
  );

  server.registerResource('guide', 'wirehub://guide', { title: 'How to use WireHub over MCP', mimeType: 'text/plain' }, (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'text/plain', text: GUIDE }],
  }));

  server.registerResource(
    'design',
    new ResourceTemplate('wirehub://designs/{id}', { list: undefined }),
    { title: 'A design document', mimeType: 'application/json' },
    async (uri, variables) => {
      const id = String(variables['id'] ?? '');
      const answer = await api.call('GET', `/api/designs/${encodeURIComponent(id)}`);
      if (!answer.ok) throw new Error(`Design ${id}: ${String(((answer.body ?? {}) as { error?: string }).error ?? answer.status)}`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(answer.body, null, 2) }] };
    },
  );

  return server;
}

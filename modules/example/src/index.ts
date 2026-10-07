/**
 * The example module — one contribution to every extension point
 * (`docs/modules.md`). It exists to be read, copied and tested: it does
 * nothing a shop needs. **Not for production**, and not offered at first-run
 * setup unless the deployment's manifest lists it, which the studio does only
 * when the dev flag `WIREHUB_EXAMPLE_MODULE=1` is set (`apps/studio/modules.config.ts`).
 *
 * | extension point    | what the example does                                         |
 * | ------------------ | ------------------------------------------------------------- |
 * | setup (domain)     | offered at /setup, labelled as an example                     |
 * | catalog pack       | one synthetic signal                                          |
 * | part-number scheme | `EXC-00001`-style numbers (a deployment gets one scheme only) |
 * | validation rule    | refuses a save whose label says TODO                         |
 * | importer           | `id,label,value` CSV lines to proposed resistors              |
 * | exporter           | a design's joints as CSV                                      |
 * | integration        | `GET status`, `POST echo` (a route that takes the write lock) |
 * | job queue          | `example:recount`, started by `POST recount`, read by `GET recount` |
 * | panels             | all four slots                                                |
 * | compare view       | Library compare for shells and hardware (`mechanicals`)       |
 * | UI route           | `/m/example/status`, with a rail icon                         |
 * | auth provider      | a demo OAuth 2 sign-in button (it does not sign anyone in)    |
 * | commit hook        | counts edits under `extensions.example`                       |
 * | documents          | `data/example/` for imported files and reports                |
 * | derived records    | `data/derived/example/summary.{json,md}`                      |
 * | bench work steps   | data rules (`standard-work.json`) and a code `qa` provider    |
 *
 * MIT; the pack's data is CC0-1.0.
 */

import { prefixPartNumberScheme, type BenchStepRule } from '@wirehub/model';
import { defineModule, type ContinuityData } from '@wirehub/modules';

import { deriveSummary, importResistors, jointsCsv, MODULE_ID, recordEdit, recountCatalog, testerNetlist, todoLabelRule } from './logic.ts';
import standardWork from './standard-work.json' with { type: 'json' };
import { CompareView, DocumentsPanel, InspectorPanel, LibraryPanel, SettingsPanel, StatusPage } from './ui.ts';

export { dataOf, deriveSummary, importResistors, jointsCsv, recordEdit, recountCatalog, todoLabelRule } from './logic.ts';
export type { ExampleData } from './logic.ts';

/** the pack directory, as a `file:` URL (a variable so bundlers leave it alone) */
const PACK_DIR = '../pack/';
// Runtime browser entries use opaque blob URLs. Their data pack is installed
// separately, so no local pack root is contributed in that context.
export const EXAMPLE_PACK = /^(?:file|https?):/.test(import.meta.url) ? new URL(PACK_DIR, import.meta.url).href : '';

export const example = defineModule({
  id: MODULE_ID,
  label: 'Example module (reference implementation, not for production)',
  version: '0.1.0',
  license: 'MIT',
  setup: {
    kind: 'domain',
    description: 'EXAMPLE ONLY: a reference module that exercises every extension point, with one synthetic signal. Do not enable it on a real hub.',
  },
  catalogPacks: EXAMPLE_PACK === '' ? [] : [{ id: 'example', label: 'Example pack', version: '0.1.0', root: EXAMPLE_PACK, license: 'CC0-1.0' }],
  partNumberScheme: prefixPartNumberScheme({
    id: 'example',
    label: 'Example scheme (EXC-00001)',
    prefixes: { connector: 'EXC', wire: 'EXW', component: 'EXK', pcba: 'EXB', design: 'EXD' },
  }),
  validationRules: [{ id: 'todo-label', label: 'A label must not say TODO', check: todoLabelRule }],
  importers: [{ id: 'resistor-csv', label: 'Resistors (CSV)', accepts: ['.csv'], import: (input) => importResistors(input.fileName, input.bytes) }],
  exporters: [
    { id: 'joints-csv', label: 'Joints (CSV)', description: 'Every joint of the design, one row each', render: (design) => jointsCsv(design) },
    // a continuity tester's format, from the neutral continuity data the host derives (docs/exports.md)
    {
      id: 'tester-netlist',
      label: 'Tester netlist',
      description: 'Nets and isolation pairs in a made-up tester format',
      source: 'continuity',
      render: (design, _db, options) => testerNetlist(design, options?.['continuity'] as ContinuityData | undefined),
    },
  ],
  integrations: [
    {
      id: 'status',
      label: 'Example status',
      // a queue of the module's own: the worker runs it (Postgres) or this process does (files); recorded as kind `example:recount`
      queues: [{ id: 'recount', label: 'Recount the catalog', run: recountCatalog }],
      routes: [
        { method: 'GET', path: 'status', handle: async () => ({ status: 200, body: { module: MODULE_ID, ok: true } }) },
        // start a recount: 202 and the job id; poll it with GET recount?id=…
        {
          method: 'POST',
          path: 'recount',
          handle: async (request) => {
            if (request.jobs === undefined) return { status: 501, body: { error: 'This studio runs no jobs.' } };
            const only = (request.body as { only?: unknown } | undefined)?.only;
            const job = await request.jobs.enqueue('recount', typeof only === 'string' ? { only } : {});
            return { status: 202, body: { job } };
          },
        },
        {
          method: 'GET',
          path: 'recount',
          handle: async (request) => {
            const job = await request.jobs?.get(request.query.get('id') ?? '');
            return job === undefined ? { status: 404, body: { error: 'No such recount.' } } : { status: 200, body: { job } };
          },
        },
        { method: 'POST', path: 'echo', writes: true, handle: async (request) => ({ status: 200, body: { echo: request.body ?? null, by: request.user?.name ?? null } }) },
      ],
    },
  ],
  panels: [
    { id: 'inspector', label: 'Example inspector panel', slot: 'cable-inspector', component: InspectorPanel },
    { id: 'documents', label: 'Example documents panel', slot: 'cable-documents', component: DocumentsPanel },
    { id: 'library', label: 'Example library panel', slot: 'library-detail', component: LibraryPanel },
    { id: 'settings', label: 'Example settings panel', slot: 'settings', component: SettingsPanel },
  ],
  compareViews: [{ id: 'example-compare', label: 'Example compare view', kinds: ['mechanicals'], component: CompareView }],
  routes: [{ path: 'status', label: 'Example status', icon: 'IconPlug', component: StatusPage }],
  authProviders: [
    {
      id: 'example-sso',
      label: 'Example SSO (demo, does not work)',
      kind: 'oauth2',
      config: {
        name: 'Example SSO (demo)',
        authorizationUrl: 'https://idp.example.invalid/authorize',
        tokenUrl: 'https://idp.example.invalid/token',
        userInfoUrl: 'https://idp.example.invalid/userinfo',
        clientId: 'wirehub-example',
        // a real provider names its secret by environment variable: clientSecretEnv: 'ACME_SSO_SECRET'
      },
    },
  ],
  commitHook: recordEdit,
  documents: [{ path: 'data/example/', class: 'report' }],
  bench: {
    // data: steps per connector family and phase (a pack or module can ship this file without code) ...
    rules: standardWork as BenchStepRule[],
    // ... and code: the same hook with the bench facts in hand
    provider: { qa: [{ text: 'EXAMPLE ONLY: tug-test every contact.', src: 'synthetic example (CC0)', checks: ['No contact pulls out'] }] },
  },
  derived: [{ id: 'summary', label: 'Design summary', files: ['summary.json', 'summary.md'], derive: deriveSummary }],
});

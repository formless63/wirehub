/**
 * The example module's pure logic: everything here is deterministic and takes
 * data, returns data — no network, no clock — so it runs the same in the
 * browser, on the server and in tests (`docs/modules.md`, principle 3).
 */

import type { CableDesign, ComponentDefinition, Db, Issue } from '@wirehub/model';
import type { ExportOutput, ImportResult, JobQueueContext } from '@wirehub/modules';

export const MODULE_ID = 'example';

/** Rule: a design whose label still says TODO is not finished — refused at save (an error), with the code `example/todo-label`. */
export function todoLabelRule(design: CableDesign): Issue[] {
  return /\btodo\b/i.test(design.label)
    ? [{ code: 'todo-label', severity: 'error', message: `the label '${design.label}' still says TODO`, where: design.id }]
    : [];
}

/** Importer: `id,label,value` lines of a CSV become proposed resistors. A header line is skipped. */
export function importResistors(fileName: string, bytes: Uint8Array): ImportResult {
  const lines = new TextDecoder().decode(bytes).split(/\r?\n/);
  const components: ComponentDefinition[] = [];
  const notes: string[] = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || (i === 0 && line.toLowerCase().startsWith('id,'))) return;
    const [id, label, value] = line.split(',').map((cell) => cell.trim());
    if (id === undefined || label === undefined || value === undefined || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      notes.push(`line ${i + 1} is not 'id,label,value' with a kebab-case id: ${JSON.stringify(line)}`);
      return;
    }
    components.push({
      id,
      label,
      kind: 'resistor',
      category: 'resistor',
      value,
      terminals: [{ id: 'a' }, { id: 'b' }],
      src: `example importer: ${fileName} line ${i + 1} (synthetic example)`,
    } as ComponentDefinition);
  });
  if (components.length === 0) notes.push('the file has no usable lines');
  return { definitions: { components }, notes };
}

/** Exporter: the design's joints as a CSV, one `a,b,note` row per joint. */
export function jointsCsv(design: CableDesign): ExportOutput {
  const ref = (r: { instance: string; terminal: string; end?: string }): string => `${r.instance}.${r.terminal}${r.end === undefined ? '' : `@${r.end}`}`;
  const cell = (text: string): string => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const rows = ['a,b,note', ...design.joints.map((j) => [ref(j.a), ref(j.b), j.note ?? ''].map(cell).join(','))];
  return { mimeType: 'text/csv', fileName: `${design.id}-joints.csv`, body: `${rows.join('\n')}\n` };
}

/** The module's data on a design, under `extensions.example`. */
export interface ExampleData {
  schema: 1;
  /** how many edits the commit hook has seen on this design */
  edits: number;
  /** the description of the latest one */
  last: string;
}

export function dataOf(design: CableDesign): ExampleData | undefined {
  const raw = design.extensions?.[MODULE_ID] as Partial<ExampleData> | undefined;
  return raw !== undefined && raw.schema === 1 && typeof raw.edits === 'number' ? (raw as ExampleData) : undefined;
}

/** Commit hook: count the edit and remember what it was, in the design's own module data. */
export function recordEdit(before: CableDesign, proposed: CableDesign, description: string): CableDesign {
  const edits = (dataOf(before)?.edits ?? 0) + 1;
  const data: ExampleData = { schema: 1, edits, last: description };
  return { ...proposed, extensions: { ...(proposed.extensions ?? {}), [MODULE_ID]: data } };
}

/** Derived record: how the designs use the library, as the data and a short report. */
export function deriveSummary(input: { designs: readonly CableDesign[]; db: Db }): Record<string, unknown> {
  const uses = new Map<string, number>();
  for (const design of input.designs) {
    for (const c of design.instances.connectors) uses.set(c.def, (uses.get(c.def) ?? 0) + 1);
  }
  const connectors = [...uses.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([def, count]) => ({ def, count }));
  const summary = {
    src: 'derived by the example module from the stored designs',
    designs: input.designs.length,
    joints: input.designs.reduce((n, d) => n + d.joints.length, 0),
    connectors,
  };
  const lines = ['# Example summary', '', `${summary.designs} designs, ${summary.joints} joints.`, '', ...connectors.map((c) => `- ${c.def}: ${c.count}`)];
  return { 'summary.json': summary, 'summary.md': `${lines.join('\n')}\n` };
}

/**
 * Queue job: count what the catalog holds. A stand-in for work too long for a
 * request (a nightly re-index, a push to another system): it reports a step
 * per kind and returns the counts as the job's result. `request.only` limits it.
 */
export async function recountCatalog(context: JobQueueContext): Promise<Record<string, unknown>> {
  const db = await context.db();
  const only = typeof context.request['only'] === 'string' ? context.request['only'] : undefined;
  const counts: Record<string, number> = {};
  for (const kind of ['connectors', 'wires', 'components', 'pcbas', 'mechanicals'] as const) {
    if (only !== undefined && only !== kind) continue;
    const n = db[kind]?.length ?? 0;
    counts[kind] = n;
    await context.step(`${kind}: ${n}`);
  }
  return { counts };
}

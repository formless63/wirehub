/**
 * The definition endpoints.
 *
 * Same deal as `api.server.test.ts`: `handleWorkbenchRequest` is a pure
 * function, so every route is exercised with no server and no disk — the
 * definition files are arrays and the designs are a `Map`. Both are seeded from
 * the *committed catalog*, because the interesting failures here are the
 * cross-record ones, and those only exist in real data: a board that integrates
 * a connector, a design that solders to a wire's cores.
 */

import { loadDb, loadDesign, listDesignIds } from '@cable-studio/catalog';
import type {
  CableDesign,
  ConnectorBody,
  ConnectorDefinition,
  Db,
  MechanicalDefinition,
  PcbaDefinition,
  WireDefinition,
} from '@cable-studio/model';
import { beforeEach, describe, expect, it } from 'vitest';

import { handleWorkbenchRequest, type ApiError, type WorkbenchDeps } from '../server/api.ts';
import {
  fileDefinitionStore,
  formatDefinitionsJson,
  type DefinitionKind,
  type DefinitionRecord,
  type DefinitionStore,
} from '../server/definition-store.ts';
import { usageOf } from '../server/definitions.ts';
import { formatDesignJson, type DesignStore } from '../server/designs.ts';

/* ------------------------------------------------------------------ *
 * Stores with nothing behind them
 * ------------------------------------------------------------------ */

const CATALOG: Db = loadDb();

/** The hand-authored boards — the half of the board list editors own. */
const CURATED_FILE: PcbaDefinition[] = [
  'rs485-terminal-board',
].map((id) => CATALOG.pcbas.find((pcba) => pcba.id === id) as PcbaDefinition);

const GENERATED: PcbaDefinition[] = CATALOG.pcbas.filter(
  (pcba) => !CURATED_FILE.some((curated) => curated.id === pcba.id),
);

/** the store interface, answering at once (a memory store has nothing to wait for) */
type SyncDefinitionStore = { list(kind: DefinitionKind): DefinitionRecord[]; write(kind: DefinitionKind, records: DefinitionRecord[]): { changed: boolean } };

function memoryDefinitionStore(): SyncDefinitionStore & { text: Map<DefinitionKind, string> } {
  const files = new Map<DefinitionKind, DefinitionRecord[]>([
    ['connectors', structuredClone(CATALOG.connectors)],
    ['components', structuredClone(CATALOG.components)],
    ['wires', structuredClone(CATALOG.wires)],
    // curated boards only: `pcbas.generated.json` belongs to the importer
    ['pcbas', structuredClone(CURATED_FILE)],
    // the connector journey's records and the Library's shells and kits
    //
    ['bodies', structuredClone(CATALOG.bodies ?? [])],
    ['interfaces', structuredClone(CATALOG.interfaces ?? [])],
    ['mechanicals', structuredClone(CATALOG.mechanicals ?? [])],
    ['kits', structuredClone(CATALOG.kits ?? [])],
  ]);
  const text = new Map<DefinitionKind, string>();
  for (const [kind, records] of files) text.set(kind, formatDefinitionsJson(records));
  return {
    text,
    list: (kind) => structuredClone(files.get(kind) ?? []),
    write: (kind, records) => {
      const next = formatDefinitionsJson(records);
      const changed = text.get(kind) !== next;
      files.set(kind, structuredClone(records));
      text.set(kind, next);
      return { changed };
    },
  };
}

function memoryDesignStore(seed: CableDesign[]): DesignStore {
  const files = new Map<string, string>(seed.map((d) => [d.id, formatDesignJson(d)]));
  return {
    list: () =>
      [...files.keys()].sort().map((id) => ({
        id,
        label: (JSON.parse(files.get(id) as string) as CableDesign).label,
      })),
    has: (id) => files.has(id),
    read: (id) => {
      const text = files.get(id);
      return text === undefined ? undefined : (JSON.parse(text) as CableDesign);
    },
    write: (id, design) => {
      const next = formatDesignJson(design);
      const changed = files.get(id) !== next;
      files.set(id, next);
      return { changed };
    },
    remove: (id) => void files.delete(id),
  };
}

/** Designs that actually exercise the definitions under test. */
const DESIGNS = ['db9-null-modem', 'rs485-de9-terminal-board']
  .filter((id) => listDesignIds().includes(id))
  .map((id) => loadDesign(id));

let definitions: ReturnType<typeof memoryDefinitionStore>;
let deps: WorkbenchDeps;

beforeEach(async () => {
  definitions = memoryDefinitionStore();
  deps = {
    designs: memoryDesignStore(DESIGNS.map((design) => structuredClone(design))),
    definitions,
    // the library the way the real host reads it: the editable files, plus the
    // generated boards the curated file does not claim
    loadDb: (): Db => {
      const curated = definitions.list('pcbas') as PcbaDefinition[];
      const claimed = new Set(curated.map((pcba) => pcba.id));
      return {
        connectors: definitions.list('connectors') as Db['connectors'],
        components: definitions.list('components') as Db['components'],
        wires: definitions.list('wires') as Db['wires'],
        pcbas: [...curated, ...GENERATED.filter((pcba) => !claimed.has(pcba.id))],
        bodies: definitions.list('bodies') as NonNullable<Db['bodies']>,
        interfaces: definitions.list('interfaces') as NonNullable<Db['interfaces']>,
        mechanicals: definitions.list('mechanicals') as NonNullable<Db['mechanicals']>,
        kits: definitions.list('kits') as NonNullable<Db['kits']>,
        ...(CATALOG.vocab === undefined ? {} : { vocab: CATALOG.vocab }),
      };
    },
  };
});

/**
 * One request. A definition PUT with no `headers` given quotes the version on
 * disk as If-Match (an editor that loaded it just now) — the guard is
 * required; pass `{}` to send it with none.
 */
async function call(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any; headers?: Record<string, string> }> {
  if (headers === undefined && method === 'PUT' && /^\/api\/definitions\/[^/]+\/[^/]+$/.test(path)) {
    const etag = (await handleWorkbenchRequest({ method: 'GET', path }, deps)).headers?.['ETag'];
    if (etag !== undefined) headers = { 'if-match': etag };
  }
  return await handleWorkbenchRequest(
    { method, path, ...(body === undefined ? {} : { body }), ...(headers === undefined ? {} : { headers }) },
    deps,
  );
}

function stored<T extends DefinitionRecord>(kind: DefinitionKind, id: string): T | undefined {
  return definitions.list(kind).find((record) => record.id === id) as T | undefined;
}

const connector = (): ConnectorDefinition =>
  stored<ConnectorDefinition>('connectors', 'de9-female-rs232') as ConnectorDefinition;

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

describe('GET /api/definitions', () => {
  it('counts what there is to edit', async () => {
    const response = await call('GET', '/api/definitions');
    expect(response.status).toBe(200);
    expect(response.body.definitions).toEqual([
      { kind: 'connectors', label: 'connectors', count: CATALOG.connectors.length },
      { kind: 'components', label: 'components', count: CATALOG.components.length },
      { kind: 'wires', label: 'wire stocks', count: CATALOG.wires.length },
      { kind: 'pcbas', label: 'boards', count: CURATED_FILE.length },
      { kind: 'bodies', label: 'connector bodies', count: CATALOG.bodies!.length },
      { kind: 'interfaces', label: 'pinouts', count: CATALOG.interfaces!.length },
      { kind: 'mechanicals', label: 'shells and fasteners', count: CATALOG.mechanicals!.length },
      { kind: 'kits', label: 'kits', count: CATALOG.kits!.length },
    ]);
    expect(response.body.generatedPcbas).toBe(GENERATED.length);
  });

  it('is listed among the API routes', async () => {
    expect((await call('GET', '/api')).body.routes).toContain('PUT    /api/definitions/:kind/:id');
  });
});

describe('GET /api/definitions/:kind', () => {
  it('hands back the file, in file order', async () => {
    const response = await call('GET', '/api/definitions/connectors');
    expect(response.status).toBe(200);
    expect(response.body.records.map((r: { id: string }) => r.id)).toEqual(
      CATALOG.connectors.map((c) => c.id),
    );
  });

  it('shows the generated boards beside the curated ones, separately', async () => {
    const response = await call('GET', '/api/definitions/pcbas');
    expect(response.body.records).toHaveLength(CURATED_FILE.length);
    expect(response.body.generated).toHaveLength(GENERATED.length);
    expect(response.body.generated.map((p: { id: string }) => p.id)).not.toContain(
      'pca-00110-rev4',
    );
  });

  it('names the four editable files when asked for something else', async () => {
    const response = await call('GET', '/api/definitions/pcbas-generated');
    expect(response.status).toBe(404);
    expect((response.body as ApiError).hint).toContain('connectors, components, wires, pcbas');
  });
});

describe('GET /api/definitions/:kind/:id', () => {

  it('says what it could not find and where to look', async () => {
    const response = await call('GET', '/api/definitions/connectors/no-such-plug');
    expect(response.status).toBe(404);
    expect((response.body as ApiError).error).toContain("'no-such-plug'");
    expect((response.body as ApiError).hint).toContain('connectors list');
  });

  it('refuses an id that is really a path', async () => {
    expect((await call('GET', '/api/definitions/connectors/..%2f..%2fetc%2fpasswd')).status).toBe(400);
  });
});

/* ------------------------------------------------------------------ *
 * Usage — the referential check, read-only
 * ------------------------------------------------------------------ */

describe('GET /api/definitions/:kind/:id/usage', () => {

  it('answers zero for something nothing points at', async () => {
    expect((await usageOf(deps, 'components', 'r-150')).count).toBe(0);
  });

  it("reports a connector's mounting split: board-straddle vs direct-solder", async () => {
    // the terminal block reaches the RS-485 design only through the board's
    // own integratedConnectors — always board-straddle
    const block = (await call('GET', '/api/definitions/connectors/terminal-block-4/usage')).body;
    expect(block.mounting).toEqual({ straddle: 1, direct: 0 });

    // the DE-9 connectors are soldered straight to the wire (counted per design)
    const de9 = (await call('GET', '/api/definitions/connectors/de9-female-rs232/usage')).body;
    expect(de9.mounting).toEqual({ straddle: 0, direct: 1 });
  });

  it('has no mounting split for a non-connector kind', async () => {
    const usage = (await call('GET', '/api/definitions/wires/mini-coax/usage')).body;
    expect(usage.mounting).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Writing
 * ------------------------------------------------------------------ */

describe('PUT /api/definitions/:kind/:id', () => {

  it('does not hold a problem somewhere else against the edit in hand', async () => {
    // a design that was already broken before this edit: the studio must still
    // let every definition be edited, or the catalog would be frozen shut
    const broken: CableDesign = {
      ...structuredClone(DESIGNS[0] as CableDesign),
      id: 'already-broken',
      instances: {
        ...structuredClone((DESIGNS[0] as CableDesign).instances),
        connectors: [{ id: 'x1', def: 'no-such-connector' }],
      },
    };
    deps.designs.write('already-broken', broken);
    const response = await call('PUT', '/api/definitions/components/r-150', {
      ...(stored('components', 'r-150') as DefinitionRecord),
      label: '150 Ω resistor (XCLK genlock-kill pulldown), re-checked',
    });
    expect(response.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * The stale-write guard:
 * GET carries an ETag (a content hash of the record); PUT with a matching
 * `If-Match` writes normally, a stale one is refused with 409 and nothing
 * written, and PUT with no `If-Match` at all keeps the old last-write-wins
 * behaviour every other test in this file relies on.
 * ------------------------------------------------------------------ */

describe('the stale-write guard', () => {

  it('hands out every record\'s version with the kind\'s list, for an editor opened from it', async () => {
    const list = (await call('GET', '/api/definitions/connectors')).body as { etags: Record<string, string> };
    const one = (await call('GET', '/api/definitions/connectors/de9-female-rs232')).headers?.['ETag'];
    expect(list.etags['de9-female-rs232']).toBe(one);
  });
});

describe('POST /api/definitions/:kind', () => {
  const PLUG: ConnectorDefinition = {
    id: 'test-2p-header',
    label: 'Test 2-pin header',
    family: 'header',
    gender: 'male',
    pins: [
      { id: '1', label: 'Signal' },
      { id: '2', label: 'GND' },
    ],
    src: 'test fixture — invented for the definition endpoint tests',
  };

  it('appends the new record at the end of the file', async () => {
    const response = await call('POST', '/api/definitions/connectors', PLUG);
    expect(response.status).toBe(201);
    const ids = (await definitions.list('connectors')).map((record) => record.id);
    expect(ids[ids.length - 1]).toBe('test-2p-header');
    expect(ids).toHaveLength(CATALOG.connectors.length + 1);
  });

  it('insists on a family, in words a person can act on', async () => {
    const { family: _family, ...withoutFamily } = PLUG;
    const response = await call('POST', '/api/definitions/connectors', withoutFamily);
    expect(response.status).toBe(400);
    expect((response.body as ApiError).error).toContain('family');
    expect(await definitions.list('connectors')).toHaveLength(CATALOG.connectors.length);
  });

  it('refuses a pin with no number of its own', async () => {
    const response = await call('POST', '/api/definitions/connectors', {
      ...PLUG,
      pins: [{ id: '1', label: 'Signal' }, { label: 'nameless' }],
    });
    expect(response.status).toBe(400);
    expect((response.body as ApiError).error).toContain('Pin 2');
  });

  it('takes a component with polarity on its legs', async () => {
    const response = await call('POST', '/api/definitions/components', {
      id: 'cap-470uf-tant',
      label: '470 µF tantalum capacitor',
      kind: 'capacitor',
      value: '470 µF',
      terminals: [
        { id: 'a', label: '+', polarity: '+' },
        { id: 'b', label: '-', polarity: '-' },
      ],
      src: 'test fixture',
    });
    expect(response.status).toBe(201);
    expect(stored('components', 'cap-470uf-tant')).toBeDefined();
  });

  it('refuses a component kind it does not know, and lists the ones it does', async () => {
    const response = await call('POST', '/api/definitions/components', {
      id: 'thing-1',
      label: 'A thing',
      kind: 'flux-capacitor',
      terminals: [{ id: 'a' }],
      src: 'test fixture',
    });
    expect(response.status).toBe(400);
    expect((response.body as ApiError).hint).toContain('resistor, capacitor, ic, switch, other');
  });

  it('takes a wire stock and checks its lay order against its own cores', async () => {
    const body: WireDefinition = {
      id: 'test-2core',
      label: 'Test 2-core',
      structure: {
        kind: 'group',
        id: 'test-2core',
        role: 'cable',
        children: [
          { kind: 'conductor', id: 'core-a', color: 'red', odMm: 0.5, insulatedOdMm: 1.2 },
          { kind: 'conductor', id: 'core-b', color: 'black', odMm: 0.5, insulatedOdMm: 1.2 },
        ],
      },
      layOrder: {
        arrangement: '6-around-1',
        direction: 'ccw',
        ring: ['core-a', 'core-b'],
        src: 'test fixture',
      },
      src: 'test fixture',
    };
    const response = await call('POST', '/api/definitions/wires', body);
    expect(response.status).toBe(422);
    expect((response.body as ApiError).issues?.some((i) => i.code === 'lay-order-arrangement-mismatch')).toBe(
      true,
    );

    const { layOrder: _lay, ...plain } = body;
    expect((await call('POST', '/api/definitions/wires', plain)).status).toBe(201);
  });

  it('refuses a diameter written as words', async () => {
    const response = await call('POST', '/api/definitions/wires', {
      id: 'test-bad-mm',
      label: 'Test',
      structure: {
        kind: 'group',
        id: 'test-bad-mm',
        role: 'cable',
        children: [{ kind: 'conductor', id: 'core-a', odMm: '0.5 mm' }],
      },
      src: 'test fixture',
    });
    expect(response.status).toBe(400);
    expect((response.body as ApiError).hint).toContain('millimetres');
  });
});

/* ------------------------------------------------------------------ *
 * Deleting — rule 3 and rule 4
 * ------------------------------------------------------------------ */

describe('DELETE /api/definitions/:kind/:id', () => {
  it('refuses without the confirm token', async () => {
    const response = await call('DELETE', '/api/definitions/components/r-150');
    expect(response.status).toBe(400);
    expect(stored('components', 'r-150')).toBeDefined();
  });

  it('refuses a confirm token for something else', async () => {
    const response = await call('DELETE', '/api/definitions/components/r-150', { confirm: 'r-180' });
    expect(response.status).toBe(400);
    expect(stored('components', 'r-150')).toBeDefined();
  });

  it('deletes a definition nothing refers to', async () => {
    const response = await call('DELETE', '/api/definitions/components/r-150', { confirm: 'r-150' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: 'r-150', kind: 'components' });
    expect(stored('components', 'r-150')).toBeUndefined();
  });

  it('says so when there is nothing to delete', async () => {
    expect((await call('DELETE', '/api/definitions/components/r-999', { confirm: 'r-999' })).status).toBe(
      404,
    );
  });
});

/* ------------------------------------------------------------------ *
 * The router itself
 * ------------------------------------------------------------------ */

describe('the definition router', () => {
  it('says which methods an address answers', async () => {
    const response = await call('PATCH', '/api/definitions/connectors/scart-male');
    expect(response.status).toBe(405);
    expect((response.body as ApiError).hint).toContain('GET and PUT and DELETE');
  });

  it('tells a host without a definition store that it cannot edit, not that the address is wrong', async () => {
    const { definitions: _definitions, ...rest } = deps;
    deps = rest;
    const response = await call('GET', '/api/definitions/connectors');
    expect(response.status).toBe(501);
    expect((response.body as ApiError).hint).toContain('Designs can still be opened and saved');
  });

  it('leaves the design routes alone', async () => {
    expect((await call('GET', '/api/designs')).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ *
 * The file store and the body/interface split
 * ------------------------------------------------------------------ */

describe('the file store\'s connectors', () => {
  it('hands the editors composed connectors — the pins every design sees', async () => {
    expect(fileDefinitionStore().list('connectors')).toEqual(CATALOG.connectors);
  });

  it('writes nothing back for an unchanged library: each connector is still its body + interface', async () => {
    const store = fileDefinitionStore();
    expect(await store.write('connectors', await store.list('connectors'))).toEqual({ changed: false });
  });
});

/* ------------------------------------------------------------------ *
 * The connector journey's records
 * ------------------------------------------------------------------ */

describe('bodies and pinouts', () => {
  const body = {
    id: 'minidin8-male',
    label: 'Mini-DIN 8 male',
    family: 'mini-din',
    gender: 'male',
    positions: ['1', '2', '3', '4', '5', '6', '7', '8'].map((id) => ({ id })).concat([{ id: 'shell', kind: 'shell' } as never]),
    src: 'test',
  };
  const iface = {
    id: 'test-rgb',
    label: 'Test RGB',
    bodies: ['minidin8-male'],
    pins: { '1': { signal: 'video-r' }, '2': { signal: 'video-g' }, '3': { signal: 'video-b' }, '4': { signal: 'gnd' }, shell: { signal: 'gnd-chassis' } },
    src: 'test',
  };

  it('creates a body, a pinout on it and a connector that is the pair', async () => {
    expect((await call('POST', '/api/definitions/bodies', body)).status).toBe(201);
    expect((await call('POST', '/api/definitions/interfaces', iface)).status).toBe(201);
    const pins = ['1', '2', '3', '4', 'shell'].map((id) => ({ id, label: id, signal: (iface.pins as Record<string, { signal: string }>)[id]!.signal }));
    const connector = { id: 'test-md8', label: 'Test MD8', family: 'Mini-DIN', gender: 'male', body: 'minidin8-male', interface: 'test-rgb', pins, src: 'test' };
    const response = await call('POST', '/api/definitions/connectors', connector);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  });

  it('refuses a body with no gender, and a pinout with no signal', async () => {
    expect((await call('POST', '/api/definitions/bodies', { ...body, gender: undefined })).status).toBe(400);
    const bad = await call('POST', '/api/definitions/interfaces', { ...iface, pins: { '1': { label: 'R' } } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('signal');
  });

});

/* ------------------------------------------------------------------ *
 * Shells, fasteners and kits
 * ------------------------------------------------------------------ */


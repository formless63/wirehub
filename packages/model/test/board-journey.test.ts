import { describe, expect, it } from 'vitest';

import {
  buildsFileFor,
  buildsFileName,
  canonicalBuildsFile,
  conditioningFromVia,
  conductorLandings,
  exclusiveGroups,
  footprintPadMap,
  partPopulation,
  rankFootprintInterfaces,
  suggestFootprintPads,
  validateBoardBuilds,
  withPartState,
  withSettingState,
  type BoardBuilds,
  type Interface,
} from '../src/index.ts';

const demoIface: Interface = {
  id: 'demoIface-av',
  label: 'Demo AV',
  bodies: ['demoIface-av-male'],
  pins: {
    '1': { signal: 'csync', label: 'CSync' },
    '5': { signal: 'video-r' },
    '6': { signal: 'video-g' },
    '7': { signal: 'video-b' },
    shell: { signal: 'gnd-chassis' },
  },
  src: 'test',
};

const demoBoard: BoardBuilds = {
  board: 'PCA-00106',
  label: 'Demo board',
  end: 'source',
  settings: [
    { function: 'CS', ref: 'JP1', kind: 'jumper', states: ['open', 'closed'], src: 't' },
    { function: 'Y', ref: 'JP3', kind: 'jumper', states: ['open', 'closed'], src: 't' },
    { function: 'CV', ref: 'JP4', kind: 'jumper', states: ['open', 'closed'], src: 't' },
  ],
  exclusive: [['CV', 'Y', 'CS']],
  builds: [{ key: 'csync', build: 'CSync', settings: { CS: 'closed', Y: 'open', CV: 'open' }, bridged: ['JP1'], omitted: ['JP3', 'JP4'], src: 't' }],
};

describe('build files', () => {
  it('names a file by board and revision', () => {
    expect(buildsFileName({ board: 'PCA-00107' })).toBe('pca-00107');
    expect(buildsFileName({ board: 'PCA-00108', revision: 'Rev5' })).toBe('pca-00108-rev5');
  });
  it('prefers the revision file', () => {
    const files = [{ board: 'X' }, { board: 'X', revision: 'Rev5' }];
    expect(buildsFileFor(files, 'X', 'Rev5')).toBe(files[1]);
    expect(buildsFileFor(files, 'X', 'Rev4')).toBe(files[0]);
    expect(buildsFileFor(files, 'Y', 'Rev4')).toBeUndefined();
  });
});

describe('footprintPadMap', () => {
  it('lands pads by number and flags a position the interface lacks', () => {
    const map = footprintPadMap({ prefix: 'j' }, demoIface, ['j.1', 'j.5', 'j.9', 'R'], { 'j.1': 'csync', 'j.5': 'video-g' });
    expect(map.rows.map((r) => [r.terminal, r.position, r.status])).toEqual([
      ['j.1', '1', 'ok'],
      ['j.5', '5', 'signal-mismatch'],
      ['j.9', undefined, 'unknown-position'],
    ]);
    expect(map.mismatches).toBe(2);
    expect(map.unlanded).toEqual(['6', '7', 'shell']);
  });
  it('lets grounds of any flavour agree when it has the signals list', () => {
    const vocab = { signals: { id: 'signals', label: 'Signals', src: 't', entries: [
      { id: 'gnd', label: 'GND', kind: 'ground', src: 't' },
      { id: 'gnd-chassis', label: 'Shell', kind: 'ground', src: 't' },
      { id: 'csync', label: 'CSync', kind: 'sync', src: 't' },
    ] } } as never;
    const tags = { 'j.shell': 'gnd' };
    expect(footprintPadMap({ prefix: 'j' }, demoIface, ['j.shell'], tags).rows[0]?.status).toBe('signal-mismatch');
    expect(footprintPadMap({ prefix: 'j' }, demoIface, ['j.shell'], tags, vocab).rows[0]?.status).toBe('ok');
  });
  it('reads a pad that takes the carrier T-join and a wire as a double landing, not a mismatch', () => {
    const pce: Interface = {
      id: 'pce',
      label: 'PCE',
      bodies: [],
      pins: { '4': { signal: 'blanking', label: 'RGB blanking (+V)' }, '7': { signal: 'video-r' } },
      src: 't',
    };
    const vocab = { signals: { id: 'signals', label: 'Signals', entries: [
      { id: 'blanking', label: 'Blanking', kind: 'control' },
      { id: 'pwr-5v', label: '+5 V', kind: 'power' },
      { id: 'video-r', label: 'R', kind: 'video' },
    ] } } as never;
    const def = {
      terminals: [{ id: 'jp.4' }, { id: 'jp.7' }, { id: '5V' }, { id: 'R' }],
      internalLinks: [
        { from: 'jp.4', to: '5V' },
        { from: 'jp.7', to: 'R' },
      ],
    };
    const tags: Record<string, { role?: string; signal?: string }> = {
      'jp.4': { signal: 'pwr-5v' },
      'jp.7': { signal: 'pwr-5v' },
      '5V': { role: 'power', signal: 'pwr-5v' },
      R: { role: 'red', signal: 'video-r' },
    };
    const landings = conductorLandings(def, (t) => tags[t] ?? {});
    expect(landings['jp.4']).toEqual({ pad: '5V', signal: 'pwr-5v' });
    const signals = { 'jp.4': 'pwr-5v', 'jp.7': 'pwr-5v' };
    const carrier = { pcba: 'PCA-00109-rev3', prefix: 'j1', pads: 'jp', src: 't' };
    const map = footprintPadMap({ prefix: 'jp', carrier }, pce, ['jp.4', 'jp.7'], signals, vocab, { landings });
    const row = (t: string) => map.rows.find((r) => r.terminal === t)!;
    expect(row('jp.4').status).toBe('dual-landing');
    expect(row('jp.4').landing).toBe('5V');
    // a video position is never a double landing, whatever lands beside it
    expect(row('jp.7').status).toBe('signal-mismatch');
    expect(map.mismatches).toBe(1);
    // without a carrier there is no T-join: the rule does not apply
    expect(footprintPadMap({ prefix: 'jp' }, pce, ['jp.4'], signals, vocab, { landings }).rows[0]?.status).toBe('signal-mismatch');
  });
  it('uses the footprint pad map, then a unique signal', () => {
    const map = footprintPadMap({ prefix: 'j', pads: { GND: 'shell' } }, demoIface, ['j.GND', 'j.R'], { 'j.R': 'video-r' });
    expect(map.rows.map((r) => [r.terminal, r.position, r.by])).toEqual([
      ['j.GND', 'shell', 'map'],
      ['j.R', '5', 'signal'],
    ]);
  });
  it('suggests a mirrored pad map when the socket numbers the other way', () => {
    const multi: Interface = {
      id: 'ps',
      label: 'PS',
      bodies: [],
      pins: { '1': { signal: 'video-g' }, '2': { signal: 'video-r' }, '3': { signal: 'pwr-5v' }, '4': { signal: 'gnd' } },
      src: 't',
    };
    const tags = { 'j.1': 'gnd', 'j.2': 'pwr-5v', 'j.3': 'video-r', 'j.4': 'video-g' };
    const s = suggestFootprintPads({ prefix: 'j' }, multi, Object.keys(tags), tags);
    expect(s).toEqual({ pads: { '1': '4', '2': '3', '3': '2', '4': '1' }, ok: 4, of: 4, mirrored: true });
    expect(footprintPadMap({ prefix: 'j', pads: s.pads }, multi, Object.keys(tags), tags).mismatches).toBe(0);
    // numbered as-is: nothing to map
    expect(suggestFootprintPads({ prefix: 'j' }, demoIface, ['j.1', 'j.5'], { 'j.1': 'csync', 'j.5': 'video-r' }).pads).toEqual({});
  });
  it('ranks the interface that fits first', () => {
    const other: Interface = { ...demoIface, id: 'other', pins: { '2': { signal: 'gnd' } } };
    const ranked = rankFootprintInterfaces({ prefix: 'j' }, [other, demoIface], ['j.1', 'j.5'], { 'j.1': 'csync' });
    expect(ranked[0]?.iface.id).toBe('demoIface-av');
  });
});

describe('settings and population', () => {
  it('reports each exclusive group live', () => {
    const build = demoBoard.builds[0]!;
    expect(exclusiveGroups(demoBoard, build)).toEqual([{ group: ['CV', 'Y', 'CS'], closed: ['CS'], ok: true }]);
    const two = withSettingState(demoBoard, build, 'Y', 'closed');
    expect(exclusiveGroups(demoBoard, two)[0]).toMatchObject({ closed: ['Y', 'CS'], ok: false });
    // the validator agrees, and the population stays in step with the settings
    const issues = validateBoardBuilds([{ ...demoBoard, builds: [two] }], { pcbas: [] });
    expect(issues.map((i) => i.code)).toEqual(['build-exclusive']);
    // closing Y and opening it again is no change at all
    expect(withSettingState(demoBoard, two, 'Y', 'open')).toEqual(build);
    const fixed = withSettingState(demoBoard, two, 'CS', 'open');
    expect(validateBoardBuilds([{ ...demoBoard, builds: [fixed] }], { pcbas: [] })).toEqual([]);
  });
  it('lists parts with their state and controlling setting', () => {
    const build = withPartState(demoBoard.builds[0]!, 'R5', 'omitted');
    const parts = partPopulation(demoBoard, build, ['R2', 'R5', 'JP1']);
    expect(parts.map((p) => [p.ref, p.state, p.setting?.function])).toEqual([
      ['JP1', 'bridged', 'CS'],
      ['JP3', 'omitted', 'Y'],
      ['JP4', 'omitted', 'CV'],
      ['R2', 'fitted', undefined],
      ['R5', 'omitted', undefined],
    ]);
    expect(withPartState(build, 'R5', 'fitted').omitted).toEqual(['JP3', 'JP4']);
  });
});

describe('conditioningFromVia', () => {
  it('suggests the base conditioning the words name', () => {
    expect(conditioningFromVia('R1 470 Ω')).toEqual(['series-resistor']);
    expect(conditioningFromVia('R4 470 Ω → C4 220 µF')).toEqual(['series-resistor', 'ac-coupling']);
    expect(conditioningFromVia('R1 120 Ω termination via JP1')).toEqual(['termination']);
    expect(conditioningFromVia('U1 buffer')).toEqual(['buffer']);
    expect(conditioningFromVia('U1 LM1881')).toEqual([]);
    expect(conditioningFromVia(undefined)).toEqual([]);
  });
});

describe('canonicalBuildsFile', () => {
  it('puts keys back in the committed order and drops undefined', () => {
    const messy = {
      builds: [{ src: 's', settings: { CS: 'closed' }, key: 'k', build: 'b', bridged: ['JP1'], note: undefined }],
      end: 'source',
      label: 'L',
      board: 'X',
    } as unknown as BoardBuilds;
    expect(JSON.stringify(canonicalBuildsFile(messy))).toBe(
      JSON.stringify({ board: 'X', label: 'L', end: 'source', builds: [{ key: 'k', build: 'b', bridged: ['JP1'], src: 's', settings: { CS: 'closed' } }] }),
    );
  });
});

/**
 * Board and adapter proposals (`docs/resolver.md`, "Proposals"): when the resolver finds no
 * complete way to connect two devices, each missing piece it can name becomes a **draft** — the
 * pads a board or adapter would need, the parts known recipes would put on it, how they join, and
 * what nobody has stated yet (`open`). A proposal is advice: people review it, decline it with a
 * reason (the hub remembers, so it is not offered again) or accept it, which starts a development
 * PCBA from it. Other sources (a board importer, a module, the API) can file proposals of the same
 * shape.
 *
 * Pure and deterministic.
 */

import type { ResolverLibrary } from './devices.ts';
import type { PcbaDefinition } from './model.ts';
import { componentForPart } from './derive-cable.ts';
import type { End, Finding, Resolution } from './resolve.ts';
import { vocabEntry } from './vocab.ts';

export interface ProposedPart {
  /** `R1`, `U1` */
  ref: string;
  kind: string;
  value?: string;
  /** the library component it would be */
  component?: string;
  /** the recipe it comes from */
  for?: string;
}

/** One net: pads (`IN`, `GND`) and part pins (`R1.a`, `U1.in`). */
export interface ProposedNet {
  id: string;
  nodes: string[];
}

export interface BoardProposal {
  /** stable identity: what a decision is recorded against */
  key: string;
  kind: 'draft' | 'build';
  title: string;
  /** which end of the cable it would sit at */
  end?: End;
  /** the query that raised it */
  for?: { source: { device: string; port?: string }; destination: { device: string; port?: string } };
  pads: { id: string; label?: string; signal?: string; level?: string }[];
  parts: ProposedPart[];
  nets: ProposedNet[];
  /** what the proposal needs that no recipe or record states */
  open: string[];
  /** what raised it */
  gap?: { code: string; message: string };
  src: string;
}

export type ProposalState = 'open' | 'declined' | 'accepted';

/** A decision on a proposal (`data/proposals.json`), with the proposal as it was. */
export interface ProposalDecision {
  key: string;
  state: ProposalState;
  reason?: string;
  by?: string;
  at: string;
  /** the PCBA an accepted proposal became */
  pcba?: string;
  proposal: BoardProposal;
}

function conditioningLabel(lib: ResolverLibrary, id: string): string {
  return vocabEntry(lib.vocab, 'conditioning', id)?.label ?? id;
}

/** `source:3` → `S3`, `destination:shell` → `DSHELL`: a pad name for a port position. */
const padOf = (at: string): string => {
  const [end, pos] = at.split(':') as [string, string];
  return `${end === 'source' ? 'S' : 'D'}${pos.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
};

function draft(lib: ResolverLibrary, resolution: Resolution, finding: Finding, index: number): BoardProposal | undefined {
  const q = resolution.query;
  const pair = `${q.source.device}${q.source.port === undefined ? '' : `.${q.source.port}`} → ${q.destination.device}${q.destination.port === undefined ? '' : `.${q.destination.port}`}`;
  const base = { kind: 'draft' as const, for: { source: q.source, destination: q.destination }, gap: { code: finding.code, message: finding.message }, src: `proposed by the resolver for ${pair}` };
  const key = (what: string): string => `${pair}: ${finding.code}: ${what}`;
  const at = finding.at ?? [];
  const pins = (where: string) => {
    const [end, pos] = where.split(':') as [End, string];
    const bound = (end === 'source' ? resolution.source : resolution.destination)?.pins.find((p) => p.position === pos);
    return { id: padOf(where), label: `${end} ${pos}${bound?.label === undefined ? '' : ` (${bound.label})`}`, ...(bound?.signal === undefined ? {} : { signal: bound.signal }), ...(bound?.level === undefined ? {} : { level: bound.level }) };
  };
  switch (finding.code) {
    case 'level-unconverted': {
      const [inPad, outPad] = at.map(pins);
      if (inPad === undefined || outPad === undefined) return undefined;
      return {
        ...base,
        key: key(`${inPad.signal}@${inPad.level ?? '?'} → ${outPad.level ?? '?'}`),
        title: `Level converter: ${inPad.signal ?? 'the line'} from ${inPad.level ?? 'its level'} to ${outPad.level ?? 'the input\'s level'}`,
        end: 'destination',
        pads: [{ ...inPad, id: 'IN' }, { ...outPad, id: 'OUT' }, { id: 'GND', label: 'ground' }],
        parts: [{ ref: 'U1', kind: 'ic', value: `${inPad.level ?? '?'} → ${outPad.level ?? '?'} converter` }],
        nets: [
          { id: 'IN', nodes: ['IN', 'U1.in'] },
          { id: 'OUT', nodes: ['OUT', 'U1.out'] },
          { id: 'GND', nodes: ['GND', 'U1.gnd'] },
        ],
        open: [`a circuit that takes ${inPad.level ?? 'the driver\'s level'} and gives ${outPad.level ?? 'the receiver\'s level'} (no recipe in the library converts it)`],
      };
    }
    case 'supply-missing': {
      const pad = at.map(pins)[0];
      if (pad === undefined) return undefined;
      const offered = (resolution.source?.pins ?? []).filter((p) => p.class === 'power' && p.dir !== 'in').map((p) => p.signal).filter((s): s is string => s !== undefined);
      return {
        ...base,
        key: key(`${pad.signal ?? 'supply'} from ${offered.join('+') || 'none'}`),
        title: `Supply for ${pad.label}: ${pad.signal ?? 'a rail'}${offered.length === 0 ? '' : ` from ${offered.join(' or ')}`}`,
        end: 'destination',
        pads: [{ id: 'VIN', label: offered.length === 0 ? 'an outside supply' : offered.join(' or '), ...(offered[0] === undefined ? {} : { signal: offered[0] }) }, { ...pad, id: 'VOUT' }, { id: 'GND', label: 'ground' }],
        parts: [{ ref: 'U1', kind: 'ic', value: 'regulator' }],
        nets: [
          { id: 'VIN', nodes: ['VIN', 'U1.in'] },
          { id: 'VOUT', nodes: ['VOUT', 'U1.out'] },
          { id: 'GND', nodes: ['GND', 'U1.gnd'] },
        ],
        open: [offered.length === 0 ? `where ${pad.signal ?? 'the supply'} comes from: the other end offers none` : `a regulator from ${offered.join(' or ')} to ${pad.signal ?? 'the rail'}`],
      };
    }
    case 'need-unmet':
    case 'requirement-unmet': {
      const conditioning = /needs ([a-z0-9-]+)/.exec(finding.message)?.[1];
      const pads = at.map(pins);
      if (pads.length === 0) return undefined;
      const what = conditioning === undefined ? 'the conditioning' : conditioningLabel(lib, conditioning);
      const parts: ProposedPart[] = [{ ref: 'X1', kind: 'other', value: what }];
      return {
        ...base,
        key: key(`${conditioning ?? 'conditioning'} on ${pads.map((p) => p.id).join('+')}`),
        title: `${what} on ${pads.map((p) => p.label ?? p.id).join(' and ')}`,
        end: at[0]?.startsWith('source') ? 'source' : 'destination',
        pads: [...pads, { id: 'GND', label: 'ground' }],
        parts,
        nets: pads.map((p, i) => ({ id: p.id, nodes: [p.id, `X1.${i === 0 ? 'a' : 'b'}`] })),
        open: [`the parts of ${what}: no recipe in the library realises it (add one to conditioning-recipes.json, and the resolver places it itself)`],
      };
    }
    case 'nothing-paired': {
      const src = (resolution.source?.pins ?? []).filter((p) => p.class === 'signal');
      const dst = (resolution.destination?.pins ?? []).filter((p) => p.class === 'signal');
      if (src.length === 0 || dst.length === 0) return undefined;
      const sig = (list: typeof src) => [...new Set(list.map((p) => p.signal))].join(', ');
      return {
        ...base,
        key: key(`${sig(src)} ↔ ${sig(dst)}`),
        title: `Adapter between ${sig(src)} and ${sig(dst)}`,
        end: 'source',
        pads: [
          ...src.map((p) => ({ id: padOf(`source:${p.position}`), label: `source ${p.position} (${p.label})`, ...(p.signal === undefined ? {} : { signal: p.signal }), ...(p.level === undefined ? {} : { level: p.level }) })),
          ...dst.map((p) => ({ id: padOf(`destination:${p.position}`), label: `destination ${p.position} (${p.label})`, ...(p.signal === undefined ? {} : { signal: p.signal }), ...(p.level === undefined ? {} : { level: p.level }) })),
          { id: 'GND', label: 'ground' },
        ],
        parts: [{ ref: 'U1', kind: 'ic', value: 'signal converter' }],
        nets: [
          ...src.map((p) => ({ id: padOf(`source:${p.position}`), nodes: [padOf(`source:${p.position}`), `U1.a${p.position}`] })),
          ...dst.map((p) => ({ id: padOf(`destination:${p.position}`), nodes: [padOf(`destination:${p.position}`), `U1.b${p.position}`] })),
          { id: 'GND', nodes: ['GND', 'U1.gnd'] },
        ],
        open: [`a converter between ${sig(src)} and ${sig(dst)}; then describe it as an adapter device so the resolver offers it`],
      };
    }
    default:
      void index;
      return undefined;
  }
}

/**
 * The drafts for what keeps two devices from connecting: nothing when some option is complete;
 * else one per missing piece of the top-ranked option (a level nothing converts, a supply, a
 * conditioning no recipe provides, two ports that speak different signals). Known recipe parts are
 * named from the library; the rest is `open`.
 */
export function proposeBoards(lib: ResolverLibrary, resolution: Resolution): BoardProposal[] {
  if (resolution.options.some((o) => o.missing.length === 0)) return [];
  const top = resolution.options[0];
  if (top === undefined) return [];
  const out: BoardProposal[] = [];
  const seen = new Set<string>();
  top.missing.forEach((m, i) => {
    const p = draft(lib, resolution, m, i);
    if (p === undefined || seen.has(p.key)) return;
    seen.add(p.key);
    out.push(p);
  });
  return out;
}

/** The proposals still to show: those with no decision, or reopened. */
export function openProposals(proposals: readonly BoardProposal[], decisions: readonly ProposalDecision[]): BoardProposal[] {
  const decided = new Map(decisions.map((d) => [d.key, d.state]));
  return proposals.filter((p) => (decided.get(p.key) ?? 'open') === 'open');
}

/** A development PCBA to start from an accepted proposal: its pads as terminals, its parts in the links. */
export function proposalPcba(lib: Pick<ResolverLibrary, 'components'>, proposal: BoardProposal, id: string): PcbaDefinition {
  const terminals = proposal.pads.map((p) => ({ id: p.id, ...(p.label === undefined ? {} : { label: p.label }), ...(p.signal === undefined ? {} : { signal: p.signal }) }));
  const partOfNet = (net: ProposedNet): string | undefined => net.nodes.find((n) => n.includes('.'))?.split('.')[0];
  const internalLinks: PcbaDefinition['internalLinks'] = [];
  const pads = new Set(proposal.pads.map((p) => p.id));
  const byPart = new Map<string, string[]>();
  for (const net of proposal.nets) {
    const part = partOfNet(net);
    const pad = net.nodes.find((n) => pads.has(n));
    if (part !== undefined && pad !== undefined) byPart.set(part, [...(byPart.get(part) ?? []), pad]);
  }
  for (const [ref, list] of byPart) {
    const part = proposal.parts.find((p) => p.ref === ref);
    const component = part?.component === undefined ? undefined : componentForPart(lib, { component: part.component, placement: 'series' });
    for (let i = 1; i < list.length; i++) internalLinks.push({ from: list[0]!, to: list[i]!, via: `${ref} ${component?.value ?? part?.value ?? 'proposed'}` });
  }
  return {
    id,
    label: proposal.title,
    revision: 'draft',
    terminals,
    internalLinks,
    status: 'development',
    src: `${proposal.src}; draft from proposal "${proposal.key}" — open: ${proposal.open.join('; ') || 'nothing'}`,
  } as PcbaDefinition;
}

/** What is wrong with a proposal sent through the API, one sentence each. */
export function proposalProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['a proposal is an object { key, kind, title, pads, parts, nets, open, src }'];
  const p = value as Partial<BoardProposal>;
  const problems: string[] = [];
  if (typeof p.key !== 'string' || p.key.trim() === '') problems.push('key is required');
  if (p.kind !== 'draft' && p.kind !== 'build') problems.push('kind is draft or build');
  if (typeof p.title !== 'string' || p.title.trim() === '') problems.push('title is required');
  if (!Array.isArray(p.pads)) problems.push('pads must be a list');
  if (!Array.isArray(p.parts)) problems.push('parts must be a list');
  if (!Array.isArray(p.nets)) problems.push('nets must be a list');
  if (!Array.isArray(p.open)) problems.push('open must be a list');
  if (typeof p.src !== 'string' || p.src === '') problems.push('src is required');
  return problems;
}

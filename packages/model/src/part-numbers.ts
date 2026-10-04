/**
 * Part numbers — a pluggable scheme.
 *
 * The base knows only the *shape* of a numbering scheme: something that can
 * recognise one of its numbers, check a number against its rules, and
 * suggest a number for a part that has none. Which scheme a deployment uses
 * is configuration: the catalog's optional `part-numbers.json` configures the
 * built-in prefix scheme below, and a module may register a scheme of its own
 * (`docs/modules.md`, extension point "PN schemes").
 *
 * Everything here is pure and deterministic. Suggestions are proposals only;
 * nothing in this module writes anything, and every finding is a warning —
 * the scheme describes intent, a person decides.
 */

/** The catalog kinds a PN is checked or suggested for. */
export type PnKind =
  | 'connector'
  | 'component'
  | 'wire'
  | 'pcba'
  | 'bare-pcb'
  | 'shell'
  | 'fastener'
  | 'mechanical-other'
  | 'kit'
  | 'design';

export const PN_KINDS: readonly PnKind[] = [
  'connector',
  'component',
  'wire',
  'pcba',
  'bare-pcb',
  'shell',
  'fastener',
  'mechanical-other',
  'kit',
  'design',
];

export type PnIssueCode = 'pn-malformed' | 'pn-wrong-kind' | 'pn-unknown-prefix' | (string & {});

export interface PnIssue {
  code: PnIssueCode;
  severity: 'warning';
  message: string;
}

/** A number that already exists somewhere (a catalog record, a design). */
export interface KnownPartNumber {
  pn: string;
  kind?: PnKind;
  label?: string;
  /** where it was found: `connectors.json de9-male` */
  source: string;
}

/** What a number is being suggested for. */
export interface PnSubject {
  kind: PnKind;
  label: string;
  /** the record or design id */
  id?: string;
}

export interface PnSuggestion {
  pn: string;
  /** the scheme rule that produced it (`next-free`) */
  rule: string;
  /** one sentence a person can check */
  explanation: string;
  /** true when no specific rule applied and the scheme fell back to the next free number */
  fallback?: boolean;
}

/** A numbering scheme. Implementations must be pure. */
export interface PartNumberScheme {
  /** kebab id: `prefix` (the built-in), or a module's own */
  id: string;
  label: string;
  /** the canonical spelling of `pn` when it is one of this scheme's numbers, else `undefined` */
  parse(pn: string): string | undefined;
  /** findings for one number; `kind` narrows the checks when the caller knows what it numbers */
  check(pn: string, kind?: PnKind): PnIssue[];
  /** a proposal for `subject`, given every number already in use; `undefined` when the scheme does not number that kind */
  suggest(subject: PnSubject, known: readonly KnownPartNumber[]): PnSuggestion | undefined;
}

/* ------------------------------------------------------------------ *
 * The built-in prefix scheme: `<PREFIX>-<NNNNN>`
 * ------------------------------------------------------------------ */

/** The JSON shape of the catalog's `part-numbers.json`. */
export interface PrefixSchemeConfig {
  id?: string;
  label?: string;
  /** prefix per kind; a kind with no prefix is not numbered by the scheme */
  prefixes: Partial<Record<PnKind, string>>;
  /** zero-padded digits after the separator (default 5) */
  digits?: number;
  /** between prefix and digits (default `-`) */
  separator?: string;
  /** optional revision suffix, e.g. `-A` — read and kept, never suggested */
  allowRevisionSuffix?: boolean;
  src?: string;
}

export const DEFAULT_PREFIX_SCHEME_CONFIG: PrefixSchemeConfig = {
  id: 'prefix',
  label: 'Prefix + sequence (CON-00001)',
  prefixes: {
    connector: 'CON',
    component: 'CMP',
    wire: 'WIR',
    pcba: 'PCA',
    'bare-pcb': 'PCB',
    shell: 'SHL',
    fastener: 'HW',
    'mechanical-other': 'MEC',
    kit: 'KIT',
    design: 'CBL',
  },
  digits: 5,
  separator: '-',
  allowRevisionSuffix: true,
  src: 'synthetic example: the base default scheme',
};

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse a `PrefixSchemeConfig` from untrusted JSON; throws with a message naming the bad field. */
export function parsePrefixSchemeConfig(json: unknown): PrefixSchemeConfig {
  if (typeof json !== 'object' || json === null) throw new Error('part-numbers.json must be an object');
  const o = json as Record<string, unknown>;
  const prefixes = o['prefixes'];
  if (typeof prefixes !== 'object' || prefixes === null) throw new Error('part-numbers.json: prefixes must be an object');
  const out: Partial<Record<PnKind, string>> = {};
  for (const [k, v] of Object.entries(prefixes as Record<string, unknown>)) {
    if (!(PN_KINDS as readonly string[]).includes(k)) throw new Error(`part-numbers.json: '${k}' is not a part-number kind`);
    if (typeof v !== 'string' || !/^[A-Z0-9]{1,8}$/.test(v)) throw new Error(`part-numbers.json: prefix for '${k}' must be 1–8 capitals/digits`);
    out[k as PnKind] = v;
  }
  const digits = o['digits'];
  if (digits !== undefined && (typeof digits !== 'number' || !Number.isInteger(digits) || digits < 1 || digits > 12)) {
    throw new Error('part-numbers.json: digits must be an integer 1–12');
  }
  const separator = o['separator'];
  if (separator !== undefined && (typeof separator !== 'string' || separator.length > 2)) throw new Error('part-numbers.json: separator must be a short string');
  return {
    ...(typeof o['id'] === 'string' ? { id: o['id'] } : {}),
    ...(typeof o['label'] === 'string' ? { label: o['label'] } : {}),
    prefixes: out,
    ...(digits === undefined ? {} : { digits: digits as number }),
    ...(separator === undefined ? {} : { separator: separator as string }),
    ...(o['allowRevisionSuffix'] === undefined ? {} : { allowRevisionSuffix: o['allowRevisionSuffix'] === true }),
    ...(typeof o['src'] === 'string' ? { src: o['src'] } : {}),
  };
}

/** The built-in scheme: one prefix per kind, then a zero-padded sequence. */
export function prefixPartNumberScheme(config: PrefixSchemeConfig = DEFAULT_PREFIX_SCHEME_CONFIG): PartNumberScheme {
  const digits = config.digits ?? 5;
  const sep = config.separator ?? '-';
  const byPrefix = new Map<string, PnKind>();
  for (const [kind, prefix] of Object.entries(config.prefixes) as [PnKind, string][]) byPrefix.set(prefix, kind);
  const suffix = config.allowRevisionSuffix ? `(${escapeRe(sep)}[A-Za-z0-9]{1,3})?` : '()';
  const re = new RegExp(`^\\s*([A-Za-z0-9]{1,8})${escapeRe(sep)}(\\d{${digits}})${suffix}\\s*$`);

  function split(pn: string): { prefix: string; number: string; suffix: string } | undefined {
    const m = re.exec(pn);
    if (m === null) return undefined;
    return { prefix: (m[1] as string).toUpperCase(), number: m[2] as string, suffix: (m[3] ?? '').toUpperCase() };
  }

  return {
    id: config.id ?? 'prefix',
    label: config.label ?? 'Prefix + sequence',
    parse(pn) {
      const p = split(pn);
      return p === undefined ? undefined : `${p.prefix}${sep}${p.number}${p.suffix}`;
    },
    check(pn, kind) {
      const p = split(pn);
      if (p === undefined) {
        return [{ code: 'pn-malformed', severity: 'warning', message: `'${pn}' is not <PREFIX>${sep}${'N'.repeat(digits)}` }];
      }
      const owner = byPrefix.get(p.prefix);
      if (owner === undefined) return [{ code: 'pn-unknown-prefix', severity: 'warning', message: `prefix '${p.prefix}' is not in the scheme` }];
      if (kind !== undefined && owner !== kind) {
        return [{ code: 'pn-wrong-kind', severity: 'warning', message: `'${p.prefix}' numbers ${owner}, not ${kind}` }];
      }
      return [];
    },
    suggest(subject, known) {
      const prefix = config.prefixes[subject.kind];
      if (prefix === undefined) return undefined;
      let max = 0;
      for (const k of known) {
        const p = split(k.pn);
        if (p !== undefined && p.prefix === prefix) max = Math.max(max, Number(p.number));
      }
      const next = String(max + 1).padStart(digits, '0');
      return {
        pn: `${prefix}${sep}${next}`,
        rule: 'next-free',
        explanation: `the next free ${prefix} number after ${max === 0 ? 'none in use' : `${prefix}${sep}${String(max).padStart(digits, '0')}`}`,
        fallback: true,
      };
    },
  };
}

/** The scheme a deployment gets when it configures none. */
export const DEFAULT_PART_NUMBER_SCHEME: PartNumberScheme = prefixPartNumberScheme();

/** Canonical spelling under `scheme`, falling back to the trimmed text. */
export function canonicalPartNumber(pn: string | undefined, scheme: PartNumberScheme = DEFAULT_PART_NUMBER_SCHEME): string | undefined {
  if (pn === undefined) return undefined;
  const t = pn.trim();
  if (t === '') return undefined;
  return scheme.parse(t) ?? t;
}

/* ------------------------------------------------------------------ *
 * The numbers in use
 * ------------------------------------------------------------------ */

/**
 * Every part number the catalog and the designs already carry, with where it
 * was found — what a scheme's `suggest` reads so it never proposes a number
 * that is taken. `extra` adds numbers from elsewhere (drawing sidecars, an
 * external register a module reads).
 */
export function knownPartNumbers(
  db: {
    connectors: readonly { id: string; label: string; partNumber?: string }[];
    wires: readonly { id: string; label: string; partNumber?: string }[];
    components: readonly { id: string; label: string; partNumber?: string }[];
    pcbas: readonly { id: string; label: string; partNumber?: string }[];
    mechanicals?: readonly { id: string; label: string; partNumber?: string; kind: string }[];
    kits?: readonly { id?: string; sku: string; label: string }[];
  },
  designs: readonly { id: string; label: string; productRef?: string }[] = [],
  extra: readonly KnownPartNumber[] = [],
): KnownPartNumber[] {
  const out: KnownPartNumber[] = [];
  const add = (pn: string | undefined, kind: PnKind, label: string, source: string): void => {
    if (pn !== undefined && pn.trim() !== '') out.push({ pn: pn.trim(), kind, label, source });
  };
  for (const c of db.connectors) add(c.partNumber, 'connector', c.label, `connectors.json ${c.id}`);
  for (const w of db.wires) add(w.partNumber, 'wire', w.label, `wires.json ${w.id}`);
  for (const c of db.components) add(c.partNumber, 'component', c.label, `components.json ${c.id}`);
  for (const p of db.pcbas) add(p.partNumber, 'pcba', p.label, `pcbas.json ${p.id}`);
  for (const m of db.mechanicals ?? []) {
    add(m.partNumber, m.kind === 'shell' ? 'shell' : m.kind === 'fastener' ? 'fastener' : 'mechanical-other', m.label, `mechanicals.json ${m.id}`);
  }
  for (const k of db.kits ?? []) add(k.sku, 'kit', k.label, `kits.json ${k.sku}`);
  for (const d of designs) add(d.productRef, 'design', d.label, `designs/${d.id}.json`);
  out.push(...extra);
  return out;
}

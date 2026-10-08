/**
 * The wire builder — Library › Wire stocks, a stock put together from parts
 * (data-model v2 §6 and journey J2;).
 *
 * Everything that is a part is **picked** from the parts library (cores,
 * conductors, shields, drain, jacket); a part the library lacks is added
 * through "New part…", which asks for a citation like every record. The lay
 * is arranged **on the live cross-section**: drag a core onto another and
 * they trade places, or focus one and use the arrow keys. Everything the
 * compile derives — diameters, areas, the bundle, the jacket wall — is shown
 * read-only with its working on hover, and an assumption says so.
 *
 * The drawing is the documentary renderer the build sheet and the spec sheet
 * use, so its grounding follows the owner's rules for free: a foil gets no
 * key row, a fully bonded stock's shields are keyed once as one mass, and the
 * drain sits in the gap against the shield.
 */

import type { CompiledWire, RecipeCore, StripPractice, WireLayOrder, WireLibrary, WirePart, WirePartKind, WireRecipe } from '@wirehub/model';
import { crossSectionLayout, renderCrossSection, type CrossSection } from '@wirehub/render-svg';
import { IconArrowsExchange, IconCopy, IconFileText, IconPlus, IconTrash } from '@tabler/icons-react';
import { useMemo, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';

import { classes } from '../context.ts';
import {
  addCore,
  addVendorDoc,
  applyPartToAll,
  bondingSuggestions,
  compileRecipe,
  flipViewedFrom,
  layFor,
  otherEndReading,
  partsOfKind,
  recipeProblems,
  recolourCore,
  removeCore,
  removeVendorDoc,
  signalChoices,
  stepInRing,
  swapInLay,
  withArrangement,
  type VendorDocument,
  type VendorDocumentsAdapter,
} from '../wire-builder.ts';
import { resolveVocab } from '@wirehub/model';

import { useVocab, vocabOptions } from '../vocab.ts';
import { layFactsOf, presetsFor } from '../wire-view.ts';
import { LazyWireModel3d } from './wire-model-lazy.tsx';
import { Pick as VocabPick } from './Pick.tsx';
import { croppedSvg, cutawayCrop } from './WireStockEditor.tsx';

/* ------------------------------------------------------------------ *
 * Small controls
 * ------------------------------------------------------------------ */

function Pick(props: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  none?: string;
  title?: string;
  wide?: boolean;
}): JSX.Element {
  return (
    <label className={classes('cs-wb-field', props.wide === true && 'is-wide')} title={props.title}>
      <span>{props.label}</span>
      <select value={props.value} aria-label={props.label} onChange={(event) => props.onChange(event.target.value)}>
        {props.none === undefined ? null : <option value="">{props.none}</option>}
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Text(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  title?: string;
  wide?: boolean;
  mono?: boolean;
  disabled?: boolean;
}): JSX.Element {
  return (
    <label className={classes('cs-wb-field', props.wide === true && 'is-wide')} title={props.title}>
      <span>{props.label}</span>
      <input
        className={classes(props.mono === true && 'cs-mono')}
        value={props.value}
        aria-label={props.label}
        disabled={props.disabled}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function Segmented<T extends string>(props: {
  label: string;
  value: T | undefined;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
}): JSX.Element {
  return (
    <div className="cs-wb-field">
      <span>{props.label}</span>
      <div className="cs-wb-seg" role="radiogroup" aria-label={props.label}>
        {props.options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={props.value === option.value}
            className={classes(props.value === option.value && 'is-on')}
            title={option.title}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const optionsOf = (parts: readonly WirePart[]): { value: string; label: string }[] =>
  parts.map((part) => ({ value: part.id, label: part.label }));

const ARRANGEMENTS: { value: WireLayOrder['arrangement']; label: string }[] = [
  { value: '6-around-1', label: '6 around 1' },
  { value: '7-around-1', label: '7 around 1' },
  { value: '6-around-2', label: '6 around a pair' },
  { value: 'pair', label: 'pair (round)' },
  { value: 'figure-8', label: 'figure-8 (two legs moulded together)' },
];

/* ------------------------------------------------------------------ *
 * The manufacturer's own documents
 * ------------------------------------------------------------------ */

function VendorDocs(props: {
  recipe: WireRecipe;
  documents: VendorDocumentsAdapter | undefined;
  onChange: (next: WireRecipe) => void;
}): JSX.Element {
  const { recipe, documents } = props;
  const docs = recipe.vendorDocs ?? [];
  const [choices, setChoices] = useState<VendorDocument[] | undefined>(undefined);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const open = (): void => {
    if (documents === undefined) return;
    void documents.list().then((result) => {
      if (result.ok) {
        setChoices(result.value.filter((doc) => !docs.some((d) => d.asset === doc.id)));
        setProblem(undefined);
      } else setProblem(result.message);
    });
  };
  return (
    <section className="cs-wb-section" aria-label="vendor documents">
      <header className="cs-wb-head">
        <h3>Vendor documents</h3>
        <span className="cs-count">{docs.length}</span>
        <span className="cs-wb-spacer" />
        {documents === undefined ? null : (
          <button type="button" className="cs-small" onClick={open} title="Link one of the manufacturer's files held in WireHub">
            <IconPlus size={13} stroke={1.75} /> Link document…
          </button>
        )}
      </header>
      {docs.length === 0 ? <p className="cs-wb-empty">None linked.</p> : null}
      <ul className="cs-wb-docs">
        {docs.map((doc) => (
          <li key={doc.asset}>
            <IconFileText size={14} stroke={1.75} aria-hidden="true" />
            {documents === undefined ? (
              <span title={doc.src}>{doc.label}</span>
            ) : (
              <a href={documents.href(doc.asset)} target="_blank" rel="noopener noreferrer" title={doc.src}>
                {doc.label}
              </a>
            )}
            <span className="cs-wb-doc-src" title={doc.src}>
              {doc.src}
            </span>
            <button
              type="button"
              className="cs-icon-btn cs-small"
              aria-label={`unlink ${doc.label}`}
              title="Unlink (the file stays in WireHub)"
              onClick={() => props.onChange(removeVendorDoc(recipe, doc.asset))}
            >
              <IconTrash size={13} stroke={1.75} />
            </button>
          </li>
        ))}
      </ul>
      {choices === undefined ? null : (
        <div className="cs-wb-docpick">
          <select
            aria-label="document to link"
            value=""
            onChange={(event) => {
              const doc = choices.find((c) => c.id === event.target.value);
              if (doc !== undefined) props.onChange(addVendorDoc(recipe, doc));
              setChoices(undefined);
            }}
          >
            <option value="">{choices.length === 0 ? 'no other files held' : 'pick a file…'}</option>
            {choices.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.originalName}
              </option>
            ))}
          </select>
          <button type="button" className="cs-small" onClick={() => setChoices(undefined)}>
            Cancel
          </button>
        </div>
      )}
      {problem === undefined ? null : <p className="cs-error">{problem}</p>}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * The live cross-section, with the lay arranged by drag
 * ------------------------------------------------------------------ */

function LayDrawing(props: {
  compiled: CompiledWire;
  recipe: WireRecipe;
  onSwap: (a: string, b: string) => void;
  onStep: (id: string, by: 1 | -1) => void;
}): JSX.Element {
  const { compiled, recipe } = props;
  const drawn = useMemo((): { svg: string; cs: CrossSection } | undefined => {
    try {
      const cs = crossSectionLayout(compiled.wire);
      if (cs === undefined) return undefined;
      return { svg: croppedSvg(renderCrossSection(compiled.wire), cutawayCrop(cs)), cs };
    } catch {
      return undefined;
    }
  }, [compiled]);
  const overlay = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | undefined>(undefined);
  const [over, setOver] = useState<string | undefined>(undefined);

  if (drawn === undefined) {
    return (
      <div className="cs-wb-drawing is-empty" role="status">
        {recipe.cores.length === 0 ? 'Add cores to see the cross-section.' : 'Pick a jacket and a lay to draw the cross-section.'}
      </div>
    );
  }
  const { cs, svg } = drawn;
  const crop = cutawayCrop(cs);
  const movable = cs.cores.filter((core) => core.layIndex !== -2);
  const toSvg = (event: ReactPointerEvent): { x: number; y: number } => {
    const node = overlay.current;
    const matrix = node?.getScreenCTM();
    if (node === null || matrix === null || matrix === undefined) return { x: 0, y: 0 };
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  };
  const hit = (x: number, y: number): string | undefined =>
    movable.find((core) => Math.hypot(core.cx - x, core.cy - y) <= core.r)?.elementPath;

  return (
    <div className="cs-wb-drawing">
      <div className="cs-wb-stack">
        <div className="cs-wb-svg" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
        <svg
          ref={overlay}
          className="cs-wb-overlay"
          viewBox={`${crop.x} ${crop.y} ${crop.w} ${crop.h}`}
          role="group"
          aria-label="lay order — drag a core onto another to swap them"
          onPointerMove={(event) => {
            if (drag === undefined) return;
            const at = toSvg(event);
            setDrag({ ...drag, ...at });
            setOver(hit(at.x, at.y));
          }}
          onPointerUp={(event) => {
            if (drag === undefined) return;
            const at = toSvg(event);
            const target = hit(at.x, at.y);
            if (target !== undefined && target !== drag.id) props.onSwap(drag.id, target);
            setDrag(undefined);
            setOver(undefined);
          }}
          onPointerLeave={() => {
            setDrag(undefined);
            setOver(undefined);
          }}
        >
          {movable.map((core) => (
            <circle
              key={core.elementPath}
              className={classes(
                'cs-wb-handle',
                drag?.id === core.elementPath && 'is-dragging',
                over === core.elementPath && drag?.id !== core.elementPath && 'is-target',
              )}
              cx={core.cx}
              cy={core.cy}
              r={core.r}
              tabIndex={0}
              role="button"
              aria-label={`${core.elementPath}, lay position ${core.tag}`}
              onPointerDown={(event) => {
                event.preventDefault();
                (event.target as Element).setPointerCapture?.(event.pointerId);
                const at = toSvg(event);
                setDrag({ id: core.elementPath, ...at });
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                  event.preventDefault();
                  props.onStep(core.elementPath, 1);
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  props.onStep(core.elementPath, -1);
                }
              }}
            >
              <title>{`${core.elementPath} — drag onto another core to swap; arrow keys step it along the ring`}</title>
            </circle>
          ))}
          {drag === undefined ? null : (
            <circle className="cs-wb-ghost" cx={drag.x} cy={drag.y} r={movable.find((c) => c.elementPath === drag.id)?.r ?? 3} />
          )}
        </svg>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Derived values
 * ------------------------------------------------------------------ */

const FIELD_WORDS: Record<string, string> = {
  odMm: 'Ø',
  areaMm2: 'area',
  insulatedOdMm: 'Ø insulated',
  envelopeMm: 'bundle Ø',
  wallMm: 'jacket wall',
};

function Derived({ compiled }: { compiled: CompiledWire }): JSX.Element {
  // one row per distinct (field, value, formula): six identical cores show once
  const rows: { key: string; paths: string[]; field: string; value: number; formula: string; inferred: boolean }[] = [];
  for (const value of compiled.derived) {
    const key = `${value.field}|${value.value}|${value.formula.replace(/core-[a-z]+(-\d+)?\./g, '')}`;
    const pathTail = value.path.replace(/^core-[a-z]+(-\d+)?\./, '');
    const existing = rows.find((row) => row.key === key && row.paths[0]?.replace(/^core-[a-z]+(-\d+)?\./, '') === pathTail);
    if (existing !== undefined) existing.paths.push(value.path);
    else rows.push({ key, paths: [value.path], field: value.field, value: value.value, formula: value.formula, inferred: value.inferred });
  }
  const unit = (field: string): string => (field === 'areaMm2' ? 'mm²' : 'mm');
  return (
    <section className="cs-wb-derived" aria-label="derived values">
      <h3>Derived</h3>
      {rows.length === 0 ? (
        <p className="cs-wb-empty">Nothing derived — every value is from the sheet.</p>
      ) : (
        <table>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.key}|${row.paths[0]}`} title={row.formula}>
                <th scope="row">
                  {row.paths[0] === 'stock' || row.field === 'wallMm'
                    ? ''
                    : row.paths.length > 1
                      ? `${row.paths.length}× ${row.paths[0]!.replace(/^core-[a-z]+(-\d+)?\./, 'core.')}`
                      : row.paths[0]}{' '}
                  <span className="cs-wb-dim">{FIELD_WORDS[row.field] ?? row.field}</span>
                </th>
                <td className="cs-mono">
                  {row.value} {unit(row.field)}
                  {row.inferred ? <span className="cs-wb-inferred" title="rests on an assumption, not a sheet — the element src says INFERRED">inferred</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * New part
 * ------------------------------------------------------------------ */

const PART_KIND_WORDS: Record<WirePartKind, string> = {
  core: 'Core (assembly)',
  conductor: 'Conductor',
  insulation: 'Insulation / dielectric / sheath',
  shield: 'Shield',
  jacket: 'Jacket',
};

function num(value: string): number | undefined {
  const n = Number(value.replace(',', '.'));
  return value.trim() === '' || !Number.isFinite(n) ? undefined : n;
}

export function NewPartDialog(props: {
  library: WireLibrary;
  initialKind?: WirePartKind;
  onCancel: () => void;
  onAdd: (part: WirePart) => Promise<string | undefined>;
}): JSX.Element {
  const [kind, setKind] = useState<WirePartKind>(props.initialKind ?? 'conductor');
  const [f, setF] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const set = (key: string) => (value: string) => setF((current) => ({ ...current, [key]: value }));
  const v = (key: string): string => f[key] ?? '';
  const { vocab } = useVocab();
  const parts = props.library.parts;
  // a material is stored as the words a sheet prints ("tinned copper"); the
  // picker holds the vocab entry those words resolve to, and a pick keeps the
  // spelling when it already names that entry
  const materialEntry = resolveVocab(vocab, 'materials', v('material'))?.entry;
  // `pair` is in core-kinds but not yet something a core part can be built as
  const builtAsOptions = vocabOptions(vocab, 'core-kinds').filter((o) => ['coax', 'shielded-core', 'plain'].includes(o.value));

  const build = (): WirePart | string => {
    const id = v('id').trim();
    const label = v('label').trim();
    const src = v('src').trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) return 'The id has to be lowercase words joined by hyphens.';
    if (label === '') return 'Give the part a name.';
    if (src === '') return 'Cite where its values come from.';
    const base = { id, label, src, ...(v('manufacturer').trim() === '' ? {} : { manufacturer: v('manufacturer').trim() }) };
    const opt = (key: string, value: number | undefined): Record<string, number> => (value === undefined ? {} : { [key]: value });
    switch (kind) {
      case 'conductor':
        if (v('material') === '') return 'Pick the material.';
        return { kind, ...base, material: v('material'), ...opt('strands', num(v('strands'))), ...opt('strandMm', num(v('strandMm'))), ...opt('odMm', num(v('odMm'))) };
      case 'insulation':
        if (v('material') === '') return 'Pick the material.';
        return {
          kind,
          ...base,
          material: v('material'),
          ...opt('odMm', num(v('odMm'))),
          ...opt('wallMm', num(v('wallMm'))),
          ...opt('tolMm', num(v('tolMm'))),
          ...(v('color') === '' ? {} : { color: v('color') }),
        };
      case 'shield':
        if (v('material') === '') return 'Pick the material.';
        return {
          kind,
          ...base,
          construction: (v('construction') || 'spiral') as 'braid' | 'spiral' | 'foil' | 'tape',
          material: v('material'),
          ...(v('coveragePct') === '' ? {} : { coveragePct: v('coveragePct') }),
          ...opt('strandMm', num(v('strandMm'))),
          ...opt('thicknessMm', num(v('thicknessMm'))),
        };
      case 'jacket': {
        const od = num(v('odMm'));
        if (od === undefined) return 'A jacket needs its outer Ø.';
        if (v('material') === '') return 'Pick the material.';
        return { kind, ...base, material: v('material'), odMm: od, ...opt('tolMm', num(v('tolMm'))), color: v('color') || 'black' };
      }
      case 'core':
        if (v('conductor') === '') return 'Pick the conductor.';
        return {
          kind,
          ...base,
          builtAs: (v('builtAs') || 'coax') as 'coax' | 'shielded-core' | 'plain',
          conductor: v('conductor'),
          ...(v('dielectric') === '' ? {} : { dielectric: v('dielectric') }),
          ...(v('insulation') === '' ? {} : { insulation: v('insulation') }),
          ...(v('shield') === '' ? {} : { shield: v('shield') }),
          ...(v('sheath') === '' ? {} : { sheath: v('sheath') }),
        };
    }
  };

  const opts = (k: WirePartKind): { value: string; label: string }[] => optionsOf(partsOfKind(parts, k));
  const materialPick = (
    <VocabPick
      label="Material"
      list="materials"
      say="Picked from the materials list; add one with its source if it is missing"
      value={materialEntry?.id ?? v('material')}
      placeholder="Pick a material"
      onChange={(id, picked) => {
        if (id === materialEntry?.id) return;
        set('material')(picked?.label ?? id);
      }}
    />
  );

  return (
    <div className="cs-modal" role="dialog" aria-modal="true" aria-label="New wire part">
      <div className="cs-modal-card cs-wb-dialog">
        <h2>New part</h2>
        <div className="cs-wb-grid">
          <Pick
            label="Kind"
            value={kind}
            options={(Object.keys(PART_KIND_WORDS) as WirePartKind[]).map((k) => ({ value: k, label: PART_KIND_WORDS[k] }))}
            onChange={(value) => setKind(value as WirePartKind)}
          />
          <Text label="Id" value={v('id')} onChange={set('id')} mono placeholder="c-tc-11x010-vendor" />
          <Text label="Name" value={v('label')} onChange={set('label')} wide placeholder="TC 11×0.10 mm, 28 AWG (Vendor)" />
          {kind === 'conductor' ? (
            <>
              {materialPick}
              <Text label="Strands" value={v('strands')} onChange={set('strands')} mono />
              <Text label="Strand Ø mm" value={v('strandMm')} onChange={set('strandMm')} mono />
              <Text label="Outer Ø mm" value={v('odMm')} onChange={set('odMm')} mono title="Leave blank to derive it from the strands" />
            </>
          ) : null}
          {kind === 'insulation' ? (
            <>
              {materialPick}
              <Text label="Ø mm" value={v('odMm')} onChange={set('odMm')} mono />
              <Text label="or wall mm" value={v('wallMm')} onChange={set('wallMm')} mono />
              <Text label="± mm" value={v('tolMm')} onChange={set('tolMm')} mono />
              <VocabPick
                label="Fixed colour"
                list="colours"
                clearable
                noneLabel="the core's colour"
                say="Only when this layer is not the core's own colour — a figure-8 leg's black jacket"
                value={v('color')}
                onChange={set('color')}
              />
            </>
          ) : null}
          {kind === 'shield' ? (
            <>
              <VocabPick
                label="Construction"
                list="constructions"
                allowAdd={false}
                value={v('construction') || 'spiral'}
                onChange={set('construction')}
              />
              {materialPick}
              <Text label="Coverage" value={v('coveragePct')} onChange={set('coveragePct')} />
              <Text label="Strand Ø mm" value={v('strandMm')} onChange={set('strandMm')} mono />
              <Text label="Thickness mm" value={v('thicknessMm')} onChange={set('thicknessMm')} mono title="foil or tape" />
            </>
          ) : null}
          {kind === 'jacket' ? (
            <>
              {materialPick}
              <Text label="Ø mm" value={v('odMm')} onChange={set('odMm')} mono />
              <Text label="± mm" value={v('tolMm')} onChange={set('tolMm')} mono />
              <VocabPick label="Colour" list="colours" value={v('color') || 'black'} onChange={set('color')} />
            </>
          ) : null}
          {kind === 'core' ? (
            <>
              <VocabPick
                label="Built as"
                list="core-kinds"
                options={builtAsOptions}
                allowAdd={false}
                value={v('builtAs') || 'coax'}
                onChange={set('builtAs')}
              />
              <Pick label="Conductor" value={v('conductor')} none="—" options={opts('conductor')} onChange={set('conductor')} />
              <Pick label="Dielectric" value={v('dielectric')} none="none" options={opts('insulation')} onChange={set('dielectric')} />
              <Pick label="Insulation" value={v('insulation')} none="none" options={opts('insulation')} onChange={set('insulation')} />
              <Pick label="Shield" value={v('shield')} none="none" options={opts('shield')} onChange={set('shield')} />
              <Pick label="Sheath" value={v('sheath')} none="none" options={opts('insulation')} onChange={set('sheath')} />
            </>
          ) : null}
          <VocabPick
            label="Manufacturer"
            list="manufacturers"
            clearable
            noneLabel="not recorded"
            say="Who makes this part; leave blank when it is not known"
            value={v('manufacturer')}
            onChange={set('manufacturer')}
          />
          <Text label="Reference" value={v('src')} onChange={set('src')} wide title="The vendor sheet or measurement behind these values; say INFERRED when a value is assumed" />
        </div>
        {problem === undefined ? null : <p className="cs-error">{problem}</p>}
        <div className="cs-modal-actions">
          <button type="button" className="cs-quiet" onClick={props.onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="cs-primary"
            disabled={busy}
            onClick={() => {
              const part = build();
              if (typeof part === 'string') {
                setProblem(part);
                return;
              }
              setBusy(true);
              void props.onAdd(part).then((failure) => {
                setBusy(false);
                if (failure !== undefined) setProblem(failure);
              });
            }}
          >
            Add part
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The builder
 * ------------------------------------------------------------------ */

export interface WireBuilderProps {
  recipe: WireRecipe;
  library: WireLibrary;
  onChange: (next: WireRecipe) => void;
  /** a new stock: the id is editable */
  create: boolean;
  readOnly?: boolean;
  /** open "New part…" */
  onNewPart?: (kind: WirePartKind) => void;
  /** the host's stored files — the manufacturer's documents link to them */
  documents?: VendorDocumentsAdapter;
  /** the bench's strip steps: the live 3D preview's presets */
  practice?: readonly StripPractice[];
}

const PREVIEW_KEY = 'cs-wb-preview';

function readPreview(): 'section' | '3d' {
  try {
    return window.localStorage.getItem(PREVIEW_KEY) === '3d' ? '3d' : 'section';
  } catch {
    return 'section';
  }
}

export function WireBuilder(props: WireBuilderProps): JSX.Element {
  const { recipe, library, onChange } = props;
  const compiled = useMemo(() => compileRecipe(recipe, library), [recipe, library]);
  const [preview, setPreview] = useState<'section' | '3d'>(readPreview);
  const presets = useMemo(() => presetsFor(compiled.wire, props.practice ?? []), [compiled.wire, props.practice]);
  const facts = useMemo(() => layFactsOf(recipe), [recipe]);
  const pickPreview = (next: 'section' | '3d'): void => {
    setPreview(next);
    try {
      window.localStorage.setItem(PREVIEW_KEY, next);
    } catch {
      // a private window: not remembered
    }
  };
  const set = <K extends keyof WireRecipe>(key: K, value: WireRecipe[K]): void => onChange({ ...recipe, [key]: value });
  const cores = partsOfKind(library.parts, 'core');
  const vocabScope = useVocab();
  const signals = signalChoices(recipe, vocabScope.vocab);
  const lay = recipe.lay;
  const suggestions = bondingSuggestions(recipe, compiled);
  const warnings = compiled.issues.filter((issue) => issue.severity === 'warning');
  const updateCore = (id: string, patch: Partial<RecipeCore>): void =>
    set(
      'cores',
      recipe.cores.map((core) => {
        if (core.id !== id) return core;
        const next = { ...core, ...patch };
        for (const key of Object.keys(patch) as (keyof RecipeCore)[]) if (patch[key] === '') delete next[key];
        return next;
      }),
    );

  return (
    <div className={classes('cs-wb', props.readOnly === true && 'is-readonly')}>
      <div className="cs-wb-form">
        <fieldset disabled={props.readOnly === true}>
          <section className="cs-wb-section" aria-label="stock">
            <div className="cs-wb-grid">
              <Text label="Name" value={recipe.label} onChange={(value) => set('label', value)} wide placeholder="Mini Coax 6+2C 75 Ω (Vendor)" />
              <Text
                label="Id"
                value={recipe.id}
                mono
                disabled={!props.create}
                title={props.create ? 'lowercase words joined by hyphens' : 'fixed — designs refer to the stock by it'}
                onChange={(value) => onChange({ ...recipe, id: value })}
              />
              <Text label="Part number" value={recipe.partNumber ?? ''} mono onChange={(value) => set('partNumber', value === '' ? undefined : value)} />
              <VocabPick
                label="Colour code"
                list="colour-codes"
                allowAdd={false}
                say="Which colour means which lane — the cores' default signals follow it"
                clearable
                noneLabel="none"
                value={recipe.colourCode ?? ''}
                onChange={(code) => set('colourCode', code === '' ? undefined : code)}
              />
              <VocabPick
                label="Manufacturer"
                list="manufacturers"
                say="Who makes this wire — leave blank when it is not known"
                clearable
                noneLabel="not recorded"
                value={recipe.manufacturer ?? ''}
                onChange={(maker) => set('manufacturer', maker === '' ? undefined : maker)}
              />

              <Text label="Reference" value={recipe.src} wide onChange={(value) => set('src', value)} title="The vendor sheet behind this stock; say INFERRED for anything assumed" />
            </div>
          </section>

          <VendorDocs recipe={recipe} documents={props.documents} onChange={onChange} />

          <section className="cs-wb-section" aria-label="cores">
            <header className="cs-wb-head">
              <h3>Cores</h3>
              <span className="cs-count">{recipe.cores.length}</span>
              <span className="cs-wb-spacer" />
              {props.onNewPart === undefined ? null : (
                <button type="button" className="cs-small" onClick={() => props.onNewPart?.('core')}>
                  <IconPlus size={13} stroke={1.75} /> New part…
                </button>
              )}
            </header>
            <table className="cs-wb-table">
              <thead>
                <tr>
                  <th>Colour</th>
                  <th>Signal</th>
                  <th>Built from</th>
                  <th title="Swap this core's conductor for another part">Conductor</th>
                  <th aria-label="actions" />
                </tr>
              </thead>
              <tbody>
                {recipe.cores.map((core) => (
                  <tr key={core.id}>
                    <td>
                      <span className="cs-wb-chip" style={{ background: `var(--cond-${core.colour}, #999)` }} aria-hidden="true" />
                      <VocabPick
                        list="colours"
                        ariaLabel={`${core.id} colour`}
                        value={core.colour}
                        onChange={(colour) => {
                          if (colour !== '') onChange(recolourCore(recipe, core.id, colour));
                        }}
                      />
                    </td>
                    <td>
                      <select aria-label={`${core.id} signal`} value={core.signal ?? ''} onChange={(event) => updateCore(core.id, { signal: event.target.value })}>
                        <option value="">{`${core.colour} (colour code)`}</option>
                        {signals.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select aria-label={`${core.id} assembly`} value={core.part} onChange={(event) => updateCore(core.id, { part: event.target.value })}>
                        {cores.map((part) => (
                          <option key={part.id} value={part.id}>
                            {part.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select aria-label={`${core.id} conductor`} value={core.conductor ?? ''} onChange={(event) => updateCore(core.id, { conductor: event.target.value })}>
                        <option value="">as the assembly</option>
                        {partsOfKind(library.parts, 'conductor').map((part) => (
                          <option key={part.id} value={part.id}>
                            {part.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="cs-wb-actions">
                      <button type="button" className="cs-icon-btn cs-small" title="Build every core from this assembly" aria-label={`apply ${core.id}'s assembly to all cores`} onClick={() => onChange(applyPartToAll(recipe, core.part))}>
                        <IconCopy size={13} stroke={1.75} />
                      </button>
                      <button type="button" className="cs-icon-btn cs-small" title="Remove this core" aria-label={`remove ${core.id}`} onClick={() => onChange(removeCore(recipe, core.id))}>
                        <IconTrash size={13} stroke={1.75} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              className="cs-small cs-wb-add"
              disabled={cores.length === 0}
              onClick={() => onChange(addCore(recipe, recipe.cores[recipe.cores.length - 1]?.part ?? cores[0]!.id))}
            >
              <IconPlus size={13} stroke={1.75} /> Core
            </button>
          </section>

          <section className="cs-wb-section" aria-label="over the cores">
            <header className="cs-wb-head">
              <h3>Over the cores</h3>
            </header>
            <div className="cs-wb-grid">
              <Pick
                label="Overall shield"
                value={recipe.overall?.shield ?? ''}
                none="none"
                options={optionsOf(partsOfKind(library.parts, 'shield'))}
                onChange={(value) => set('overall', { ...recipe.overall, ...(value === '' ? { shield: undefined } : { shield: value }) })}
              />
              <Text
                label="Shield Ø mm"
                value={recipe.overall?.shieldOdMm === undefined ? '' : String(recipe.overall.shieldOdMm)}
                mono
                placeholder="derived"
                title="Only when the sheet states it or it was measured — blank derives it (and flags it inferred)"
                onChange={(value) => set('overall', { ...recipe.overall, shieldOdMm: num(value) })}
              />
              <Pick
                label="Drain"
                value={recipe.overall?.drain ?? ''}
                none="none"
                options={optionsOf(partsOfKind(library.parts, 'conductor'))}
                onChange={(value) => set('overall', { ...recipe.overall, ...(value === '' ? { drain: undefined } : { drain: value }) })}
              />
              {lay?.arrangement === 'figure-8' ? null : (
                <Pick
                  label="Jacket"
                  value={recipe.jacket ?? ''}
                  none="none"
                  options={optionsOf(partsOfKind(library.parts, 'jacket'))}
                  onChange={(value) => set('jacket', value === '' ? undefined : value)}
                />
              )}
            </div>
            {lay?.arrangement === 'figure-8' && recipe.web !== undefined ? (
              <div className="cs-wb-grid" aria-label="figure-8 web">
                <Text
                  label="Web material"
                  value={recipe.web.material}
                  onChange={(material) => set('web', { ...recipe.web!, material })}
                  title="Each leg carries its own jacket (its sheath part); the web is the moulding that joins them"
                />
                <VocabPick label="Web colour" list="colours" value={recipe.web.color ?? 'black'} onChange={(color) => set('web', { ...recipe.web!, color })} />
                <Text
                  label="Gap mm"
                  value={recipe.web.gapMm === undefined ? '' : String(recipe.web.gapMm)}
                  mono
                  placeholder="0"
                  title="Clear gap between the two legs' jackets; 0 = moulded touching"
                  onChange={(value) => {
                    const next = { ...recipe.web!, gapMm: num(value) };
                    if (next.gapMm === undefined) delete next.gapMm;
                    set('web', next);
                  }}
                />
                <Text
                  label="Web mm"
                  value={recipe.web.thicknessMm === undefined ? '' : String(recipe.web.thicknessMm)}
                  mono
                  placeholder="derived"
                  title="Thickness of the neck joining the legs; blank = 0.6 × leg Ø, flagged inferred"
                  onChange={(value) => {
                    const next = { ...recipe.web!, thicknessMm: num(value) };
                    if (next.thicknessMm === undefined) delete next.thicknessMm;
                    set('web', next);
                  }}
                />
                <Text label="Web source" value={recipe.web.src} wide onChange={(src) => set('web', { ...recipe.web!, src })} title="Where the web's make-up comes from; say INFERRED when assumed" />
              </div>
            ) : null}
          </section>

          <section className="cs-wb-section" aria-label="lay">
            <header className="cs-wb-head">
              <h3>Lay</h3>
              {lay === undefined ? null : (
                <span className="cs-wb-dim" title="The same ring, read from the other end">
                  {otherEndReading(lay).end === undefined ? '' : `${otherEndReading(lay).end} end reads ${otherEndReading(lay).direction.toUpperCase()}`}
                </span>
              )}
            </header>
            <div className="cs-wb-grid">
              <Pick
                label="Arrangement"
                value={lay?.arrangement ?? ''}
                none="no stated lay"
                options={ARRANGEMENTS}
                onChange={(value) => onChange(withArrangement(recipe, value === '' ? undefined : (value as WireLayOrder['arrangement'])))}
              />
              {lay === undefined ? null : (
                <>
                  <Segmented
                    label="Reads"
                    value={lay.direction}
                    options={[
                      { value: 'ccw', label: 'CCW' },
                      { value: 'cw', label: 'CW' },
                    ]}
                    onChange={(direction) => set('lay', { ...lay, direction })}
                  />
                  <Segmented
                    label="Viewed from"
                    value={lay.viewedFrom}
                    options={[
                      { value: 'source', label: 'source', title: 'looking into the source end' },
                      { value: 'destination', label: 'dest.', title: 'looking into the destination end' },
                    ]}
                    onChange={(viewedFrom) => set('lay', { ...lay, viewedFrom })}
                  />
                  <button
                    type="button"
                    className="cs-small cs-wb-flip"
                    title="Describe the same lay from the other end (the ring reads the other way)"
                    onClick={() => set('lay', flipViewedFrom(lay))}
                  >
                    <IconArrowsExchange size={13} stroke={1.75} /> Other end
                  </button>
                  <Text label="Lay source" value={lay.src} wide onChange={(src) => set('lay', { ...lay, src })} title="Where the colour order is stated — the sheet's cross-section" />
                </>
              )}
            </div>
            {lay === undefined ? null : (
              <ol className="cs-wb-ring" aria-label="ring order">
                {lay.ring.map((id, index) => {
                  const core = recipe.cores.find((c) => c.id === id);
                  return (
                    <li key={id}>
                      <span className="cs-wb-num">{index + 1}</span>
                      <span className="cs-wb-chip" style={{ background: `var(--cond-${core?.colour ?? 'gnd'}, #999)` }} aria-hidden="true" />
                      {core?.colour ?? id}
                    </li>
                  );
                })}
                {lay.center === undefined ? null : (
                  <li>
                    <span className="cs-wb-num">C</span>
                    {recipe.cores.find((c) => c.id === lay.center)?.colour ?? lay.center}
                  </li>
                )}
                {(lay.inner ?? []).map((id, index) => (
                  <li key={id}>
                    <span className="cs-wb-num">C{index + 1}</span>
                    {recipe.cores.find((c) => c.id === id)?.colour ?? id}
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="cs-wb-section" aria-label="bonding">
            <header className="cs-wb-head">
              <h3>Bonded</h3>
            </header>
            {(recipe.bonded ?? []).length === 0 && suggestions.length === 0 ? <p className="cs-wb-empty">No screens in contact.</p> : null}
            <ul className="cs-wb-bonds">
              {(recipe.bonded ?? []).map((bond, index) => (
                <li key={index}>
                  <span className="cs-mono" title={bond.src}>
                    {bond.members.join(' + ')}
                  </span>
                  <button
                    type="button"
                    className="cs-icon-btn cs-small"
                    aria-label="remove this bonded set"
                    title="Not one mass"
                    onClick={() => set('bonded', (recipe.bonded ?? []).filter((_, i) => i !== index))}
                  >
                    <IconTrash size={13} stroke={1.75} />
                  </button>
                </li>
              ))}
              {suggestions.map((members) => (
                <li key={members.join('|')} className="is-suggested">
                  <span className="cs-mono">{members.join(' + ')}</span>
                  <button
                    type="button"
                    className="cs-small"
                    title="The construction says these touch all along the cable — confirm it"
                    onClick={() =>
                      set('bonded', [
                        ...(recipe.bonded ?? []),
                        { members, src: 'Suggested from the construction (wire builder), confirmed by the author' },
                      ])
                    }
                  >
                    Confirm
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </fieldset>
      </div>

      <div className="cs-wb-side">
        <div className="cs-wb-viewtoggle">
          <div className="cs-seg" role="group" aria-label="preview">
            <button type="button" className={classes(preview === 'section' && 'is-active')} aria-pressed={preview === 'section'} title="The cut face: drag cores to arrange the lay" onClick={() => pickPreview('section')}>
              Section
            </button>
            <button type="button" className={classes(preview === '3d' && 'is-active')} aria-pressed={preview === '3d'} title="The stock in 3D, rebuilt as you change it" onClick={() => pickPreview('3d')}>
              3D
            </button>
          </div>
        </div>
        {preview === '3d' ? (
          <LazyWireModel3d wire={compiled.wire} presets={presets} facts={facts} height={280} compact />
        ) : (
          <LayDrawing
            compiled={compiled}
            recipe={recipe}
            onSwap={(a, b) => lay !== undefined && set('lay', swapInLay(lay, a, b))}
            onStep={(id, by) => lay !== undefined && set('lay', stepInRing(lay, id, by))}
          />
        )}
        {warnings.length === 0 ? null : (
          <ul className="cs-wb-warn" role="status">
            {warnings.map((issue, index) => (
              <li key={index}>{issue.message}</li>
            ))}
          </ul>
        )}
        <Derived compiled={compiled} />
      </div>
    </div>
  );
}

export { recipeProblems };

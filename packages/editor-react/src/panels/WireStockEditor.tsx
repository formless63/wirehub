/**
 * The wire-stock editor — the one screen this whole epic is really about.
 *
 * A wire stock is the hardest record in the catalog to type in and the easiest
 * to get subtly wrong: it is a tree of diameters, and a number one place out is
 * a cable that draws, validates, and is not the cable in your hand. So the form
 * is paired with the **live cutaway**: the same `renderCrossSection` the build
 * sheets use, redrawn from the draft as it is typed. You are not filling in
 * fields, you are drawing the cable and watching it appear.
 *
 * The form is deliberately narrower than the model (see `library.ts`): a cable
 * of cores — coax, shielded or a plain insulated conductor — optionally inside
 * an overall shield, a drain and a jacket. That is every stock the catalog
 * holds and every stock the cutaway can draw. A tree richer than that is not
 * flattened or refused; `wireFormOf` says so, and the Library offers the JSON
 * pane instead with a sentence explaining why.
 */

import { LAY_ARRANGEMENT_RING_COUNT, type WireDefinition, type WireLayOrder } from '@cable-studio/model';
import {
  INK,
  conductorPaint,
  crossSectionLayout,
  renderCrossSection,
  type CrossSection,
  type CrossSectionKeyEntry,
  type CrossSectionOptions,
} from '@cable-studio/render-svg';
import { IconZoomIn } from '@tabler/icons-react';
import { useEffect, useMemo, useState, type JSX } from 'react';

import { classes } from '../context.ts';
import {
  blankCoreDraft,
  coreRowsReducer,
  corePaths,
  KNOWN_COLORS,
  wireDefinitionOf,
  wireFormIssues,
  type ConductorDraft,
  type CoreDraft,
  type CoreKind,
  type InsulationDraft,
  type RowAction,
  type ShieldDraft,
  type WireDraft,
} from '../library.ts';
import { distinctValues, useCatalogValues } from '../catalog-values.ts';
import { Choice, Field, FormSection, MmField, RowTools, SrcField } from './fields.tsx';
import { PartNumberField } from './PartNumberField.tsx';
import { Pick as VocabPick } from './Pick.tsx';

/** The catalog's colours first, then the ones the drawings know how to paint. */
function useColors(): string[] {
  const values = useCatalogValues();
  return distinctValues([...values.colors, ...KNOWN_COLORS]);
}

/* ------------------------------------------------------------------ *
 * The cutaway
 * ------------------------------------------------------------------ */

export type CrossSectionRenderer = (
  wire: WireDefinition,
  options?: CrossSectionOptions,
) => string;

export interface CutawayProps {
  /** the stock as the form currently describes it */
  wire: WireDefinition;
  /** debounce in ms; a redraw is a full geometry pass */
  debounceMs?: number;
  /** the renderer, injectable so a test can watch what it is handed */
  render?: CrossSectionRenderer;
}

/** Paint for a legend swatch — the same the drawing uses (render-svg's
 * `ringPaint`: shield metal, jacket ink, else the core's own colour). */
const SHIELD_METAL = '#a7aeb5';
const PLAIN_INSULATION = '#e9edf1';

function swatchPaint(entry: CrossSectionKeyEntry): string {
  if (entry.kind === 'shield') return SHIELD_METAL;
  if (entry.kind === 'jacket') return INK.jacket;
  return entry.colorName === undefined ? PLAIN_INSULATION : conductorPaint(entry.colorName);
}

export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The part of the documentary cutaway worth looking at on screen: the cable
 * and its numbered callouts, the Ø dimension and the ruler — the printed key
 * (tiny beside the circle) is left out and shown as an HTML legend instead.
 */
export function cutawayCrop(cs: CrossSection): Crop {
  // a figure-8 (pci.29) is framed by its two lobes, not its bounding circle
  const lobes = cs.outline?.lobes ?? [{ cx: cs.jacket.cx, cy: cs.jacket.cy, r: cs.jacket.r }];
  const xs: number[] = lobes.flatMap((lobe) => [lobe.cx - lobe.r, lobe.cx + lobe.r]);
  const ys: number[] = lobes.flatMap((lobe) => [lobe.cy - lobe.r, lobe.cy + lobe.r]);
  for (const core of cs.cores) {
    xs.push(core.tagX - 3, core.tagX + 3);
    ys.push(core.tagY - 3, core.tagY + 1.5);
  }
  xs.push(cs.dimension.x1, cs.dimension.x2);
  ys.push(cs.dimension.labelY + 1.2);
  xs.push(cs.ruler.x, cs.ruler.x + cs.ruler.length, cs.ruler.labelX + 10);
  ys.push(cs.ruler.labelY + 1.2);
  const pad = 2;
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
}

/** The renderer's document, re-framed to `crop` and sized by its container. */
export function croppedSvg(svg: string, crop: Crop | undefined): string {
  if (crop === undefined) return svg;
  const box = [crop.x, crop.y, crop.w, crop.h].map((n) => Math.round(n * 100) / 100).join(' ');
  return svg.replace(/<svg\b([^>]*)>/, (_whole, attrs: string) => {
    const kept = attrs
      .replace(/\sviewBox="[^"]*"/, '')
      .replace(/\swidth="[^"]*"/, '')
      .replace(/\sheight="[^"]*"/, '');
    return `<svg${kept} viewBox="${box}">`;
  });
}

/**
 * The cut face of the cable being described.
 *
 * Deliberately the *documentary* renderer and not a second drawing made for
 * this screen: what you see while typing is the picture the build sheet will
 * print, cropped to the cable and scaled to the panel (50a.38 — "the cross
 * section is impossible to read"), with its key printed beside it as a real
 * legend: colour chip, callout number, the key's own words. The key already
 * follows the grounding rules (a foil gets no row; bonded multi-core's bonded core
 * shields are one mass; the drain has its own row), so the legend does too.
 * Hovering a row picks its core out in the drawing; the drawing opens large.
 */
export function Cutaway({
  wire,
  debounceMs = 200,
  render = renderCrossSection,
}: CutawayProps): JSX.Element {
  const [result, setResult] = useState<{ svg: string; cs?: CrossSection } | { error: string }>({
    svg: '',
  });
  const [focus, setFocus] = useState<string | undefined>(undefined);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const svg = render(wire);
        let cs: CrossSection | undefined;
        try {
          cs = crossSectionLayout(wire);
        } catch {
          cs = undefined;
        }
        setResult(cs === undefined ? { svg } : { svg, cs });
      } catch (error) {
        setResult({ error: (error as Error).message });
      }
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [wire, debounceMs, render]);

  const cs = 'error' in result ? undefined : result.cs;
  const drawing = useMemo(
    () => ('error' in result ? '' : croppedSvg(result.svg, cs === undefined ? undefined : cutawayCrop(cs))),
    [result, cs],
  );
  const key = cs?.key ?? [];
  const drawClass = classes('cs-svg', 'cs-cutaway-draw', cs !== undefined && 'is-cropped');
  const escaped = focus === undefined ? '' : focus.replace(/["\\]/g, '\\$&');

  const legend =
    key.length === 0 ? null : (
      <ul className="cs-cutaway-legend" aria-label="cross-section key">
        {key.map((entry, index) => (
          <li
            key={`${entry.tag}-${index}`}
            className={classes(entry.tag !== '' && focus === entry.tag && 'is-focus')}
            onMouseEnter={() => setFocus(entry.tag === '' ? undefined : entry.tag)}
            onMouseLeave={() => setFocus(undefined)}
          >
            <span
              className={classes('cs-cutaway-chip', `is-${entry.kind}`)}
              style={{ background: swatchPaint(entry) }}
              aria-hidden="true"
            />
            <span className="cs-cutaway-tag">{entry.tag}</span>
            <span className="cs-cutaway-text">{entry.text}</span>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="cs-panel cs-cutaway">
      <h2 title="Drawn from what you have typed, by the same renderer the build sheets use. A stock whose diameters are not all filled in yet says so instead of guessing.">
        cross-section
        {drawing === '' ? null : (
          <button
            type="button"
            className="cs-icon-btn cs-cutaway-zoom"
            title="Open large"
            aria-label="Open the cross-section large"
            onClick={() => setZoomed(true)}
          >
            <IconZoomIn size={14} stroke={1.75} />
          </button>
        )}
      </h2>
      {'error' in result ? (
        <p className="cs-error">
          The cutaway could not be drawn yet: {result.error}. The diameters below are what it
          reads.
        </p>
      ) : (
        <>
          {focus === undefined ? null : (
            <style>{`.cs-cutaway-draw .xs-core:not([data-tag="${escaped}"]),.cs-cutaway-draw .xs-callout:not([data-tag="${escaped}"]){opacity:.25}`}</style>
          )}
          {/* the renderer is deterministic and self-contained — no scripts, no
              external references — so its output is safe to mount directly */}
          <div
            className={drawClass}
            role="button"
            tabIndex={0}
            title="Click to open large"
            onClick={() => setZoomed(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setZoomed(true);
              }
            }}
            dangerouslySetInnerHTML={{ __html: drawing }}
          />
          {legend}
        </>
      )}
      {zoomed && !('error' in result) ? (
        <div
          className="cs-modal cs-cutaway-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Cross-section, large"
          onClick={() => setZoomed(false)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setZoomed(false);
          }}
        >
          <div className="cs-modal-card cs-cutaway-card" onClick={(event) => event.stopPropagation()}>
            <header className="cs-cutaway-card-head">
              <strong>{wire.label}</strong>
              <button type="button" autoFocus onClick={() => setZoomed(false)}>
                Close
              </button>
            </header>
            <div className="cs-cutaway-large">
              <div className={drawClass} dangerouslySetInnerHTML={{ __html: drawing }} />
              {legend}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Layers
 * ------------------------------------------------------------------ */

const SHIELD_CONSTRUCTIONS = [
  { value: 'braid', label: 'braid (woven strands)' },
  { value: 'spiral', label: 'spiral serve (wound strands)' },
  { value: 'foil', label: 'foil' },
  { value: 'tape', label: 'tape' },
] as const;

function ConductorFields(props: {
  what: string;
  draft: ConductorDraft;
  onChange: (next: ConductorDraft) => void;
  /** a plain core states the diameter over its own insulation as well */
  insulated: boolean;
}): JSX.Element {
  const { draft, onChange } = props;
  const set = <K extends keyof ConductorDraft>(key: K, value: ConductorDraft[K]): void =>
    onChange({ ...draft, [key]: value });
  const values = useCatalogValues();
  const colors = useColors();
  return (
    <div className="cs-form-grid">
      <Field
        label="Colour"
        say="The colour it is printed or sleeved in — this is what the drawings paint."
        value={draft.color}
        onChange={(value) => set('color', value)}
        options={colors}
        placeholder="red"
      />
      <MmField
        label="Ø over the bare copper"
        say="Across the conductor itself, insulation not counted."
        value={draft.odMm}
        onChange={(value) => set('odMm', value)}
        placeholder="0.36"
      />
      {props.insulated ? (
        <MmField
          label="Ø over its insulation"
          say="This core's insulation is part of the conductor rather than a layer of its own."
          value={draft.insulatedOdMm}
          onChange={(value) => set('insulatedOdMm', value)}
          placeholder="0.9"
        />
      ) : null}
      <Field
        label="Material"
        say="What the strands are."
        value={draft.material}
        onChange={(value) => set('material', value)}
        options={values.conductorMaterials}
        placeholder="OFC copper"
      />
      <Field
        label="Formation"
        say="How the strands are made up, as the spec sheet states it."
        value={draft.formation}
        onChange={(value) => set('formation', value)}
        options={values.conductorFormations}
        placeholder="OFC 7x0.12 mm"
      />
      <Field
        label="Area (mm²)"
        say="Cross-section area, when the spec sheet gives one."
        value={draft.areaMm2}
        onChange={(value) => set('areaMm2', value)}
        placeholder="0.08"
      />
      <Field
        label={`What the ${props.what} is called`}
        say="Shown on the schematic beside the band."
        value={draft.label}
        onChange={(value) => set('label', value)}
        placeholder="Video R centre conductor"
        wide
      />
    </div>
  );
}

function InsulationFields(props: {
  draft: InsulationDraft;
  onChange: (next: InsulationDraft) => void;
  odSay: string;
}): JSX.Element {
  const { draft, onChange } = props;
  const set = <K extends keyof InsulationDraft>(key: K, value: InsulationDraft[K]): void =>
    onChange({ ...draft, [key]: value });
  const values = useCatalogValues();
  const colors = useColors();
  return (
    <div className="cs-form-grid">
      <MmField
        label="Ø over this layer"
        say={props.odSay}
        value={draft.odMm}
        onChange={(value) => set('odMm', value)}
      />
      <Field
        label="Colour"
        say="Leave blank for a layer that is not coloured."
        value={draft.color}
        onChange={(value) => set('color', value)}
        options={colors}
      />
      <Field
        label="Material"
        value={draft.material}
        onChange={(value) => set('material', value)}
        options={values.insulationMaterials}
        placeholder="PVC"
        say="PVC, PPE, PE …"
      />
      <Field
        label="Called"
        value={draft.label}
        onChange={(value) => set('label', value)}
        placeholder="Coax sheath (red)"
        say="Shown in the cutaway key."
      />
    </div>
  );
}

function ShieldFields(props: {
  draft: ShieldDraft;
  onChange: (next: ShieldDraft) => void;
  odSay: string;
}): JSX.Element {
  const { draft, onChange } = props;
  const set = <K extends keyof ShieldDraft>(key: K, value: ShieldDraft[K]): void =>
    onChange({ ...draft, [key]: value });
  const values = useCatalogValues();
  return (
    <div className="cs-form-grid">
      <Choice
        label="Made as"
        say="How the shield is built — the cutaway hatches each one differently."
        value={draft.construction}
        onChange={(value) => set('construction', value as ShieldDraft['construction'])}
        choices={SHIELD_CONSTRUCTIONS}
      />
      <MmField
        label="Ø over the shield"
        say={props.odSay}
        value={draft.odMm}
        onChange={(value) => set('odMm', value)}
      />
      <Field
        label="Coverage"
        say="How much of the surface it covers, as the spec sheet states it."
        value={draft.coveragePct}
        onChange={(value) => set('coveragePct', value)}
        options={values.shieldCoverages}
        placeholder="95-100 %"
      />
      <Field
        label="Material"
        value={draft.material}
        onChange={(value) => set('material', value)}
        options={values.shieldMaterials}
        placeholder="copper"
        say="Copper, tinned copper, aluminium-polyester …"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * One core
 * ------------------------------------------------------------------ */

const CORE_KINDS: { value: CoreKind; label: string; say: string }[] = [
  {
    value: 'coax',
    label: 'coax (conductor · dielectric · shield · sheath)',
    say: 'A miniature coaxial cable: the centre conductor, its dielectric, a shield around it, and a coloured sheath over the lot.',
  },
  {
    value: 'shielded-core',
    label: 'shielded core (conductor · insulation · shield)',
    say: 'An insulated conductor with a shield wound over it, and nothing above that.',
  },
  {
    value: 'plain',
    label: 'plain insulated conductor',
    say: 'One conductor in its own insulation — a power core, an audio whip leg.',
  },
];

function CoreBlock(props: {
  core: CoreDraft;
  index: number;
  count: number;
  onChange: (next: CoreDraft) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
  bad: boolean;
}): JSX.Element {
  const { core, onChange } = props;
  const set = <K extends keyof CoreDraft>(key: K, value: CoreDraft[K]): void =>
    onChange({ ...core, [key]: value });

  const changeKind = (kind: CoreKind): void => {
    // the layers a kind implies, carrying across whatever the old shape had in
    // the same slot — switching coax → shielded must not lose the diameters
    const fresh = blankCoreDraft(kind, core.id);
    onChange({
      ...fresh,
      id: core.id,
      label: core.label,
      src: core.src,
      conductor: { ...core.conductor, id: kind === 'plain' ? core.id : core.conductor.id || 'center' },
      ...(fresh.insulation === undefined
        ? {}
        : { insulation: { ...fresh.insulation, ...(core.insulation ?? {}), id: fresh.insulation.id } }),
      ...(fresh.shield === undefined
        ? {}
        : { shield: { ...fresh.shield, ...(core.shield ?? {}), id: fresh.shield.id } }),
      ...(fresh.sheath === undefined
        ? {}
        : { sheath: { ...fresh.sheath, ...(core.sheath ?? {}), id: fresh.sheath.id } }),
    });
  };

  return (
    <details className={classes('cs-core', props.bad && 'is-bad')} open={props.count <= 2}>
      <summary>
        <span className="cs-core-name">{core.id === '' ? '(unnamed core)' : core.id}</span>
        <span className="cs-core-detail">
          {CORE_KINDS.find((entry) => entry.value === core.kind)?.value}
          {core.conductor.color === '' ? '' : ` · ${core.conductor.color}`}
        </span>
        <RowTools
          index={props.index}
          count={props.count}
          what={`core ${core.id === '' ? props.index + 1 : core.id}`}
          onMove={props.onMove}
          onRemove={props.onRemove}
        />
      </summary>

      <div className="cs-form-grid">
        <Field
          label="Core name"
          say="What the lay order and every solder joint call this core."
          value={core.id}
          onChange={(value) => set('id', value)}
          placeholder="core-red"
          mono
        />
        <Field
          label="Called"
          say="The words the key prints beside it."
          value={core.label}
          onChange={(value) => set('label', value)}
          placeholder="Video R coax (red)"
        />
        <Choice
          label="Built as"
          say={CORE_KINDS.find((entry) => entry.value === core.kind)?.say ?? ''}
          value={core.kind}
          onChange={(value) => changeKind(value as CoreKind)}
          choices={CORE_KINDS}
        />
      </div>

      <h4>Conductor</h4>
      <ConductorFields
        what="conductor"
        draft={core.conductor}
        onChange={(next) => set('conductor', next)}
        insulated={core.kind === 'plain'}
      />

      {core.insulation === undefined ? null : (
        <>
          <h4>{core.kind === 'coax' ? 'Dielectric' : 'Insulation'}</h4>
          <InsulationFields
            draft={core.insulation}
            onChange={(next) => set('insulation', next)}
            odSay="Across the insulation, measured over the conductor inside it."
          />
        </>
      )}

      {core.shield === undefined ? null : (
        <>
          <h4>Shield</h4>
          <ShieldFields
            draft={core.shield}
            onChange={(next) => set('shield', next)}
            odSay="Across the shield, measured over the insulation inside it."
          />
        </>
      )}

      {core.sheath === undefined ? null : (
        <>
          <h4>Sheath</h4>
          <InsulationFields
            draft={core.sheath}
            onChange={(next) => set('sheath', next)}
            odSay="Across the whole core — this is the circle the cutaway draws."
          />
        </>
      )}
    </details>
  );
}

/* ------------------------------------------------------------------ *
 * The editor
 * ------------------------------------------------------------------ */

export interface WireStockEditorProps {
  draft: WireDraft;
  onChange: (next: WireDraft) => void;
  idLocked: boolean;
  /** the cutaway's renderer, injectable for tests */
  render?: CrossSectionRenderer;
  /** debounce for the cutaway redraw */
  debounceMs?: number;
}

export function WireStockEditor(props: WireStockEditorProps): JSX.Element {
  const { draft, onChange } = props;
  const set = <K extends keyof WireDraft>(key: K, value: WireDraft[K]): void =>
    onChange({ ...draft, [key]: value });
  const cores = (action: RowAction<CoreDraft>): void =>
    onChange({ ...draft, cores: coreRowsReducer(draft.cores, action) });

  const issues = wireFormIssues(draft);
  const badCores = new Set(issues.map((issue) => issue.where));
  const paths = corePaths(draft);
  const wire: WireDefinition = wireDefinitionOf(draft);

  const addCore = (kind: CoreKind): void =>
    cores({ type: 'add', row: blankCoreDraft(kind, `core-${draft.cores.length + 1}`) });

  return (
    <div className="cs-wire-editor">
      <div className="cs-wire-form">
        <FormSection title="What this stock is">
          <div className="cs-form-grid">
            <Field
              label="Name"
              say="What a builder calls this reel."
              value={draft.label}
              onChange={(value) => set('label', value)}
              placeholder="Stock name"
              autoFocus
              wide
            />
            <Field
              label="Id"
              say={
                props.idLocked
                  ? 'Fixed: every design that uses this stock refers to it by this id.'
                  : 'Short name used in files and links. Lowercase words joined by hyphens.'
              }
              value={draft.id}
              onChange={(value) =>
                onChange({
                  ...draft,
                  id: value,
                  // the root group is the stock itself; keep them together until
                  // someone deliberately says otherwise
                  ...(draft.structureId === draft.id ? { structureId: value } : {}),
                })
              }
              placeholder="mini-coax"
            />
            <PartNumberField
              say="What you would order the reel by."
              value={draft.partNumber}
              onChange={(value) => set('partNumber', value)}
              placeholder="e.g. WIR-00012"
              kind="wire"
              target={() => ({ kind: 'wire', def: wireDefinitionOf(draft) })}
            />
            <VocabPick
              label="Manufacturer"
              list="manufacturers"
              say="Who makes this wire. Leave blank when it is not known."
              clearable
              noneLabel="not recorded"
              value={draft.manufacturer}
              onChange={(value) => set('manufacturer', value)}
            />
            <Field
              label="Source document"
              say="The document these values were taken from, cited as a source. The generated wire spec sheet is numbered by the part number."
              value={draft.specRef}
              onChange={(value) => set('specRef', value)}
            />
            <MmField
              label="Ø over the jacket"
              say="The finished cable, measured across the outside."
              value={draft.odMm}
              onChange={(value) => set('odMm', value)}
              placeholder="9"
            />
          </div>
          <SrcField value={draft.src} onChange={(value) => set('src', value)} />
        </FormSection>

        <FormSection
          title="Cores"
          say="Every conductor in the cable, one block each. Their order here is the order they are listed — the lay order below is what says where they physically sit."
          right={<span className="cs-count">{draft.cores.length}</span>}
        >
          {draft.cores.length === 0 ? (
            <p className="cs-empty">No cores yet. Add the first one below.</p>
          ) : null}
          {draft.cores.map((core, index) => (
            <CoreBlock
              key={index}
              core={core}
              index={index}
              count={draft.cores.length}
              bad={badCores.has(core.id.trim())}
              onChange={(next) => cores({ type: 'update', index, patch: next })}
              onMove={(by) => cores({ type: 'move', index, by })}
              onRemove={() => cores({ type: 'remove', index })}
            />
          ))}
          <div className="cs-add-row">
            {CORE_KINDS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                className="cs-add"
                onClick={() => addCore(entry.value)}
              >
                + {entry.value === 'plain' ? 'plain conductor' : entry.value}
              </button>
            ))}
          </div>
        </FormSection>

        <FormSection
          title="Over the cores"
          say="What wraps the whole bundle. Every one of these is optional — a whip has none of them."
        >
          <Toggle
            on={draft.overallShield !== undefined}
            label="Overall shield"
            say="A shield around every core at once, as opposed to the shields on individual cores."
            onToggle={(on) =>
              set(
                'overallShield',
                on
                  ? {
                      id: 'overall-shield',
                      label: '',
                      construction: 'foil',
                      material: '',
                      coveragePct: '',
                      odMm: '',
                      src: '',
                    }
                  : undefined,
              )
            }
          >
            {draft.overallShield === undefined ? null : (
              <ShieldFields
                draft={draft.overallShield}
                onChange={(next) => set('overallShield', next)}
                odSay="Across the overall shield, measured over the bundle inside it."
              />
            )}
          </Toggle>

          <Toggle
            on={draft.drain !== undefined}
            label="Drain wire"
            say="A bare wire laid against the shield so it can be soldered. It sits in a valley between cores, not on the ring."
            onToggle={(on) =>
              set(
                'drain',
                on
                  ? {
                      id: 'drain',
                      label: '',
                      color: '',
                      material: '',
                      formation: '',
                      areaMm2: '',
                      odMm: '',
                      insulatedOdMm: '',
                      bare: true,
                      src: '',
                    }
                  : undefined,
              )
            }
          >
            {draft.drain === undefined ? null : (
              <ConductorFields
                what="drain"
                draft={draft.drain}
                onChange={(next) => set('drain', { ...next, bare: true })}
                insulated={false}
              />
            )}
          </Toggle>

          <Toggle
            on={draft.jacket !== undefined}
            label="Jacket"
            say="The outer sheath of the cable. Its diameter is the diameter of the stock."
            onToggle={(on) =>
              set(
                'jacket',
                on
                  ? { id: 'jacket', label: '', material: '', odMm: draft.odMm, color: '', src: '' }
                  : undefined,
              )
            }
          >
            {draft.jacket === undefined ? null : (
              <InsulationFields
                draft={draft.jacket}
                onChange={(next) => set('jacket', next)}
                odSay="The outside of the finished cable — the same number as the stock's overall diameter."
              />
            )}
          </Toggle>
        </FormSection>

        <FormSection
          title="Lay order"
          say="The order the cores are laid in, read off the cut face. This is a fact of the stock, not a drawing choice — a cable laid up in a different order is a different cable."
        >
          <Toggle
            on={draft.lay !== undefined}
            label="This stock has a stated lay order"
            say="Spec sheets that print “adhere to colour order shown” beside a cutaway are stating one."
            onToggle={(on) =>
              set(
                'lay',
                on
                  ? {
                      arrangement: '6-around-1',
                      direction: 'ccw',
                      ring: ['', '', '', '', '', ''],
                      center: '',
                      src: '',
                    }
                  : undefined,
              )
            }
          >
            {draft.lay === undefined ? null : (
              <>
                <div className="cs-form-grid">
                  <Choice
                    label="Arrangement"
                    say="How many cores sit on the ring, and what sits inside it."
                    value={draft.lay.arrangement}
                    onChange={(value) => {
                      const arrangement = value as WireLayOrder['arrangement'];
                      const size = LAY_ARRANGEMENT_RING_COUNT[arrangement];
                      const ring = [...draft.lay!.ring.slice(0, size)];
                      while (ring.length < size) ring.push('');
                      set('lay', { ...draft.lay!, arrangement, ring });
                    }}
                    choices={[
                      { value: '6-around-1', label: '6 around 1' },
                      { value: '7-around-1', label: '7 around 1' },
                      { value: '6-around-2', label: '6 around a centre pair' },
                    ]}
                  />
                  <Choice
                    label="Read"
                    say="Looking into the cut face, starting at 12 o’clock."
                    value={draft.lay.direction}
                    onChange={(value) =>
                      set('lay', { ...draft.lay!, direction: value as 'cw' | 'ccw' })
                    }
                    choices={[
                      { value: 'ccw', label: 'counter-clockwise' },
                      { value: 'cw', label: 'clockwise' },
                    ]}
                  />
                </div>
                <div className="cs-lay-ring">
                  {draft.lay.ring.map((member, index) => (
                    <label key={index} className="cs-field">
                      <span>{index + 1}</span>
                      <select
                        value={member}
                        aria-label={`lay position ${index + 1}`}
                        onChange={(event) => {
                          const ring = [...draft.lay!.ring];
                          ring[index] = event.target.value;
                          set('lay', { ...draft.lay!, ring });
                        }}
                      >
                        <option value="">— pick a core —</option>
                        {paths.map((path) => (
                          <option key={path} value={path}>
                            {path}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <label className="cs-field">
                    <span>centre</span>
                    <select
                      value={draft.lay.center}
                      aria-label="lay centre core"
                      onChange={(event) => set('lay', { ...draft.lay!, center: event.target.value })}
                    >
                      <option value="">— none —</option>
                      {paths.map((path) => (
                        <option key={path} value={path}>
                          {path}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label
                  className="cs-field is-wide"
                  title="The lay order is its own fact and carries its own citation."
                >
                  <span>Lay order source</span>
                  <input
                    value={draft.lay.src}
                    onChange={(event) => set('lay', { ...draft.lay!, src: event.target.value })}
                    placeholder="the sheet's cross-section — “Adhere to color order shown. CCW: White, Yellow, Red…”"
                  />
                </label>
              </>
            )}
          </Toggle>
        </FormSection>

        {issues.length === 0 ? null : (
          <div className="cs-problem" role="status">
            <strong>Worth a second look</strong>
            <ul className="cs-problem-list">
              {issues.map((issue, index) => (
                <li key={index}>
                  <span className="cs-issue-where">{issue.where}</span> {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="cs-wire-preview">
        <Cutaway
          wire={wire}
          {...(props.render === undefined ? {} : { render: props.render })}
          {...(props.debounceMs === undefined ? {} : { debounceMs: props.debounceMs })}
        />
      </div>
    </div>
  );
}

/** A section that is either on or off, with its fields inside it when on. */
function Toggle(props: {
  on: boolean;
  label: string;
  say: string;
  onToggle: (on: boolean) => void;
  children?: JSX.Element | null;
}): JSX.Element {
  return (
    <div className={classes('cs-toggle', props.on && 'is-on')}>
      <label className="cs-toggle-head" title={props.say}>
        <input
          type="checkbox"
          checked={props.on}
          onChange={(event) => props.onToggle(event.target.checked)}
        />
        <span>{props.label}</span>
      </label>
      {props.on ? props.children : null}
    </div>
  );
}

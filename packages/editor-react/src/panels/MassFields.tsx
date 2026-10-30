/**
 * A part's optional mass (`docs/mass.md`): a number in g, kg, oz or lb (a wire stock: per m, km, ft
 * or kft), converted to grams (per metre) as it is typed; only grams are stored. Blank = unknown;
 * 0 is a value. The unit boxes only change how the stored figure is shown.
 */

import {
  MASS_UNIT_GRAMS,
  PER_LENGTH_METRES,
  fromGrams,
  roundMass,
  toGrams,
  toGramsPerMetre,
  type MassUnit,
  type PerLengthUnit,
  type RecordMass,
  type RecordMassPerLength,
} from '@wirehub/model';
import { useState, type JSX } from 'react';

import { Choice, Field } from './fields.tsx';

const MASS_UNITS = Object.keys(MASS_UNIT_GRAMS) as MassUnit[];
const PER_UNITS = Object.keys(PER_LENGTH_METRES) as PerLengthUnit[];

/** The stored figure shown in a unit (grams per metre: per `per`). */
const shown = (g: number | undefined, unit: MassUnit, per?: PerLengthUnit): string =>
  g === undefined ? '' : String(per === undefined ? fromGrams(g, unit) : roundMass(fromGrams(g, unit) * PER_LENGTH_METRES[per]));

const readNumber = (text: string): number | undefined | null => {
  if (text.trim() === '') return undefined;
  const n = Number(text.trim());
  return Number.isFinite(n) && n >= 0 && n <= 1e9 ? n : null;
};

function MassBox(props: {
  figure: number | undefined;
  src: string | undefined;
  perLength: boolean;
  onChange: (figure: number | undefined, src: string | undefined) => void;
}): JSX.Element {
  const [unit, setUnit] = useState<MassUnit>('g');
  const [per, setPer] = useState<PerLengthUnit>('m');
  const perArg = props.perLength ? per : undefined;
  const [text, setText] = useState(() => shown(props.figure, 'g', perArg));
  const [src, setSrc] = useState(props.src ?? '');
  const value = readNumber(text);
  const commit = (next: string, u: MassUnit, p: PerLengthUnit, source: string): void => {
    const n = readNumber(next);
    if (n === null) return;
    const figure = n === undefined ? undefined : props.perLength ? toGramsPerMetre(n, u, p) : toGrams(n, u);
    props.onChange(figure, source.trim() === '' ? undefined : source.trim());
  };
  // a unit change re-shows the stored figure; nothing is re-read
  const reshow = (u: MassUnit, p: PerLengthUnit): void => {
    setUnit(u);
    setPer(p);
    if (value !== null) setText(shown(props.figure, u, props.perLength ? p : undefined));
  };
  return (
    <div className="cs-form-grid" data-testid="mass-fields">
      <Field
        label={props.perLength ? 'Mass per length' : 'Mass'}
        say={props.perLength ? 'What a length of the stock weighs. Blank = unknown; stored as grams per metre.' : 'What one piece weighs. Blank = unknown; stored in grams.'}
        value={text}
        onChange={(next) => {
          setText(next);
          commit(next, unit, per, src);
        }}
        mono
        placeholder="unknown"
        {...(value === null ? { problem: 'A number, 0 or more.' } : {})}
      />
      <Choice label="Unit" value={unit} onChange={(u) => reshow(u as MassUnit, per)} choices={MASS_UNITS.map((u) => ({ value: u, label: u }))} />
      {props.perLength ? <Choice label="Per" value={per} onChange={(p) => reshow(unit, p as PerLengthUnit)} choices={PER_UNITS.map((p) => ({ value: p, label: p }))} /> : null}
      <Field
        label="Mass source"
        say="Where the figure came from: a datasheet weight, a bench weighing."
        value={src}
        onChange={(next) => {
          setSrc(next);
          if (props.figure !== undefined) props.onChange(props.figure, next.trim() === '' ? undefined : next.trim());
        }}
        placeholder="datasheet · weighed"
      />
    </div>
  );
}

/** A piece part's `mass` (connector, component, board, mechanical). */
export function MassFields(props: { mass: RecordMass | undefined; onChange: (mass: RecordMass | undefined) => void }): JSX.Element {
  return (
    <MassBox
      figure={props.mass?.g}
      src={props.mass?.src}
      perLength={false}
      onChange={(g, src) => props.onChange(g === undefined ? undefined : { g, ...(src === undefined ? {} : { src }) })}
    />
  );
}

/** A wire stock's `massPerLength`. */
export function MassPerLengthFields(props: { value: RecordMassPerLength | undefined; onChange: (value: RecordMassPerLength | undefined) => void }): JSX.Element {
  return (
    <MassBox
      figure={props.value?.gPerM}
      src={props.value?.src}
      perLength
      onChange={(gPerM, src) => props.onChange(gPerM === undefined ? undefined : { gPerM, ...(src === undefined ? {} : { src }) })}
    />
  );
}

/** The mass a draft keeps among its extras (the forms of connectors, components, boards and mechanicals). */
export const massOfExtra = (extra: Record<string, unknown> | undefined): RecordMass | undefined => extra?.['mass'] as RecordMass | undefined;

/** `extra` with its mass replaced (or removed); `undefined` when nothing is left. */
export function withExtraMass(extra: Record<string, unknown> | undefined, mass: RecordMass | undefined): Record<string, unknown> | undefined {
  const { mass: _old, ...rest } = extra ?? {};
  const next = mass === undefined ? rest : { ...rest, mass };
  return Object.keys(next).length === 0 ? undefined : next;
}

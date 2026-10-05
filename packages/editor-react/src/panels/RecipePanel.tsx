/**
 * The Recipe tab (`docs/resolver.md`): the devices this cable connects and the
 * resolver choices it was derived from — and whether the design still matches
 * them.
 *
 * - A design with a recipe shows its two ends, the option and stock, and the
 *   drift: every physical difference from the derived body nobody recorded.
 *   **Re-derive** rebuilds the body from the recipe (overrides applied),
 *   **Record as overrides** keeps the hand differences with a reason,
 *   **Detach** makes it a hand design again. Each is one undo step.
 * - A hand design gets **Infer a recipe**: the device pair and option that
 *   reproduce it best, its differences as overrides, adopted on request.
 *
 * Pure model calls (`@wirehub/model` `cable-recipe.ts`) on the live design.
 */

import { useMemo, useState, type JSX } from 'react';
import {
  describeOverride,
  inferCableRecipe,
  optionOf,
  recipeDrift,
  rederive,
  resolve,
  resolveDevice,
  type CableDesign,
  type CableOverride,
  type RecipeInference,
} from '@wirehub/model';

import { useEditorApi } from '../context.ts';
import type { EditorState } from '../store.ts';

const portLabel = (state: EditorState, end: { device: string; port?: string; requirement?: string }): string => {
  if (typeof end.device !== 'string' || end.device === '') return end.requirement === undefined ? '(no device)' : `requirement: ${end.requirement}`;
  const device = resolveDevice(state.db.devices, end.device);
  if (device === undefined) return `${end.device} (not in the library)`;
  const port = device.ports.find((p) => p.id === end.port) ?? device.ports[0];
  return `${device.label} · ${port?.label ?? port?.id ?? '?'}`;
};

/** How many differences the design has from its recipe (the tab's badge); 0 for a hand design. */
export function recipeDriftCount(design: CableDesign, state: Pick<EditorState, 'db'>): number {
  if (design.recipe === undefined) return 0;
  const drift = recipeDrift(design, state.db);
  return drift.differences.length + drift.misses.length;
}

export function RecipePanel({ state, readOnly }: { state: EditorState; readOnly?: boolean }): JSX.Element {
  const { dispatch } = useEditorApi();
  const design = state.design;
  const recipe = design.recipe;
  const drift = useMemo(() => (recipe === undefined ? undefined : recipeDrift(design, state.db)), [design, recipe, state.db]);
  const option = useMemo(() => {
    if (recipe === undefined) return undefined;
    return optionOf(resolve(state.db, { source: recipe.source, destination: recipe.destination }), recipe.option);
  }, [recipe, state.db]);
  const [inference, setInference] = useState<RecipeInference | undefined>(undefined);

  const apply = (next: CableDesign, description: string): void => dispatch({ type: 'apply-design', design: next, description });

  if (recipe === undefined) {
    return (
      <div className="cs-panel cs-recipe" data-testid="recipe-panel">
        <h2>recipe</h2>
        <div className="cs-scroll">
          <p className="cs-empty">A hand design: no devices or resolver choices recorded.</p>
          {(state.db.devices ?? []).length === 0 ? (
            <p className="cs-hint">The library has no device profiles yet, so no recipe can be inferred.</p>
          ) : (
            <button type="button" className="cs-quiet" onClick={() => setInference(inferCableRecipe(design, state.db))}>
              Infer a recipe
            </button>
          )}
          {inference === undefined ? null : inference.ok ? (
            <div className="cs-recipe-inferred" data-testid="recipe-inferred">
              <p>
                {portLabel(state, inference.recipe.source)} → {portLabel(state, inference.recipe.destination)}: option <code>{inference.recipe.option}</code>,{' '}
                {inference.state === 'identical' ? 'reproduces this design exactly' : `${inference.differences} difference${inference.differences === 1 ? '' : 's'} kept as overrides`}.
              </p>
              {readOnly ? null : (
                <button type="button" className="cs-primary" onClick={() => apply({ ...design, recipe: inference.recipe }, 'adopted an inferred recipe')}>
                  Adopt this recipe
                </button>
              )}
            </div>
          ) : (
            <p className="cs-hint" data-testid="recipe-inferred">No recipe: {inference.reason}.</p>
          )}
        </div>
      </div>
    );
  }

  const overrides = recipe.overrides ?? [];
  const recordDifferences = (): void => {
    if (drift === undefined) return;
    const kept: CableOverride[] = drift.differences.map((d) => ({ ...d, reason: 'hand-edit' }) as CableOverride);
    const live = overrides.filter((_, i) => !drift.misses.some((m) => m.index === i));
    apply({ ...design, recipe: { ...recipe, overrides: [...live, ...kept] } }, `recorded ${kept.length} difference${kept.length === 1 ? '' : 's'} as recipe overrides`);
  };
  const again = (): void => {
    const out = rederive(design, state.db);
    if (out.ok) apply(out.design, 're-derived from the recipe');
  };
  const detach = (): void => {
    const { recipe: _gone, ...rest } = design;
    apply(rest as CableDesign, 'detached the recipe');
  };
  const dropOverride = (index: number): void => {
    const next = overrides.filter((_, i) => i !== index);
    apply({ ...design, recipe: { ...recipe, ...(next.length === 0 ? { overrides: undefined } : { overrides: next }) } }, 'removed a recipe override');
  };

  return (
    <div className="cs-panel cs-recipe" data-testid="recipe-panel">
      <h2>recipe</h2>
      <div className="cs-scroll">
        <dl className="cs-recipe-ends">
          <dt>source</dt>
          <dd>{portLabel(state, recipe.source)}</dd>
          <dt>destination</dt>
          <dd>{portLabel(state, recipe.destination)}</dd>
          <dt>option</dt>
          <dd>
            {option?.label ?? recipe.option ?? 'the top-ranked'} {recipe.option === undefined ? null : <code>{recipe.option}</code>}
          </dd>
          {recipe.stock === undefined ? null : (
            <>
              <dt>stock</dt>
              <dd>{state.db.wires.find((w) => w.id === recipe.stock)?.label ?? recipe.stock}</dd>
            </>
          )}
        </dl>
        {option === undefined ? null : (
          <>
            {option.hazards.map((h) => (
              <p key={h.message} className="cs-warn" role="note">
                {h.message}
              </p>
            ))}
            {option.missing.map((m) => (
              <p key={m.message} className="cs-err" role="note">
                Missing: {m.message}
              </p>
            ))}
          </>
        )}
        <h3 data-state={drift?.state}>
          {drift === undefined || drift.state === 'in-step'
            ? 'In step with the recipe'
            : drift.state === 'unresolved'
              ? `Cannot derive: ${drift.reason ?? ''}`
              : `${drift.differences.length + drift.misses.length} difference${drift.differences.length + drift.misses.length === 1 ? '' : 's'} not recorded`}
        </h3>
        {drift === undefined || drift.differences.length === 0 ? null : (
          <ul className="cs-recipe-drift" aria-label="Differences from the recipe">
            {drift.differences.map((d, i) => (
              <li key={i}>{describeOverride(d)}</li>
            ))}
          </ul>
        )}
        {drift === undefined || drift.misses.length === 0 ? null : (
          <ul className="cs-recipe-drift" aria-label="Overrides that no longer apply">
            {drift.misses.map((m) => (
              <li key={m.index}>override {m.index + 1}: {m.message}</li>
            ))}
          </ul>
        )}
        {overrides.length === 0 ? null : (
          <>
            <h3>overrides</h3>
            <ol className="cs-recipe-overrides">
              {overrides.map((o, i) => (
                <li key={i}>
                  {describeOverride(o)} <small>({o.reason})</small>
                  {readOnly ? null : (
                    <button type="button" className="cs-quiet" aria-label={`Remove override ${i + 1}`} onClick={() => dropOverride(i)}>
                      remove
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </>
        )}
        {readOnly ? null : (
          <div className="cs-recipe-actions">
            <button type="button" className="cs-quiet" disabled={drift?.state !== 'drift'} onClick={recordDifferences}>
              Record as overrides
            </button>
            <button type="button" className="cs-quiet" disabled={drift?.state === 'unresolved' || drift?.state === 'in-step'} onClick={again}>
              Re-derive
            </button>
            <button type="button" className="cs-quiet" onClick={detach}>
              Detach
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

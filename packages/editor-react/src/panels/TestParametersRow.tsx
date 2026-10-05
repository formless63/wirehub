/**
 * The continuity spec's test parameters: threshold, isolation and hipot
 * voltage and dwell. Stored per design in the drawing sidecar's `test` field
 * through the same Save as the sheet options; a blank field takes the
 * organisation's default (shown as the placeholder), then the base's.
 */

import {
  TEST_PARAMETER_KEYS,
  TEST_PARAMETER_LABELS,
  resolveTestParameters,
  type DrawingMeta,
  type TestParameters,
} from '@wirehub/docs';
import type { JSX } from 'react';

export interface TestParametersRowProps {
  meta: DrawingMeta;
  onMeta: (meta: DrawingMeta) => void;
  /** the organisation's defaults */
  defaults?: TestParameters;
}

/** `meta` with one parameter set; a blank or non-positive entry is removed, not stored. */
export function withTestParameter(meta: DrawingMeta, key: keyof TestParameters, text: string): DrawingMeta {
  const test: TestParameters = { ...(meta.test ?? {}) };
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value) || value <= 0) delete test[key];
  else test[key] = value;
  const next = { ...meta };
  if (Object.keys(test).length === 0) delete next.test;
  else next.test = test;
  return next;
}

export function TestParametersRow({ meta, onMeta, defaults }: TestParametersRowProps): JSX.Element {
  const base = resolveTestParameters(undefined, defaults);
  return (
    <div className="cs-sheet-options cs-test-parameters" role="group" aria-label="Test parameters">
      {TEST_PARAMETER_KEYS.map((key) => {
        const { label, unit } = TEST_PARAMETER_LABELS[key];
        const fallback = base[key];
        return (
          <label key={key} className="cs-sheet-stamp" title={`${label} (${unit})`}>
            {label} ({unit})
            <input
              type="number"
              min="0"
              step="any"
              className="cs-input cs-sheet-short"
              aria-label={label}
              value={meta.test?.[key] ?? ''}
              placeholder={fallback === undefined ? 'off' : String(fallback)}
              onChange={(e) => onMeta(withTestParameter(meta, key, e.target.value))}
            />
          </label>
        );
      })}
    </div>
  );
}

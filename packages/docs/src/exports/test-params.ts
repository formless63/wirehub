/**
 * Test parameters: what a tester is told to apply when it runs the continuity
 * spec. They are settings, not electrical facts of the cable, so they live with
 * the design's document settings (the drawing sidecar's `test`), never in the
 * model.
 *
 * Three layers, later wins: the built-in defaults below, the organisation's
 * defaults (`WIREHUB_TEST_DEFAULTS` on the server), the design's own.
 */

export interface TestParameters {
  /** a continuity reading at or below this resistance passes (Ω) */
  continuityOhmsMax?: number;
  /** DC voltage applied between nets that must be isolated (V) */
  isolationVolts?: number;
  /** an isolation reading at or above this resistance passes (MΩ) */
  isolationMinMohm?: number;
  /** how long the isolation voltage is held (s) */
  isolationSeconds?: number;
  /** withstand (hipot) test voltage (V); absent = no hipot step */
  hipotVolts?: number;
  /** how long the hipot voltage is held (s) */
  hipotSeconds?: number;
  /** a hipot leakage above this fails (µA) */
  hipotMaxMicroamps?: number;
}

export type ResolvedTestParameters = Required<Pick<TestParameters, 'continuityOhmsMax' | 'isolationVolts' | 'isolationMinMohm' | 'isolationSeconds'>> &
  Pick<TestParameters, 'hipotVolts' | 'hipotSeconds' | 'hipotMaxMicroamps'>;

/** The base's defaults: the 5 Ω the continuity spec's wording is written for, a low-voltage isolation test, no hipot. */
export const DEFAULT_TEST_PARAMETERS: ResolvedTestParameters = {
  continuityOhmsMax: 5,
  isolationVolts: 100,
  isolationMinMohm: 10,
  isolationSeconds: 1,
};

export const TEST_PARAMETER_KEYS = [
  'continuityOhmsMax',
  'isolationVolts',
  'isolationMinMohm',
  'isolationSeconds',
  'hipotVolts',
  'hipotSeconds',
  'hipotMaxMicroamps',
] as const satisfies readonly (keyof TestParameters)[];

export const TEST_PARAMETER_LABELS: Readonly<Record<keyof TestParameters, { label: string; unit: string }>> = {
  continuityOhmsMax: { label: 'Continuity threshold (max)', unit: 'Ω' },
  isolationVolts: { label: 'Isolation test voltage', unit: 'V DC' },
  isolationMinMohm: { label: 'Isolation resistance (min)', unit: 'MΩ' },
  isolationSeconds: { label: 'Isolation dwell', unit: 's' },
  hipotVolts: { label: 'Hipot voltage', unit: 'V' },
  hipotSeconds: { label: 'Hipot duration', unit: 's' },
  hipotMaxMicroamps: { label: 'Hipot leakage (max)', unit: 'µA' },
};

/** Validate untrusted parameters; unknown keys and non-positive numbers are problems. */
export function readTestParameters(value: unknown): { ok: true; parameters: TestParameters } | { ok: false; problems: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, problems: ['test must be an object of fields.'] };
  }
  const problems: string[] = [];
  const parameters: TestParameters = {};
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(TEST_PARAMETER_KEYS as readonly string[]).includes(key)) problems.push(`'test.${key}' is not a test parameter.`);
  }
  for (const key of TEST_PARAMETER_KEYS) {
    const field = input[key];
    if (field === undefined) continue;
    if (typeof field !== 'number' || !Number.isFinite(field) || field <= 0 || field > 1e9) problems.push(`test.${key} must be a positive number.`);
    else parameters[key] = field;
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, parameters };
}

/** Built-in defaults, then the organisation's, then the design's. */
export function resolveTestParameters(design?: TestParameters, organisation?: TestParameters): ResolvedTestParameters {
  const merged: Record<string, number> = { ...DEFAULT_TEST_PARAMETERS };
  for (const layer of [organisation, design]) {
    for (const key of TEST_PARAMETER_KEYS) {
      const v = layer?.[key];
      if (v !== undefined) merged[key] = v;
    }
  }
  return merged as unknown as ResolvedTestParameters;
}

/** The parameters as printable `[label, value]` lines, hipot only when set. */
export function testParameterLines(parameters: ResolvedTestParameters): [string, string][] {
  const out: [string, string][] = [];
  for (const key of TEST_PARAMETER_KEYS) {
    const v = parameters[key];
    if (v === undefined) continue;
    out.push([TEST_PARAMETER_LABELS[key].label, `${v} ${TEST_PARAMETER_LABELS[key].unit}`]);
  }
  return out;
}

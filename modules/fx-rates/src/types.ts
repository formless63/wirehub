/** Reference rates are currency units for one euro, never transaction quotes. */
export interface FxSnapshot {
  base: 'EUR';
  date: string;
  rates: Record<string, number>;
  source: string;
  retrievedAt: string;
}
export interface FxSettings { schema: 1; snapshot: FxSnapshot; target: string; builds?: number }

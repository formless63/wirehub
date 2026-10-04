/**
 * jsdom does no layout — every element's `offsetWidth`/`offsetHeight` (and
 * `getBoundingClientRect()`) report 0, which starves `@tanstack/react-virtual`
 * of a viewport to compute a visible range from: the cables list
 * (`CablesRoute.tsx`) would render zero rows in every dom test that reaches
 * it. A fixed, generous size is close enough — these tests assert on *which*
 * rows exist and how they behave, never on real pixel geometry.
 */
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1024 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 768 });

/**
 * jsdom has no `ResizeObserver` — `cmdk`'s `Command.List` (the quick-open
 * palette,) uses one to track its own height. A no-op
 * stub is enough: these tests never assert on the `--cmdk-list-height` CSS
 * variable it drives, only on which rows are present.
 */
class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoopResizeObserver;

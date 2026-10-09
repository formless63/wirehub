import { configure } from "@testing-library/react";

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

/**
 * Testing Library's `waitFor`/`findBy*` give up after 1000 ms by default, a
 * budget unrelated to this suite's per-test budget (15 s, `vitest.config.ts`).
 * The first mount in a file pays the cold costs (route modules, the depiction
 * glob, the first render of the whole shell), which a loaded shared box
 * stretches past a second: the assertion then fails with "Unable to find
 * [data-testid=open-id]" after ~1 s while the app was merely still mounting
 * (cs-az3; reproduced under 8 busy-loop processes on 4 cores, failing 2.7 s
 * into a 15 s test). The wait is on an element or state, never a sleep, so a
 * long ceiling costs nothing when things are fast; a real failure still ends
 * at the test timeout.
 */
configure({ asyncUtilTimeout: 10_000 });

/** The bits of the platform Radix pokes (Select, Popover) that jsdom lacks. */
if (typeof Element !== 'undefined') {
  Object.assign(Element.prototype, {
    hasPointerCapture: Element.prototype.hasPointerCapture ?? (() => false),
    setPointerCapture: Element.prototype.setPointerCapture ?? (() => undefined),
    releasePointerCapture: Element.prototype.releasePointerCapture ?? (() => undefined),
    scrollIntoView: Element.prototype.scrollIntoView ?? (() => undefined),
  });
}

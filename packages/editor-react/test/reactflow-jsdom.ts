/**
 * The browser APIs React Flow measures with, which jsdom does not implement.
 * Imported by the mount test only — the store and derivation tests need none of
 * this, which is the point of keeping the model out of the canvas.
 */

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

class StubDOMMatrixReadOnly {
  m22 = 1;
  constructor(transform?: string) {
    const parts = transform?.match(/matrix\((.+)\)/)?.[1]?.split(', ');
    this.m22 = parts === undefined ? 1 : Number(parts[3] ?? 1);
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals['ResizeObserver'] = StubResizeObserver;
globals['DOMMatrixReadOnly'] = StubDOMMatrixReadOnly;

Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: {
    get(this: HTMLElement) {
      return Number.parseFloat(this.style.height) || 120;
    },
    configurable: true,
  },
  offsetWidth: {
    get(this: HTMLElement) {
      return Number.parseFloat(this.style.width) || 200;
    },
    configurable: true,
  },
});

(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
  ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;

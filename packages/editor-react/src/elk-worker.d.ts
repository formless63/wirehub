/**
 * elkjs's in-process layout engine (the "fake worker" its bundled build
 * wraps). It ships untyped; `elk.ts` narrows what it needs.
 */
declare module 'elkjs/lib/elk-worker.min.js' {
  const engine: unknown;
  export default engine;
}

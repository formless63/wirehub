/**
 * Browser stand-in for the `node:fs` / `node:url` / `node:path` bindings that
 * `@cable-studio/catalog` (and, through it, `layout`/`render-svg`) import at
 * module scope for the depiction tree.
 *
 * Nothing in the studio calls them: catalog data comes from the workbench API
 * (`catalog.browser.ts`), and the preview renders with a
 * browser `DepictionSource`. The
 * shim exists so the *import* links in a browser; a real read fails loudly
 * rather than silently returning junk.
 */

function unavailable(name: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(
      `${name}() is not available in the browser — the studio loads catalog data as JSON`,
    );
  };
}

export const readFileSync = unavailable('readFileSync');
export const readdirSync = unavailable('readdirSync');
/** no depiction tree in the browser, so nothing on disk exists */
export const existsSync = (): boolean => false;
export const fileURLToPath = (url: string | URL): string => String(url);
export const join = (...parts: string[]): string => parts.join('/');

export default { readFileSync, readdirSync, existsSync, fileURLToPath, join };

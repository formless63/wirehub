/**
 * Browser stand-in for the `node:fs` / `node:url` / `node:path` bindings that
 * `@wirehub/catalog` (and, through it, `layout`/`render-svg`) import at
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
// the catalog's pack installer writes files: server only
export const writeFileSync = unavailable('writeFileSync');
export const mkdirSync = unavailable('mkdirSync');
export const renameSync = unavailable('renameSync');
/** no depiction tree in the browser, so nothing on disk exists */
export const existsSync = (): boolean => false;
export const fileURLToPath = (url: string | URL): string => String(url);
export const join = (...parts: string[]): string => parts.join('/');
export const dirname = (path: string): string => path.replace(/\/[^/]*$/, '');

export default { readFileSync, readdirSync, writeFileSync, mkdirSync, renameSync, existsSync, fileURLToPath, join, dirname };

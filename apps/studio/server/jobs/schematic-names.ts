/**
 * Schematic sheet names for the board KiCad check (`board-outputs.ts`).
 *
 * A root sheet names its sub-sheets by file name, so the tool pack must see every sheet under the
 * name it was designed with: spaces, parentheses, accents and all. The catalog document a sheet is
 * kept as cannot carry such a name (`isDocPath`), so it is stored under its sha256 and the name in
 * base64url, which decodes back to the original exactly:
 *
 *   data/model-sources/<sha256>.<base64url name without .kicad_sch>.kicad_sch.txt
 *
 * Older checks stored `<sha256>-<plain name>.txt`; those still read.
 */

/** A schematic file name the check accepts: one path segment ending `.kicad_sch`, no control characters. */
export function isSchematicFileName(name: string): boolean {
  if (name.length > 200 || !name.endsWith('.kicad_sch') || name === '.kicad_sch') return false;
  if (name.startsWith('.') || name !== name.trim()) return false;
  // a path separator, NUL or any control character would let the name leave the sheet folder
  // eslint-disable-next-line no-control-regex
  return !/[/\\\u0000-\u001f\u007f]/.test(name) && !name.split(/[/\\]/).includes('..');
}

const STEM = '.kicad_sch';

/** The catalog document a sheet's text is kept as. */
export function schematicDocPath(dir: string, sha: string, fileName: string): string {
  const stem = fileName.slice(0, -STEM.length);
  return `${dir}/${sha}.${Buffer.from(stem, 'utf8').toString('base64url')}${STEM}.txt`;
}

/** The sheet's own file name, read back from its document path (new or old form); `undefined` when it is not one. */
export function schematicNameOf(path: string): string | undefined {
  const encoded = /\/[0-9a-f]{64}\.([A-Za-z0-9_-]+)\.kicad_sch\.txt$/.exec(path)?.[1];
  const name = encoded !== undefined ? `${Buffer.from(encoded, 'base64url').toString('utf8')}${STEM}` : /\/[0-9a-f]{64}-([^/]+\.kicad_sch)\.txt$/.exec(path)?.[1];
  return name !== undefined && isSchematicFileName(name) ? name : undefined;
}

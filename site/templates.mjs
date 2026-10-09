// The generator's inputs (compose.yaml and the bundled domain modules), read
// with node built-ins only so CI can check the generator without an install.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The bundled domain modules, in the order the app's manifest lists them. */
export function readModules(repoRoot = root) {
  const manifest = readFileSync(join(repoRoot, 'apps/studio/modules.config.ts'), 'utf8');
  const imports = new Map([...manifest.matchAll(/^import \{ (\w+) \} from '@wirehub\/module-([a-z0-9-]+)';$/gm)].map((m) => [m[1], m[2]]));
  const list = /^export const modules[^=]*= \[([^\]]*)\]/m.exec(manifest)?.[1] ?? '';
  const ids = list.split(',').map((name) => imports.get(name.trim())).filter((id) => id !== undefined && readdirSync(join(repoRoot, 'modules')).includes(id));
  // only domain modules (a `setup` contribution) are offered by the generator
  const domains = ids.filter((id) => /\n\s+setup:\s*\{/.test(readFileSync(join(repoRoot, 'modules', id, 'src/index.ts'), 'utf8')));
  return domains.map((id) => {
    const source = readFileSync(join(repoRoot, 'modules', id, 'src/index.ts'), 'utf8');
    const label = /\n\s+label: '([^']+)'/.exec(source)?.[1];
    const description = /\n\s+description:\s*'([^']+)'/.exec(source)?.[1];
    if (label === undefined || description === undefined) throw new Error(`modules/${id}: no label or setup description found`);
    return { id, label, description };
  });
}

/** What the generator works from. */
export function readTemplates(repoRoot = root) {
  return { compose: readFileSync(join(repoRoot, 'compose.yaml'), 'utf8'), modules: readModules(repoRoot) };
}

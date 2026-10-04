/**
 * Imported first by the standalone server (`serve.ts`), for its side effect:
 * the environment is prepared (`prepareHostEnv`: `*_FILE` variables read,
 * `WIREHUB_PACKS_DIR` defaulted) before any other module is evaluated, so no
 * reader ever sees an unresolved variable. A secret file that cannot be read
 * stops the server with one line naming it.
 */

import { prepareHostEnv } from './env.ts';

const fileEnv = prepareHostEnv(process.env);
if (fileEnv.errors.length > 0) {
  for (const error of fileEnv.errors) console.error(`[env] ${error}`);
  process.exit(1);
}
if (fileEnv.loaded.length > 0) console.log(`[env] read from files: ${fileEnv.loaded.join(', ')}`);

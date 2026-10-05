/**
 * An example module importer for the job tests (Postgres plan task C2): a
 * CSV of mechanical parts (`id,label,partNumber,kind` per line) proposed as
 * `mechanicals` records — new ones added, known ids replaced. Synthetic.
 */

import { createRegistry, defineModule, type ModuleRegistry } from '@wirehub/modules';

export const exampleImporterModule = defineModule({
  id: 'example-parts',
  label: 'Example parts importer',
  version: '0.0.1',
  importers: [
    {
      id: 'mechanicals-csv',
      label: 'Mechanical parts (CSV)',
      accepts: ['.parts.csv'],
      import(input) {
        const lines = new TextDecoder()
          .decode(input.bytes)
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '' && !l.startsWith('#'));
        const mechanicals = lines.map((line) => {
          const [id, label, partNumber, kind] = line.split(',').map((c) => c.trim());
          return { id: id!, label: label!, partNumber: partNumber!, kind: kind!, src: `synthetic example: imported from ${input.fileName}` };
        });
        return { definitions: { mechanicals: mechanicals as never }, notes: [`${mechanicals.length} part(s) read from ${input.fileName}`] };
      },
    },
  ],
});

export const exampleRegistry: ModuleRegistry = createRegistry([exampleImporterModule]);

/** One new part and one change to a starter part (its label). */
export const EXAMPLE_CSV = ['# id,label,partNumber,kind', 'hd15-backshell-test,HD-15 backshell (imported),SHL-00090,shell', 'de9-backshell,DE-9 metal backshell (re-imported label),SHL-00001,shell'].join('\n');

export const EXAMPLE_FILE = 'example.parts.csv';

export function exampleBody(csv = EXAMPLE_CSV): { fileName: string; data: string } {
  return { fileName: EXAMPLE_FILE, data: Buffer.from(csv).toString('base64') };
}

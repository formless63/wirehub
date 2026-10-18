/** A genuine native-format input and importer output; the board itself is explicitly synthetic. */
import { createHash } from 'node:crypto';
import { kicadBoardImporter } from '@wirehub/module-board-import';
import { loadDb } from '@wirehub/catalog';
import type { Db } from '@wirehub/model';
import { kicadPcb } from '../../../modules/board-import/test/synthetic.ts';

export async function representationFixture(db: Db = loadDb()) {
  const native = new TextEncoder().encode(kicadPcb());
  const result = await kicadBoardImporter.import({ fileName: 'synthetic-adapter.kicad_pcb', bytes: native }, db);
  const board = result.definitions!.pcbas![0]!;
  const depiction = result.depictions![0]!;
  return { native, board, depiction, sourceHash: createHash('sha256').update(native).digest('hex') };
}

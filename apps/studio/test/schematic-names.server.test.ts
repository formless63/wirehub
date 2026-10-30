import { describe, expect, it } from 'vitest';

import { isDocPath } from '../server/storage/doc-store.ts';
import { isSchematicFileName, schematicDocPath, schematicNameOf } from '../server/jobs/schematic-names.ts';

const SHA = 'a'.repeat(64);

describe('schematic sheet names (board KiCad check)', () => {
  it('keeps a real file name exactly, under a safe document path', () => {
    for (const name of ['Main board (rev 2).kicad_sch', 'Power supply.kicad_sch', 'Überblick – v1.kicad_sch', 'plain.kicad_sch']) {
      expect(isSchematicFileName(name)).toBe(true);
      const path = schematicDocPath('data/model-sources', SHA, name);
      expect(isDocPath(path)).toBe(true);
      expect(schematicNameOf(path)).toBe(name);
    }
    // the older form still reads
    expect(schematicNameOf(`data/model-sources/${SHA}-Old sheet.kicad_sch.txt`)).toBe('Old sheet.kicad_sch');
  });

  it('refuses a name that could leave the sheet folder', () => {
    for (const name of ['../x.kicad_sch', 'a/b.kicad_sch', 'a\\b.kicad_sch', '..kicad_sch', '.kicad_sch', '.hidden.kicad_sch', 'a\u0000b.kicad_sch', 'a\nb.kicad_sch', 'board.kicad_pcb', ' padded.kicad_sch']) {
      expect(isSchematicFileName(name)).toBe(false);
    }
    // a stored path whose name decodes to a traversal is not read back as a sheet
    const evil = `data/model-sources/${SHA}.${Buffer.from('../../etc/passwd', 'utf8').toString('base64url')}.kicad_sch.txt`;
    expect(schematicNameOf(evil)).toBeUndefined();
  });
});

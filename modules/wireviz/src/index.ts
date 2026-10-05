/**
 * WireViz interop module (cs-5k1.18): import a WireViz YAML harness as a
 * reviewable design (the importer runs as a job where the studio runs jobs, and
 * its plan is reviewed and published as one change set) and export a design to
 * WireViz YAML. MIT, like every bundled module; the YAML mapping is written from
 * WireViz's public syntax documentation, and none of WireViz's (GPL-3.0) code is
 * used or copied.
 */

import { defineModule } from '@wirehub/modules';

import { exportWireViz } from './export.ts';
import { importWireViz } from './import.ts';

export { exportWireViz } from './export.ts';
export { importWireViz } from './import.ts';
export { colourFromCode, colourToCode, gaugeToMm2, lengthToMm } from './colours.ts';

export const MODULE_ID = 'wireviz';

export const wireviz = defineModule({
  id: MODULE_ID,
  label: 'WireViz interop',
  version: '0.1.0',
  license: 'MIT',
  importers: [
    {
      id: 'wireviz-yaml',
      label: 'WireViz harness (YAML)',
      accepts: ['.yml', '.yaml'],
      import: (input, db) => importWireViz(input.fileName, input.bytes, db),
    },
  ],
  exporters: [
    {
      id: 'wireviz-yaml',
      label: 'WireViz (YAML)',
      description: 'The design as a WireViz harness: connectors, cables, colours and connections. What WireViz cannot say is listed at the top.',
      render: (design, db) => exportWireViz(design, db),
    },
  ],
});

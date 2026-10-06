/**
 * What a host can add to the editor without the editor knowing about modules
 * (`docs/modules.md`): extra panels in two places and extra document exports.
 * The host (apps/studio) fills these from its module registry; this package
 * only defines where they go.
 */

import type { TestParameters } from '@wirehub/docs';
import type { CableDesign, Db } from '@wirehub/model';
import type { ReactNode } from 'react';

/** What a slot's renderer is told about the cable on screen. */
export interface EditorSlotContext {
  /** the live design in the editor (the revision shown, in Documents) */
  design: CableDesign;
  db: Db;
  /** a read-only view: no writes from the panel */
  readOnly: boolean;
  /** Replace the editable draft through the editor history. Absent on immutable document views. */
  onChange?: (design: CableDesign, description?: string) => void;
}

/** A file a document exporter produced. */
export interface ExtraDocumentOutput {
  mimeType: string;
  fileName: string;
  body: string | Uint8Array;
}

/** An export the Documents view offers beside Print: one button, one download. */
export interface ExtraExporter {
  id: string;
  label: string;
  /** one sentence, the button's tooltip */
  description?: string;
  /** `context`: the Documents view's test parameters, for an exporter that writes a tester's format */
  render(design: CableDesign, db: Db, context?: ExtraExportContext): ExtraDocumentOutput | Promise<ExtraDocumentOutput>;
}

/** What the Documents view knows that an exporter may need besides the design. */
export interface ExtraExportContext {
  /** the design's own test parameters (the drawing sidecar's `test`) */
  testParameters?: TestParameters;
  /** the organisation's defaults under them */
  testDefaults?: TestParameters;
}

export interface EditorExtensions {
  /** appended to the inspector column (the cable's right-hand side) */
  inspector?: (context: EditorSlotContext) => ReactNode;
  /** shown under the Documents tabs */
  documents?: (context: EditorSlotContext) => ReactNode;
  /** extra export buttons in the Documents toolbar */
  exporters?: readonly ExtraExporter[];
}

/** Save an export's file through the browser (a Blob and a temporary link). */
export function downloadOutput(output: ExtraDocumentOutput): void {
  const part = typeof output.body === 'string' ? output.body : (output.body.buffer.slice(output.body.byteOffset, output.body.byteOffset + output.body.byteLength) as ArrayBuffer);
  const url = URL.createObjectURL(new Blob([part], { type: output.mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = output.fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

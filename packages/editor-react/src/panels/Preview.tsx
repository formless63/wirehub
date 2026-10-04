/**
 * The live schematic preview.
 *
 * This pane is the whole "authoring canvas ≠ schematic renderer" split made
 * concrete: the same committed design that draws the React Flow graph is handed
 * to `renderSchematic`, and what comes back is the deterministic documentary
 * drawing — a different visual language, from the same single source of truth.
 *
 * Depictions are off by default: `true` makes the renderer read the catalog's
 * artwork tree from disk, which a browser cannot do. A host that has the
 * artwork by other means (the studio bundles it with Vite) passes a
 * `DepictionSource` instead and gets the real board pictures. Either way a
 * block whose definition has no usable artwork falls back to the abstract
 * pin-row form, which is always correct.
 */

import type { CableDesign, Db } from '@wirehub/model';
import { renderSchematic, type DepictionSource } from '@wirehub/render-svg';
import { useEffect, useState, type JSX } from 'react';

export interface PreviewProps {
  design: CableDesign;
  db: Db;
  /** debounce in ms; the render is a full layout pass */
  debounceMs?: number;
  /** `false` (default) abstract blocks · `true` the catalog tree (Node only) · a source: that source */
  depictions?: boolean | DepictionSource;
}

export function renderPreview(
  design: CableDesign,
  db: Db,
  depictions: boolean | DepictionSource,
  partLabels = false,
): { svg: string } | { error: string } {
  try {
    return { svg: renderSchematic(design, db, { depictions, partLabels }) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

export function PreviewPane({
  design,
  db,
  debounceMs = 250,
  depictions = false,
}: PreviewProps): JSX.Element {
  const [result, setResult] = useState<{ svg: string } | { error: string }>({ svg: '' });

  useEffect(() => {
    const timer = setTimeout(
      () => setResult(renderPreview(design, db, depictions)),
      debounceMs,
    );
    return () => clearTimeout(timer);
  }, [design, db, debounceMs, depictions]);

  return (
    <div className="cs-panel cs-preview">
      <h2>schematic preview</h2>
      <div className="cs-scroll cs-preview-body">
        {'error' in result ? (
          <p className="cs-error">renderer: {result.error}</p>
        ) : (
          // the renderer escapes its own text and emits no scripts or external
          // references (@wirehub/render-svg is deterministic and self
          // contained), so its output is safe to mount directly
          <div className="cs-svg" dangerouslySetInnerHTML={{ __html: result.svg }} />
        )}
      </div>
    </div>
  );
}

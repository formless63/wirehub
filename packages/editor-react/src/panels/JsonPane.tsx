/**
 * Export / import of the design document itself — no server, no adapter, no
 * editor-specific wrapper format: what comes out is exactly what
 * `packages/catalog/data/designs/*.json` holds, and what goes in is validated
 * before it can replace the current design.
 */

import type { CableDesign } from '@wirehub/model';
import { useEffect, useState, type JSX } from 'react';

import { useEditorApi } from '../context.ts';
import { exportDesignJson } from '../store.ts';
import { Button, FileDrop } from '../ui/index.ts';

export function JsonPane({ design }: { design: CableDesign }): JSX.Element {
  const { dispatch } = useEditorApi();
  const [draft, setDraft] = useState(() => exportDesignJson(design));

  // the committed design is the truth; re-seed the textarea whenever it moves
  useEffect(() => setDraft(exportDesignJson(design)), [design]);

  const download = (): void => {
    const blob = new Blob([exportDesignJson(design)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${design.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const upload = (files: File[]): void => {
    const file = files[0];
    if (file === undefined) return;
    void file.text().then((json) => {
      setDraft(json);
      dispatch({ type: 'import-json', json });
    });
  };

  return (
    <div className="cs-panel cs-json">
      <h2>design JSON</h2>
      <div className="cs-json-actions">
        <Button onClick={download}>
          download
        </Button>
        <Button onClick={() => dispatch({ type: 'import-json', json: draft })}>
          import from textarea
        </Button>
        <FileDrop accept="application/json,.json" onFiles={upload}>Import JSON file</FileDrop>
      </div>
      <textarea
        className="cs-textarea"
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    </div>
  );
}

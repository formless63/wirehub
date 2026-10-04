/**
 * Export / import of the design document itself — no server, no adapter, no
 * editor-specific wrapper format: what comes out is exactly what
 * `packages/catalog/data/designs/*.json` holds, and what goes in is validated
 * before it can replace the current design.
 */

import type { CableDesign } from '@cable-studio/model';
import { useEffect, useState, type ChangeEvent, type JSX } from 'react';

import { useEditorApi } from '../context.ts';
import { exportDesignJson } from '../store.ts';

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

  const upload = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    void file.text().then((json) => {
      setDraft(json);
      dispatch({ type: 'import-json', json });
    });
    event.target.value = '';
  };

  return (
    <div className="cs-panel cs-json">
      <h2>design JSON</h2>
      <div className="cs-json-actions">
        <button type="button" onClick={download}>
          download
        </button>
        <button type="button" onClick={() => dispatch({ type: 'import-json', json: draft })}>
          import from textarea
        </button>
        <label className="cs-upload">
          upload…
          <input type="file" accept="application/json,.json" onChange={upload} />
        </label>
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

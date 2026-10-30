import { IconPhoto } from '@tabler/icons-react';
import { useState, type JSX } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, useEditLocked } from '@wirehub/editor-react';
import { RecordCover } from './RecordCover.tsx';
import { captureEditorView, editorViewElement } from './cover-capture.ts';
import { coverKey, saveCoverCapture } from './representations.browser.ts';

/**
 * The design editor's cover strip: today's shared cover (the same image the design list shows)
 * and "Use as cover", which captures the editor's current view as a static image tied to the
 * saved design version. Unsaved edits are refused: the picture must match what is stored.
 */
export function DesignCoverAction({ id, label, dirty, canEdit, inline = false }: { id: string; label: string; dirty: boolean; canEdit: boolean; inline?: boolean }): JSX.Element {
  const client = useQueryClient();
  const locked = useEditLocked();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string }>();
  const capture = async (): Promise<void> => {
    const target = editorViewElement();
    if (target === undefined) {
      setMessage({ tone: 'err', text: 'Open the Build canvas or the schematic, then use it as the cover.' });
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      const picture = await captureEditorView(target.element);
      const out = await saveCoverCapture('designs', id, { view: 'saved-view', editorView: target.editorView, ...picture });
      if (out.ok) {
        client.setQueryData(coverKey('designs', id), out.value);
        setMessage({ tone: 'ok', text: `Cover saved from the ${target.editorView}.` });
      } else {
        setMessage({ tone: 'err', text: out.message });
        void client.invalidateQueries({ queryKey: coverKey('designs', id) });
      }
    } catch (error) {
      setMessage({ tone: 'err', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div data-testid="design-cover" className={inline ? 'flex items-center gap-2 text-xs text-dim' : 'flex min-h-8 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-raised px-3 py-1 text-xs text-dim'}>
      {message === undefined ? null : <span role="status" className={message.tone === 'err' ? 'text-err' : 'text-dim'}>{message.text}</span>}
      <span title="Cover: the picture lists and records show for this design"><RecordCover kind="designs" id={id} label={label} compact thumbClass="h-6 w-10" /></span>
      {!canEdit ? null : (
        <Button size="xs" variant="ghost" icon={<IconPhoto size={13} aria-hidden />} disabled={busy || locked || dirty} title={dirty ? 'Save the design first: the cover is tied to the saved version.' : 'Capture the current canvas or schematic as this design\'s cover'} onClick={() => void capture()}>
          {busy ? 'Saving cover…' : 'Use this view as cover'}
        </Button>
      )}
    </div>
  );
}

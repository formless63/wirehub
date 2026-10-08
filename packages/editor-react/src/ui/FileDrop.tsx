import { IconUpload } from '@tabler/icons-react';
import { useRef, useState, type JSX, type ReactNode } from 'react';

import { cx } from './cx.ts';

export interface FileDropProps {
  /** receives the accepted files (one at most unless `multiple`) */
  onFiles: (files: File[]) => void;
  /** files the `accept` list turned away */
  onReject?: (files: File[]) => void;
  /** an `<input accept>` list: extensions (".step") and mime types ("image/*") */
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  /** the main line; default "Drop a file here or choose one" */
  children?: ReactNode;
  hint?: string;
  className?: string;
  'aria-label'?: string;
}

function accepted(file: File, accept: string | undefined): boolean {
  if (accept === undefined || accept.trim() === '') return true;
  return accept.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).some((t) => {
    if (t.startsWith('.')) return file.name.toLowerCase().endsWith(t);
    if (t.endsWith('/*')) return file.type.toLowerCase().startsWith(t.slice(0, -1));
    return file.type.toLowerCase() === t;
  });
}

/**
 * Replaces a bare `<input type=file>`: a focusable zone that opens the picker on Enter, Space or click
 * and takes dropped files. The real input is kept (visually hidden) so the OS picker and its `accept`
 * filter still apply.
 */
export function FileDrop({ onFiles, onReject, accept, multiple = false, disabled, children, hint, className, ...rest }: FileDropProps): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const take = (list: FileList | null): void => {
    const all = Array.from(list ?? []);
    const ok = all.filter((f) => accepted(f, accept));
    const bad = all.filter((f) => !accepted(f, accept));
    if (bad.length > 0) onReject?.(bad);
    const use = multiple ? ok : ok.slice(0, 1);
    if (use.length > 0) onFiles(use);
  };
  return (
    <>
      <button
        type="button"
        className={cx('cs-ui-filedrop', className)}
        data-over={over || undefined}
        disabled={disabled}
        {...(rest['aria-label'] === undefined ? {} : { 'aria-label': rest['aria-label'] })}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) take(e.dataTransfer.files); }}
      >
        <IconUpload size={18} aria-hidden />
        <span>{children ?? 'Drop a file here or choose one'}</span>
        {hint === undefined ? null : <span className="cs-ui-filedrop-hint">{hint}</span>}
      </button>
      <input
        ref={input}
        type="file"
        className="cs-ui-sr"
        tabIndex={-1}
        aria-hidden
        data-testid="filedrop-input"
        {...(accept === undefined ? {} : { accept })}
        multiple={multiple}
        onChange={(e) => { take(e.target.files); e.target.value = ''; }}
      />
    </>
  );
}

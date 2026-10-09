/** Phone navigation uses the same destinations as the desktop rail. */
import { Link } from '@tanstack/react-router';
import { IconX } from '@tabler/icons-react';
import { useEffect, useRef, type JSX } from 'react';
import { NavItems } from './NavItems.tsx';
import { Wordmark } from './Wordmark.tsx';

export function MobileNavSheet({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    close.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const items = [...(dialog.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled):not([tabindex="-1"])') ?? [])];
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return <div ref={dialog} role="dialog" aria-modal="true" aria-label="Navigation" className="fixed inset-0 z-50 hidden max-sm:block">
    <button type="button" tabIndex={-1} aria-label="Close navigation" onClick={onClose} className="absolute inset-0 border-0 bg-black/45 p-0" />
    <nav aria-label="Mobile sections" className="absolute inset-y-0 left-0 flex w-64 max-w-[85vw] flex-col border-r border-line bg-panel p-2 shadow-[var(--shadow)]">
      <div className="flex shrink-0 items-center justify-between px-1.5 py-1.5">
        <Link to="/cables" onClick={onClose} aria-label="WireHub home mobile"><Wordmark className="text-sm" /></Link>
        <button ref={close} type="button" aria-label="Close" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-md border border-line2 bg-raised text-dim"><IconX size={16} /></button>
      </div>
      <div className="min-h-0 grow overflow-y-auto"><NavItems onNavigate={onClose} /></div>
    </nav>
  </div>;
}

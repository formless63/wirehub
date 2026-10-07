import { useRef, type JSX } from 'react';
import './route-actions.css';

/** One tab stop with arrow/Home/End activation; panel IDs belong to the route. */
export function RouteTabs<T extends string>({ id, label, items, value, onChange }: {
  id: string; label: string; items: readonly { id: T; label: string }[]; value: T; onChange: (value: T) => void;
}): JSX.Element {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  return <nav className="cs-route-tabs" role="tablist" aria-label={label}>
    {items.map((item, index) => <button key={item.id} type="button" role="tab" id={`${id}-tab-${item.id}`} aria-controls={`${id}-panel-${item.id}`} aria-selected={value === item.id} tabIndex={value === item.id ? 0 : -1}
      ref={(node) => { buttons.current[index] = node; }} onClick={() => onChange(item.id)}
      onKeyDown={(event) => {
        const next = event.key === 'ArrowRight' ? (index + 1) % items.length : event.key === 'ArrowLeft' ? (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : undefined;
        if (next === undefined) return;
        event.preventDefault(); onChange(items[next]!.id); buttons.current[next]?.focus();
      }}>{item.label}</button>)}
  </nav>;
}

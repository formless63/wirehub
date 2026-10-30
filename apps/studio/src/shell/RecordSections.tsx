/**
 * The record page's section stack (Library records): each extra (Stock, Firmware, Enclosures,
 * Notes …) is a `Section` from the UI primitives, in an order chosen per record kind by the page.
 * A section with nothing in it does not draw an empty box: it registers an "Add" entry here
 * instead (`useSectionAdd`), and the stack ends with one Add menu plus the record's tools.
 * Outside a stack (the design inspector, a project page) `useSectionAdd` returns false and the
 * section draws itself as usual.
 */

import { SectionAdds } from '@wirehub/editor-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';

interface AddItem { label: string; onSelect: () => void; order: number }
interface Registry { set: (id: string, item: AddItem | undefined) => void }

const Ctx = createContext<Registry | null>(null);

export function RecordSections({ children, tools }: { children: ReactNode; tools?: ReactNode }): JSX.Element {
  const [items, setItems] = useState<ReadonlyMap<string, AddItem>>(new Map());
  const set = useCallback((id: string, item: AddItem | undefined) => {
    setItems((current) => {
      if (item === undefined ? !current.has(id) : current.get(id)?.label === item.label && current.get(id)?.onSelect === item.onSelect) return current;
      const next = new Map(current);
      if (item === undefined) next.delete(id);
      else next.set(id, item);
      return next;
    });
  }, []);
  const registry = useMemo(() => ({ set }), [set]);
  const adds = [...items.entries()].sort((a, b) => a[1].order - b[1].order).map(([id, item]) => ({ id, label: item.label, onSelect: item.onSelect }));
  return (
    <Ctx.Provider value={registry}>
      <div className="cs-record-sections" data-testid="record-sections">
        {children}
        <div className="flex items-center gap-2 border-t border-line py-1">
          <SectionAdds items={adds} />
          <span className="flex-1" />
          {tools}
        </div>
      </div>
    </Ctx.Provider>
  );
}

let order = 0;

/**
 * Offer `label` in the stack's Add menu while `empty` is true. Returns true when a stack hosts the
 * section, i.e. when an empty section should render nothing.
 */
export function useSectionAdd(id: string, label: string, empty: boolean, onAdd: () => void): boolean {
  const registry = useContext(Ctx);
  const latest = useRef(onAdd);
  latest.current = onAdd;
  const stable = useCallback(() => latest.current(), []);
  const rank = useRef<number>(undefined);
  rank.current ??= order++;
  useEffect(() => {
    if (registry === null) return;
    registry.set(id, empty ? { label, onSelect: stable, order: rank.current! } : undefined);
    return () => registry.set(id, undefined);
  }, [registry, id, label, empty, stable]);
  return registry !== null;
}

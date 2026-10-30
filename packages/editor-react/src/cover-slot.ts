/**
 * Where a host shows a record's shared cover (a compact static image) inside pickers and lists the
 * editor package renders itself. The editor knows nothing about how covers are resolved; absent a
 * provider, pickers stay text-only.
 */
import { createContext, useContext, type ReactNode } from 'react';

export type CoverSlotKind = 'pcbas' | 'wires' | 'designs';
export type CoverSlot = (kind: CoverSlotKind, id: string, label: string) => ReactNode;

export const CoverSlotContext = createContext<CoverSlot | undefined>(undefined);

/** The host's cover renderer, or undefined when there is none. */
export function useCoverSlot(): CoverSlot | undefined {
  return useContext(CoverSlotContext);
}

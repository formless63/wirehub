import type { JSX, ReactNode } from 'react';

/** A key cap: `<Kbd>Ctrl</Kbd><Kbd>K</Kbd>`. */
export function Kbd({ children }: { children: ReactNode }): JSX.Element {
  return <kbd className="cs-ui-kbd">{children}</kbd>;
}

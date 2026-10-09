/**
 * The phone's view of a design (O-8): a read-only summary in place of the canvas: what it is, the
 * parts at its ends, the wiring as a list of landings, the notes, and links to the schematic and the
 * documents. The canvas is for a desktop; this is for the bench or the shop floor.
 */

import { Link } from '@tanstack/react-router';
import { findComponent, findConnector, findMechanical, findPcba, instanceName, terminalName, wireDisplayName } from '@wirehub/model';
import type { CableDesign, Db } from '@wirehub/model';
import type { JSX, ReactNode } from 'react';

interface PartRow {
  key: string;
  name: string;
  label: string;
  pn?: string | undefined;
  detail?: string | undefined;
}

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }): JSX.Element {
  return (
    <section className="border-b border-line px-4 py-3">
      <h2 className="m-0 mb-2 flex items-baseline gap-2 text-xs font-medium uppercase tracking-wide text-dim">
        {title}
        {count === undefined ? null : <span className="font-mono text-2xs text-faint">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function partRows(design: CableDesign, db: Db): PartRow[] {
  const i = design.instances;
  const rows: PartRow[] = [];
  for (const c of i.connectors) {
    const def = findConnector(db, c.def);
    rows.push({ key: c.id, name: instanceName({ instance: c.id }), label: def?.label ?? c.def, pn: def?.partNumber, detail: c.role });
  }
  for (const p of i.pcbas) {
    const def = findPcba(db, p.def);
    rows.push({ key: p.id, name: instanceName({ instance: p.id }), label: def?.label ?? p.def, pn: def?.partNumber, detail: p.note });
  }
  for (const c of i.components) {
    const def = findComponent(db, c.def);
    rows.push({ key: c.id, name: instanceName({ instance: c.id }), label: def?.label ?? c.def, pn: def?.partNumber, detail: c.location ?? c.note });
  }
  for (const m of i.mechanical ?? []) {
    const def = findMechanical(db, m.def);
    rows.push({ key: m.id, name: `${m.qty} ×`, label: def?.label ?? m.def, pn: def?.partNumber, detail: m.note });
  }
  return rows;
}

function PartList({ rows }: { rows: PartRow[] }): JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-col p-0" data-testid="phone-parts">
      {rows.map((r) => (
        <li key={r.key} className="flex min-w-0 items-baseline gap-2 border-b border-line py-1.5 last:border-b-0">
          <span className="w-8 shrink-0 font-mono text-xs text-dim">{r.name}</span>
          <span className="min-w-0 flex-1 text-sm">
            <span className="break-words">{r.label}</span>
            {r.detail === undefined ? null : <span className="block break-words text-xs text-dim">{r.detail}</span>}
          </span>
          {r.pn === undefined ? null : <span className="shrink-0 font-mono text-2xs text-dim">{r.pn}</span>}
        </li>
      ))}
    </ul>
  );
}

function mm(length: number | undefined): string {
  if (length === undefined) return 'length not set';
  return length >= 1000 ? `${(length / 1000).toFixed(length % 100 === 0 ? 1 : 2)} m` : `${length} mm`;
}

export function PhoneDesignSummary({ design, db, id }: { design: CableDesign; db: Db; id: string }): JSX.Element {
  const parts = partRows(design, db);
  const segments = design.instances.segments;
  return (
    <div data-testid="phone-design-summary" className="h-full overflow-y-auto overflow-x-hidden bg-bg">
      <header className="border-b border-line px-4 py-3">
        <h1 className="m-0 break-words text-base font-medium">{design.label}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim">
          {design.productRef === undefined ? null : <span className="font-mono">{design.productRef}</span>}
          <span className="font-mono">{design.id}</span>
          <span>{design.status ?? 'active'}</span>
        </div>
        <p role="note" data-testid="phone-edit-note" className="m-0 mt-2 text-xs text-warn">
          Open on a desktop to edit.
        </p>
        <nav className="mt-2 flex gap-2 text-sm" aria-label="This design">
          <Link to="/cables/$id" params={{ id }} search={{ view: 'schematic' }} className="cs-ui-btn no-underline">
            Schematic
          </Link>
          <Link to="/cables/$id" params={{ id }} search={{ view: 'documents' }} className="cs-ui-btn no-underline">
            Documents
          </Link>
        </nav>
      </header>
      {segments.length === 0 ? null : (
        <Section title="Wire" count={segments.length}>
          <ul className="m-0 flex list-none flex-col p-0" data-testid="phone-segments">
            {segments.map((s) => (
              <li key={s.id} className="flex min-w-0 items-baseline gap-2 border-b border-line py-1.5 last:border-b-0">
                <span className="w-8 shrink-0 font-mono text-xs text-dim">{instanceName({ instance: s.id })}</span>
                <span className="min-w-0 flex-1 break-words text-sm">
                  {wireDisplayName(db, s.def)}
                  {s.role === undefined ? null : <span className="block text-xs text-dim">{s.role}</span>}
                </span>
                <span className="shrink-0 text-xs text-dim">{mm(s.lengthMm)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {parts.length === 0 ? null : (
        <Section title="Parts" count={parts.length}>
          <PartList rows={parts} />
        </Section>
      )}
      <Section title="Wiring" count={design.joints.length}>
        {design.joints.length === 0 ? (
          <p className="m-0 text-sm text-dim">Nothing wired yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col p-0" data-testid="phone-wiring">
            {design.joints.map((j, n) => (
              <li key={n} className="flex flex-col gap-0.5 border-b border-line py-1.5 text-sm last:border-b-0">
                <span className="break-words">{terminalName(design, db, j.a)}</span>
                <span className="break-words text-dim">
                  <span aria-hidden="true">→ </span>
                  {terminalName(design, db, j.b)}
                </span>
                {j.note === undefined ? null : <span className="break-words text-xs text-faint">{j.note}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {(design.notes ?? []).length === 0 ? null : (
        <Section title="Notes" count={design.notes?.length ?? 0}>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm" data-testid="phone-notes">
            {(design.notes ?? []).map((n, k) => (
              <li key={k} className="break-words">
                {n}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

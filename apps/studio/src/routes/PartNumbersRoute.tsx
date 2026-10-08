/**
 * `/part-numbers` — part-number health (cs-5k1.3): numbers on two different
 * parts, parts and cables with no number (with what the scheme would give
 * each), cables whose product reference and drawing number disagree, and the
 * scheme's own objections. All derived from the live catalog, designs and
 * drawings through the deployment's `PartNumberScheme`; nothing is stored.
 */

import { InfoTip } from '../shell/InfoTip.tsx';
import { Link } from '@tanstack/react-router';
import { useMemo, type JSX } from 'react';
import { partNumberReport } from '@wirehub/model';

import { useStudio } from '../studio-context.tsx';

const LIBRARY_KINDS: Readonly<Record<string, string>> = {
  connectors: 'connectors',
  bodies: 'bodies',
  wires: 'wires',
  components: 'components',
  pcbas: 'pcbas',
  mechanicals: 'mechanicals',
  kits: 'kits',
};

/** A `connectors/de9-male` / `designs/my-cable` / `drawings/my-cable` place, as a link to it. */
function Place({ where }: { where: string }): JSX.Element {
  const slash = where.indexOf('/');
  const group = where.slice(0, slash);
  const id = where.slice(slash + 1);
  if (group === 'designs' || group === 'drawings') {
    return (
      <Link to="/cables/$id" params={{ id }} className="underline">
        {where}
      </Link>
    );
  }
  const kind = LIBRARY_KINDS[group];
  return kind === undefined ? (
    <span>{where}</span>
  ) : (
    <Link to="/library/$kind/$id" params={{ kind, id }} className="underline">
      {where}
    </Link>
  );
}

function Section(props: { title: string; count: number; empty: string; children: JSX.Element | null; testId: string }): JSX.Element {
  return (
    <section className="mb-5" data-testid={props.testId}>
      <h2 className="mb-1 text-[13px] font-semibold">
        {props.title} <span className="font-normal text-faint">({props.count})</span>
      </h2>
      {props.count === 0 ? <p className="text-faint">{props.empty}</p> : props.children}
    </section>
  );
}

export function PartNumbersRoute(): JSX.Element {
  const { db, partNumbers } = useStudio();
  const report = useMemo(
    () => (partNumbers === undefined ? undefined : partNumberReport(db, partNumbers.designs ?? [], partNumbers.drawings ?? {}, partNumbers.scheme, partNumbers.extra)),
    [db, partNumbers],
  );
  return (
    <div className="h-full min-h-0 overflow-auto p-4 text-[12.5px]" data-testid="part-numbers">
      <h1 className="mb-3 text-[14px] font-semibold">
        Part numbers
        <InfoTip topic="part-numbers" text={`Read through ${partNumbers?.scheme.label ?? 'the numbering scheme'}. A connector and the body it is built on share a number without clashing, and a design’s product reference and drawing number are one number written twice.`} />
      </h1>
      {report === undefined ? (
        <div className="text-faint">Loading…</div>
      ) : (
        <>
          <Section title="Numbers used twice" count={report.duplicates.length} empty="Every number names one part." testId="pn-duplicates">
            <ul className="flex flex-col gap-1">
              {report.duplicates.map((d) => (
                <li key={d.pn} data-pn={d.pn}>
                  <code className="cs-mono">{d.pn}</code> on{' '}
                  {d.holders.map((h, i) => (
                    <span key={h.where}>
                      {i === 0 ? '' : ', '}
                      <Place where={h.where} />
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Cables whose numbers disagree" count={report.disagreements.length} empty="Every cable’s product reference matches its drawing number." testId="pn-disagreements">
            <ul className="flex flex-col gap-1">
              {report.disagreements.map((d) => (
                <li key={d.designId} data-design={d.designId}>
                  <Place where={`designs/${d.designId}`} />: product reference <code className="cs-mono">{d.productRef}</code>, drawing <code className="cs-mono">{d.drawingPn}</code>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Without a number" count={report.unnumbered.length} empty="Everything the scheme numbers has a number." testId="pn-unnumbered">
            <table className="w-full max-w-3xl text-left">
              <thead>
                <tr className="text-faint">
                  <th className="pr-3 font-normal">What</th>
                  <th className="pr-3 font-normal">Kind</th>
                  <th className="pr-3 font-normal">Suggested</th>
                </tr>
              </thead>
              <tbody>
                {report.unnumbered.map((u) => (
                  <tr key={u.where} data-where={u.where}>
                    <td className="pr-3">
                      <Place where={u.where} /> <span className="text-faint">{u.label}</span>
                    </td>
                    <td className="pr-3">{u.kind}</td>
                    <td className="pr-3" title={u.suggestion?.explanation}>
                      {u.suggestion === undefined ? '' : <code className="cs-mono">{u.suggestion.pn}</code>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <Section title="Numbers the scheme objects to" count={report.format.length} empty="Every number is in the scheme’s form." testId="pn-format">
            <ul className="flex flex-col gap-1">
              {report.format.map((f) => (
                <li key={`${f.holder.where}:${f.code}`}>
                  <Place where={f.holder.where} />: {f.message}
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </div>
  );
}

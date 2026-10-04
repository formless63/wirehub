/**
 * The curated-PCBA editor: pads, the connector soldered to the board, what is
 * joined inside it, and which build variant this record describes.
 *
 * A board in this model is a **black box with declared continuity**: the studio
 * does not read schematics, it records what the board joins to what. So the
 * screen is three lists — the pads a conductor lands on, the connectors that
 * come pre-soldered (whose pins become terminals like `scart.15`), and the
 * internal links between them, each with the plain-words note of what sits in
 * the path ("C1 220 µF").
 *
 * The link rows pick their endpoints from a list built out of the two lists
 * above, so a link can only name a terminal that exists — the mistake this
 * screen most invites is a typo in `mo.11`, and a picker removes it.
 *
 * Boards written by the importer are not edited here. They are derived from the
 * production netlists and rewritten wholesale by `pnpm import-pcbas`; a hand
 * edit would be silently thrown away next time it runs. The Library shows them
 * read-only and says so.
 */

import type { Db } from '@cable-studio/model';
import { IconInfoCircle } from '@tabler/icons-react';
import { useMemo, type JSX } from 'react';

import { classes } from '../context.ts';
import {
  duplicateRowIds,
  integratedRowsReducer,
  linkRowsReducer,
  padRowsReducer,
  pcbaOf,
  pcbaTerminalChoices,
  type IntegratedRow,
  type LinkRow,
  type PadRow,
  type PcbaDraft,
  type RowAction,
} from '../library.ts';
import { useCatalogValues } from '../catalog-values.ts';
import { Field, FormSection, RowTools, SrcField } from './fields.tsx';
import { Pick } from './Pick.tsx';
import { PartNumberField } from './PartNumberField.tsx';

/** One copper path, read for a person: the pad end first. */
export interface CopperPath {
  pad: string;
  other: string;
  /** the connector pin's own signal name, when the far end is one */
  otherLabel?: string;
  via?: string;
  note?: string;
  /** the row in `draft.links` this came from */
  index: number;
}

export interface CopperPathGroup {
  /** the pad's signal (`Video R`), or the pad id when it has none */
  signal: string;
  pad: string;
  paths: CopperPath[];
}

/**
 * `internalLinks` grouped by the pad each one starts from (50a.38: the flat
 * from/to table read as "SCART shows 14 pins all being joined"). A link
 * between two pads, or two connector pins, groups under its `from`. The data
 * is not touched — this is only how it is read.
 */
export function copperPathGroups(draft: PcbaDraft, db: Db): CopperPathGroup[] {
  const pads = new Map(draft.terminals.map((pad) => [pad.id.trim(), pad.label.trim()]));
  const prefixes = new Map(
    draft.integrated.map((row) => [row.terminalPrefix.trim(), row.connectorDefId] as const),
  );
  const pinLabel = (terminal: string): string | undefined => {
    const dot = terminal.indexOf('.');
    if (dot < 0) return pads.get(terminal) || undefined;
    const defId = prefixes.get(terminal.slice(0, dot));
    const connector = db.connectors.find((candidate) => candidate.id === defId);
    return connector?.pins.find((pin) => pin.id === terminal.slice(dot + 1))?.label;
  };
  const groups = new Map<string, CopperPathGroup>();
  draft.links.forEach((link, index) => {
    const from = link.from.trim();
    const to = link.to.trim();
    if (from === '' && to === '') return;
    const flip = !pads.has(from) && pads.has(to);
    const pad = flip ? to : from;
    const other = flip ? from : to;
    const otherLabel = pinLabel(other);
    let group = groups.get(pad);
    if (group === undefined) {
      group = { signal: pads.get(pad) || pad, pad, paths: [] };
      groups.set(pad, group);
    }
    group.paths.push({
      pad,
      other,
      ...(otherLabel === undefined ? {} : { otherLabel }),
      ...(link.via.trim() === '' ? {} : { via: link.via.trim() }),
      ...(link.note.trim() === '' ? {} : { note: link.note.trim() }),
      index,
    });
  });
  return [...groups.values()];
}

function CopperPaths(props: { groups: CopperPathGroup[] }): JSX.Element {
  return (
    <div className="cs-paths">
      {props.groups.map((group) => (
        <section key={group.pad} className="cs-path-group">
          <header className="cs-path-signal">
            <strong>{group.signal}</strong>
            {group.signal === group.pad ? null : <span className="cs-mono">{group.pad}</span>}
            {group.paths.length > 1 ? <span className="cs-count">{group.paths.length}</span> : null}
          </header>
          <ul>
            {group.paths.map((path) => (
              <li key={path.index} {...(path.note === undefined ? {} : { title: path.note })}>
                <span className="cs-mono">{path.pad}</span>
                <span className="cs-path-arrow" aria-label="to">
                  →
                </span>
                <span className="cs-mono">{path.other}</span>
                {path.otherLabel === undefined ? null : <span className="cs-path-pin">{path.otherLabel}</span>}
                {path.via === undefined ? (
                  <span className="cs-path-copper">copper</span>
                ) : (
                  <span className="cs-chip cs-path-via">via {path.via}</span>
                )}
                {path.note === undefined ? null : (
                  <IconInfoCircle className="cs-path-note" size={12} stroke={1.75} aria-hidden="true" />
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export interface PcbaEditorProps {
  draft: PcbaDraft;
  onChange: (next: PcbaDraft) => void;
  idLocked: boolean;
  /** the library, for the connector picker and the terminal list */
  db: Db;
  /**
   * An imported board: the record is the importer's, so only the pads' role
   * and signal can change (they are tag corrections a re-import keeps).
   */
  locked?: boolean;
}

export function PcbaEditor(props: PcbaEditorProps): JSX.Element {
  const { draft, onChange } = props;
  const set = <K extends keyof PcbaDraft>(key: K, value: PcbaDraft[K]): void =>
    onChange({ ...draft, [key]: value });
  const pads = (action: RowAction<PadRow>): void =>
    onChange({ ...draft, terminals: padRowsReducer(draft.terminals, action) });
  const links = (action: RowAction<LinkRow>): void =>
    onChange({ ...draft, links: linkRowsReducer(draft.links, action) });
  const integrated = (action: RowAction<IntegratedRow>): void =>
    onChange({ ...draft, integrated: integratedRowsReducer(draft.integrated, action) });

  const duplicates = new Set(duplicateRowIds(draft.terminals));
  const choices = pcbaTerminalChoices(draft, props.db);
  const known = new Set(choices);
  const pathGroups = useMemo(() => copperPathGroups(draft, props.db), [draft, props.db]);
  const values = useCatalogValues();
  const locked = props.locked === true;

  return (
    <>
      <fieldset className="cs-lockable" disabled={locked}>
      <FormSection title="What this board is">
        <div className="cs-form-grid">
          <Field
            label="Name"
            say="How it reads on the build sheet and in the BOM."
            value={draft.label}
            onChange={(value) => set('label', value)}
            placeholder="Board name — PN Rev"
            autoFocus
            wide
          />
          <Field
            label="Id"
            say={
              props.idLocked
                ? 'Fixed: every design that uses this board refers to it by this id.'
                : 'Short name used in files and links — usually the part number and revision.'
            }
            value={draft.id}
            onChange={(value) => set('id', value)}
            placeholder="follows the name"
          />
          <PartNumberField
            say="The number printed on the board (the bare PCB)."
            value={draft.partNumber}
            onChange={(value) => set('partNumber', value)}
            placeholder="e.g. PCA-00012"
            kind="bare-pcb"
            target={() => ({ kind: 'pcba', def: pcbaOf(draft) })}
          />
          <Field
            label="Revision"
            say="Boards change; this is what tells two of them apart."
            value={draft.revision}
            onChange={(value) => set('revision', value)}
            options={values.pcbaRevisions}
            placeholder="Rev6"
          />
          <Field
            label="Build"
            say="Which populated variant this record describes. Two builds of one board are two records."
            value={draft.build}
            onChange={(value) => set('build', value)}
            options={values.pcbaBuilds}
            placeholder="CPL Basic"
          />
          <Field
            label="KiCad project"
            say="Reference only — the studio does not read it."
            value={draft.kicadProject}
            onChange={(value) => set('kicadProject', value)}
            placeholder="schematic file name"
            wide
          />
        </div>
        <SrcField value={draft.src} onChange={(value) => set('src', value)} />
      </FormSection>
      </fieldset>

      <FormSection
        title="Pads"
        say="The places a conductor lands on this board. Use the silkscreen text beside each one."
        right={<span className="cs-count">{draft.terminals.length}</span>}
      >
        <table className="cs-rows">
          <thead>
            <tr>
              <th scope="col">Pad</th>
              <th scope="col" title="Which pad this is for the cable — picked from the pad-roles list; the silkscreen id stays as the pad.">
                Role
              </th>
              <th scope="col" title="What the pad carries, where the board says more than its role.">
                Signal
              </th>
              <th scope="col" title="The words printed for this pad.">
                Label
              </th>
              <th scope="col">Note</th>
              <th scope="col">
                <span className="cs-visually-hidden">Reorder</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {draft.terminals.map((pad, index) => {
              const clash = pad.id.trim() !== '' && duplicates.has(pad.id.trim());
              return (
                <tr key={index} className={classes(clash && 'is-bad')}>
                  <td>
                    <input
                      className="cs-mono"
                      value={pad.id}
                      aria-label={`pad ${index + 1} id`}
                      disabled={locked}
                      placeholder="GND"
                      onChange={(event) => pads({ type: 'update', index, patch: { id: event.target.value } })}
                    />
                    {clash ? (
                      <small className="cs-field-bad">‘{pad.id.trim()}’ is already a pad.</small>
                    ) : null}
                  </td>
                  <td className="cs-pick-cell">
                    <Pick
                      list="pad-roles"
                      ariaLabel={`pad ${index + 1} role`}
                      value={pad.role}
                      clearable
                      noneLabel="untagged"
                      placeholder="—"
                      onChange={(id) => pads({ type: 'update', index, patch: { role: id } })}
                    />
                  </td>
                  <td className="cs-pick-cell">
                    <Pick
                      list="signals"
                      ariaLabel={`pad ${index + 1} signal`}
                      value={pad.signal}
                      clearable
                      noneLabel="untagged"
                      placeholder="—"
                      onChange={(id) => pads({ type: 'update', index, patch: { signal: id } })}
                    />
                  </td>
                  <td>
                    <input
                      value={pad.label}
                      aria-label={`pad ${index + 1} label`}
                      disabled={locked}
                      placeholder="Video R"
                      onChange={(event) =>
                        pads({ type: 'update', index, patch: { label: event.target.value } })
                      }
                    />
                  </td>
                  <td>
                    <input
                      value={pad.note}
                      aria-label={`pad ${index + 1} note`}
                      disabled={locked}
                      placeholder="conductor landing pad R1"
                      onChange={(event) =>
                        pads({ type: 'update', index, patch: { note: event.target.value } })
                      }
                    />
                  </td>
                  <td>
                    {locked ? null : <RowTools
                      index={index}
                      count={draft.terminals.length}
                      what={`pad ${index + 1}`}
                      onMove={(by) => pads({ type: 'move', index, by })}
                      onRemove={() => pads({ type: 'remove', index })}
                    />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {locked ? null : (
          <button type="button" className="cs-add" onClick={() => pads({ type: 'add' })}>
            + Add a pad
          </button>
        )}
      </FormSection>

      <fieldset className="cs-lockable" disabled={locked}>

      <FormSection
        title="Connectors soldered to the board"
        say="A board sold with its connector already on it exposes that connector’s pins as terminals. The prefix is what they are called here: `scart` makes pin 15 into `scart.15`."
        right={<span className="cs-count">{draft.integrated.length}</span>}
      >
        <table className="cs-rows">
          <thead>
            <tr>
              <th scope="col">Connector</th>
              <th scope="col">Called here</th>
              <th scope="col">
                <span className="cs-visually-hidden">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {draft.integrated.map((row, index) => (
              <tr key={index}>
                <td>
                  <select
                    value={row.connectorDefId}
                    aria-label={`soldered connector ${index + 1}`}
                    onChange={(event) =>
                      integrated({
                        type: 'update',
                        index,
                        patch: { connectorDefId: event.target.value },
                      })
                    }
                  >
                    <option value="">— pick a connector —</option>
                    {props.db.connectors.map((connector) => (
                      <option key={connector.id} value={connector.id}>
                        {connector.id} — {connector.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    value={row.terminalPrefix}
                    aria-label={`soldered connector ${index + 1} prefix`}
                    placeholder="scart"
                    onChange={(event) =>
                      integrated({
                        type: 'update',
                        index,
                        patch: { terminalPrefix: event.target.value },
                      })
                    }
                  />
                </td>
                <td>
                  <RowTools
                    index={index}
                    count={draft.integrated.length}
                    what={`soldered connector ${index + 1}`}
                    onMove={(by) => integrated({ type: 'move', index, by })}
                    onRemove={() => integrated({ type: 'remove', index })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="cs-add" onClick={() => integrated({ type: 'add' })}>
          + Add a soldered connector
        </button>
      </FormSection>

      <FormSection
        title="Board copper paths"
        say="Traces on the board itself, pad → connector pin, with the part in the path if any — not wires, and not pins joined to each other."
        right={<span className="cs-count">{draft.links.length}</span>}
      >
        {pathGroups.length === 0 ? null : <CopperPaths groups={pathGroups} />}
        <details className="cs-paths-edit" open={draft.links.length === 0}>
          <summary>Edit paths</summary>
        <table className="cs-rows">
          <thead>
            <tr>
              <th scope="col">From</th>
              <th scope="col">To</th>
              <th scope="col">Through</th>
              <th scope="col">Note</th>
              <th scope="col">
                <span className="cs-visually-hidden">Reorder</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {draft.links.map((link, index) => {
              const strayFrom = link.from.trim() !== '' && !known.has(link.from.trim());
              const strayTo = link.to.trim() !== '' && !known.has(link.to.trim());
              return (
                <tr key={index} className={classes((strayFrom || strayTo) && 'is-bad')}>
                  <td>
                    <input
                      className="cs-mono"
                      value={link.from}
                      aria-label={`link ${index + 1} from`}
                      list="cs-pcba-terminals"
                      placeholder="mo.1"
                      onChange={(event) =>
                        links({ type: 'update', index, patch: { from: event.target.value } })
                      }
                    />
                    {strayFrom ? (
                      <small className="cs-field-bad">
                        This board has no terminal called ‘{link.from.trim()}’.
                      </small>
                    ) : null}
                  </td>
                  <td>
                    <input
                      className="cs-mono"
                      value={link.to}
                      aria-label={`link ${index + 1} to`}
                      list="cs-pcba-terminals"
                      placeholder="R"
                      onChange={(event) =>
                        links({ type: 'update', index, patch: { to: event.target.value } })
                      }
                    />
                    {strayTo ? (
                      <small className="cs-field-bad">
                        This board has no terminal called ‘{link.to.trim()}’.
                      </small>
                    ) : null}
                  </td>
                  <td>
                    <input
                      value={link.via}
                      aria-label={`link ${index + 1} through`}
                      placeholder="C3 220 µF"
                      onChange={(event) =>
                        links({ type: 'update', index, patch: { via: event.target.value } })
                      }
                    />
                  </td>
                  <td>
                    <input
                      value={link.note}
                      aria-label={`link ${index + 1} note`}
                      placeholder="JP1 open on this build"
                      onChange={(event) =>
                        links({ type: 'update', index, patch: { note: event.target.value } })
                      }
                    />
                  </td>
                  <td>
                    <RowTools
                      index={index}
                      count={draft.links.length}
                      what={`link ${index + 1}`}
                      onMove={(by) => links({ type: 'move', index, by })}
                      onRemove={() => links({ type: 'remove', index })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <datalist id="cs-pcba-terminals">
          {choices.map((choice) => (
            <option key={choice} value={choice} />
          ))}
        </datalist>
        <button type="button" className="cs-add" onClick={() => links({ type: 'add' })}>
          + Add a path
        </button>
        </details>
      </FormSection>
      </fieldset>
    </>
  );
}

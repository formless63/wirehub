/**
 * The connector journey (data model v2 §8 J1): one
 * screen, three steps, live builder art.
 *
 * 1. **Body** — pick one ("DIN-8 270° male"), or make one: family, gender and
 *    a standard layout are picked; the positions, the id, the name and the
 *    builder drawing follow. The body's pinouts and connectors are listed, so
 *    the DIN-8 270° shows its pinout variants side by side.
 * 2. **Pinout** — pick one of the body's, or make one: a vocab signal per
 *    position, with "Copy from…" any pinout and "Mirror…" a pinout of the
 *    opposite gender (directions flipped).
 * 3. **Connector** — the pair plus its part number: what designs reference.
 *    Today's ids are exactly such pairs.
 *
 * The drawing on the right is what the canvas draws: the **body's**, with
 * this pinout's labels. Every pinout on a body shares it, so a new pinout on
 * a known body draws correctly with no upload. Save writes body, pinout,
 * connector in that order, each through the host's whole-library check.
 */

import {
  errors,
  interfacesOnBody,
  validateDb,
  type ConnectorBody,
  type ConnectorDefinition,
  type Db,
  type Interface,
  type Issue,
} from '@wirehub/model';
import { useEffect, useMemo, useState, type JSX } from 'react';

import { BODY_TEMPLATES, CUSTOM_TEMPLATE, oppositeGenderBody, templatesFor } from '../body-templates.ts';
import { classes } from '../context.ts';
import {
  CONFIDENCES,
  PIN_DIRS,
  blankBodyDraft,
  blankPinoutDraft,
  bodyDraftOf,
  bodyOfDraft,
  composeJourneyConnector,
  copyPinout,
  overlap,
  pinoutDraftOf,
  pinoutOfDraft,
  sameRecord,
  suggestConnectorLabel,
  suggestPinoutId,
  withBodyField,
  type BodyDraft,
  type ConnectorIdentity,
  type PinoutDraft,
  type PinoutRow,
} from '../connector-journey.ts';
import {
  createDefinition,
  saveDefinition,
  type DefinitionChange,
  type DefinitionResult,
  type DefinitionUsage,
  type DefinitionsAdapter,
} from '../definitions.ts';
import type { LifecycleProblem } from '../lifecycle.ts';
import { slugify } from '../persistence.ts';
import { describeIssue } from '../store.ts';
import { signalRefOf, useVocab, type PickOption } from '../vocab.ts';
import { constructionLabel, variantIdOf, withConstructionInLabel } from '../naming.ts';
import { BuiltInConnectorArt, builtInConnectorArt } from './BuiltInArt.tsx';
import { Choice, Field, FormSection, SrcField } from './fields.tsx';
import { HousingSection } from './ConnectorEditor.tsx';
import { Pick } from './Pick.tsx';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard.ts';

export interface ConnectorJourneyProps {
  db: Db;
  definitions?: DefinitionsAdapter;
  /** the connector being edited; absent for a new one */
  connector?: ConnectorDefinition;
  /**
   * A new connector's starting pair (a list group's "+ pinout", a pinout with
   * no connector yet) — or a variant of `variantOf`: same pinout, a different
   * construction.
   */
  start?: { body?: string; interface?: string; variantOf?: ConnectorDefinition };
  readOnly: boolean;
  /** every id a part already uses — a new connector's id must be free */
  takenIds: readonly string[];
  onSaved: (record: ConnectorDefinition, created: boolean, changes: DefinitionChange[]) => void;
  onClose: () => void;
  onDelete?: () => void;
  /** another connector on this body was picked */
  onOpenConnector?: (id: string) => void;
}

type Mode = 'pick' | 'new' | 'edit';

function mergeById<T extends { id: string }>(base: readonly T[], saved: readonly T[]): T[] {
  const byId = new Map(saved.map((record) => [record.id, record]));
  const out = base.map((record) => byId.get(record.id) ?? record);
  for (const record of saved) if (!base.some((b) => b.id === record.id)) out.push(record);
  return out;
}

function swapIn<T extends { id: string }>(records: readonly T[], record: T | undefined, replacing?: string): T[] {
  if (record === undefined) return [...records];
  const key = replacing ?? record.id;
  return records.some((r) => r.id === key) ? records.map((r) => (r.id === key ? record : r)) : [...records, record];
}

function issueKey(issue: Issue): string {
  return `${issue.code} ${issue.where ?? ''} ${issue.message}`;
}

function ProblemBox({ problem }: { problem: LifecycleProblem }): JSX.Element {
  return (
    <div className="cs-problem" role="alert">
      <strong>{problem.message}</strong>
      {problem.hint === undefined ? null : <p className="cs-problem-hint">{problem.hint}</p>}
      {problem.details.length === 0 ? null : (
        <ul className="cs-problem-list">
          {problem.details.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const DIR_LABEL: Record<string, string> = { '': '—', out: 'out', in: 'in', bidir: 'both', passive: 'passive' };
const CONFIDENCE_LABEL: Record<string, string> = {
  '': '—',
  'net-verified': 'net-verified',
  documented: 'documented',
  inferred: 'inferred',
  unknown: 'unknown',
};

export function ConnectorJourney(props: ConnectorJourneyProps): JSX.Element {
  const { db, definitions, connector } = props;
  const { vocab } = useVocab();
  const vocabNow = vocab ?? db.vocab;

  /* the library as this screen knows it: the host's, plus what it just saved */
  const [savedBodies, setSavedBodies] = useState<ConnectorBody[]>([]);
  const [savedIfaces, setSavedIfaces] = useState<Interface[]>([]);
  const [savedConnectors, setSavedConnectors] = useState<ConnectorDefinition[]>([]);
  const bodies = useMemo(() => mergeById(db.bodies ?? [], savedBodies), [db.bodies, savedBodies]);
  const interfaces = useMemo(() => mergeById(db.interfaces ?? [], savedIfaces), [db.interfaces, savedIfaces]);
  const connectors = useMemo(() => mergeById(db.connectors, savedConnectors), [db.connectors, savedConnectors]);

  // the versions this screen edits from: listing each kind records them in the
  // host adapter, which quotes them back as If-Match on save (required)
  useEffect(() => {
    if (definitions === undefined) return;
    for (const kind of ['bodies', 'interfaces', 'connectors'] as const) void definitions.list(kind);
  }, [definitions]);

  /* step 1 — body */
  const startBody = connector?.body ?? props.start?.body ?? '';
  const [bodyMode, setBodyMode] = useState<Mode>('pick');
  const [bodyId, setBodyId] = useState(startBody);
  const [bodyDraft, setBodyDraft] = useState<BodyDraft>(blankBodyDraft);
  const [bodyBaseline, setBodyBaseline] = useState<ConnectorBody | undefined>(undefined);

  /* step 2 — pinout */
  const startIface = connector?.interface ?? props.start?.interface ?? '';
  const [ifaceMode, setIfaceMode] = useState<Mode>(() =>
    startIface === '' && startBody !== '' ? 'new' : 'pick',
  );
  const [ifaceId, setIfaceId] = useState(startIface);
  const [ifaceDraft, setIfaceDraft] = useState<PinoutDraft>(() => blankPinoutDraft(startBody));
  const [ifaceBaseline, setIfaceBaseline] = useState<Interface | undefined>(undefined);

  /* step 3 — the connector itself */
  const variantOf = connector === undefined ? props.start?.variantOf : undefined;
  const initialIdentity = (): ConnectorIdentity => ({
    id: connector?.id ?? '',
    label: connector?.label ?? '',
    partNumber: connector?.partNumber ?? '',
    construction: connector?.construction ?? '',
    sourcing: connector?.sourcing ?? '',
    src:
      connector?.src ??
      (variantOf === undefined
        ? ''
        : `Variant of ${variantOf.id}: the same ${variantOf.interface ?? 'pinout'} pinout, a different construction. `),
    idTouched: connector !== undefined,
    labelTouched: connector !== undefined,
  });
  const [identity, setIdentity] = useState<ConnectorIdentity>(initialIdentity);
  /** a variant's body follows the construction picked until a body is picked by hand */
  const [bodyTouched, setBodyTouched] = useState(false);

  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LifecycleProblem | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [bodyUsage, setBodyUsage] = useState<DefinitionUsage | undefined>(undefined);

  const body: ConnectorBody | undefined = useMemo(
    () => (bodyMode === 'pick' ? bodies.find((b) => b.id === bodyId) : bodyOfDraft(bodyDraft)),
    [bodyMode, bodies, bodyId, bodyDraft],
  );
  const bodyKey = bodyMode === 'pick' ? bodyId : bodyBaseline?.id;

  const iface: Interface | undefined = useMemo(() => {
    if (ifaceMode === 'pick') return interfaces.find((i) => i.id === ifaceId);
    if (body === undefined) return undefined;
    const draft = ifaceMode === 'new' ? { ...ifaceDraft, bodies: [body.id] } : {
      ...ifaceDraft,
      // the body may be renamed in the same save; the pinout follows it
      bodies: ifaceDraft.bodies.map((id) => (id === bodyBaseline?.id ? body.id : id)),
    };
    return pinoutOfDraft(draft, body);
  }, [ifaceMode, ifaceId, interfaces, ifaceDraft, body, bodyBaseline]);

  /* a new connector is named after its pair until the user types a name */
  const partIds = useMemo(() => props.takenIds.filter((id) => id !== connector?.id), [props.takenIds, connector?.id]);
  const shownIdentity: ConnectorIdentity = useMemo(() => {
    if (connector !== undefined) return identity;
    const label = identity.labelTouched
      ? identity.label
      : variantOf !== undefined
        ? withConstructionInLabel(variantOf.label, identity.construction === '' ? body?.construction : identity.construction)
        : suggestConnectorLabel(body, iface, identity.construction === '' ? undefined : identity.construction);
    let id = identity.id;
    if (!identity.idTouched) {
      if (variantOf !== undefined && identity.construction !== '') id = variantIdOf(variantOf.id, identity.construction, partIds);
      else {
        const base = slugify(label);
        id = base;
        for (let n = 2; base !== '' && partIds.includes(id); n += 1) id = `${base}-${n}`;
      }
    }
    return { ...identity, label, id, partNumber: identity.partNumber };
  }, [identity, body, iface, connector, partIds, variantOf]);

  /*
   * A variant takes the body that matches its construction when the library
   * has one (the PCB-mount DIN-8 270° is its own body, din8-270-male-pcb):
   * same family, gender and positions, the picked construction.
   */
  useEffect(() => {
    if (variantOf === undefined || bodyTouched || identity.construction === '') return;
    const source = bodies.find((b) => b.id === variantOf.body);
    if (source === undefined) return;
    const same = bodies.find(
      (b) =>
        b.construction === identity.construction &&
        b.family === source.family &&
        b.gender === source.gender &&
        b.positions.length === source.positions.length,
    );
    const next = same?.id ?? source.id;
    if (next !== bodyId) {
      setBodyMode('pick');
      setBodyId(next);
    }
  }, [variantOf, bodyTouched, identity.construction, bodies, bodyId]);

  const candidate: ConnectorDefinition | undefined = useMemo(
    () =>
      body === undefined || iface === undefined
        ? undefined
        : composeJourneyConnector(shownIdentity, body, iface, vocabNow, connector),
    [body, iface, shownIdentity, vocabNow, connector],
  );

  /* dirty, per record */
  const bodyDirty = bodyMode === 'new' || (bodyMode === 'edit' && body !== undefined && !sameRecord(body, bodyBaseline));
  const ifaceDirty = ifaceMode === 'new' || (ifaceMode === 'edit' && iface !== undefined && !sameRecord(iface, ifaceBaseline));
  // the connector record is its identity and the pair; its pins follow the pinout and are never stored
  const connectorDirty =
    candidate !== undefined &&
    (connector === undefined || !sameRecord({ ...candidate, pins: undefined }, { ...connector, pins: undefined }));
  const dirty = bodyDirty || ifaceDirty || connectorDirty;
  // a blank new connector is "dirty" only once something was picked or typed
  useUnsavedChangesGuard(dirty && (connector !== undefined || bodyMode !== 'pick' || bodyId !== ''));

  /* who shares the body, and what it reaches */
  const bodyPinouts = useMemo(
    () => (bodyKey === undefined || bodyKey === '' ? [] : interfacesOnBody({ interfaces }, bodyKey)),
    [interfaces, bodyKey],
  );
  const bodyConnectors = useMemo(
    () => (bodyKey === undefined || bodyKey === '' ? [] : connectors.filter((c) => c.body === bodyKey)),
    [connectors, bodyKey],
  );
  /* a new connector with the same body and pinout as one on file is a duplicate */
  const duplicates = useMemo(
    () =>
      connector !== undefined || body === undefined || iface === undefined
        ? []
        : connectors
            .filter(
              (c) =>
                c.body === body.id &&
                c.interface === iface.id &&
                // another construction on the same pair is a variant, not a duplicate
                (c.construction ?? body.construction ?? '') === (shownIdentity.construction || body.construction || ''),
            )
            .map((c) => c.id),
    [connector, body, iface, connectors, shownIdentity.construction],
  );
  useEffect(() => {
    setBodyUsage(undefined);
    if (definitions === undefined || bodyKey === undefined || bodyKey === '') return;
    let live = true;
    void definitions.usage('bodies', bodyKey).then((outcome) => {
      if (live && outcome.ok) setBodyUsage(outcome.value);
    });
    return () => {
      live = false;
    };
  }, [definitions, bodyKey]);
  const ifaceConnectors = useMemo(
    () => (ifaceId === '' ? [] : db.connectors.filter((c) => c.interface === ifaceId && c.id !== connector?.id)),
    [db.connectors, ifaceId, connector?.id],
  );

  /* the whole library with this screen's three records in it — the immediate half of the gate */
  const libraryIssues = useMemo((): Issue[] => {
    if (body === undefined || !dirty) return [];
    const candidateDb: Db = {
      ...db,
      bodies: swapIn(db.bodies ?? [], body, bodyMode === 'edit' ? bodyBaseline?.id : undefined),
      interfaces: swapIn(db.interfaces ?? [], iface, ifaceMode === 'edit' ? ifaceBaseline?.id : undefined),
      connectors: swapIn(db.connectors, candidate, connector?.id),
    };
    const before = new Set(errors(validateDb(db)).map(issueKey));
    return errors(validateDb(candidateDb)).filter((issue) => !before.has(issueKey(issue)));
  }, [db, body, iface, candidate, dirty, bodyMode, ifaceMode, bodyBaseline, ifaceBaseline, connector?.id]);

  /* the builder's drawing: the body's, labelled by this pinout */
  // every position of the body is drawn — the pinout only labels the ones it assigns
  const artDef: ConnectorDefinition | undefined = useMemo(() => {
    if (body === undefined) return undefined;
    const labelled = new Map((candidate?.pins ?? []).map((pin) => [pin.id, pin]));
    return {
      ...(candidate ?? { id: body.id, label: body.label, family: body.family, src: body.src }),
      gender: body.gender,
      pins: body.positions.map((p) => labelled.get(p.id) ?? { id: p.id, label: p.id }),
    };
  }, [candidate, body]);
  const art = useMemo(() => builtInConnectorArt(artDef, body), [artDef, body]);
  const sharedBy = useMemo(() => {
    const labels = bodyPinouts.map((p) => p.label);
    if (iface !== undefined && !bodyPinouts.some((p) => p.id === iface.id)) labels.push(iface.label || 'this pinout');
    return labels;
  }, [bodyPinouts, iface]);

  /* ---------------------------------------------------------------- *
   * Changes
   * ---------------------------------------------------------------- */

  const takenBodyIds = bodies.filter((b) => b.id !== bodyBaseline?.id).map((b) => b.id);
  const takenIfaceIds = interfaces.filter((i) => i.id !== ifaceBaseline?.id).map((i) => i.id);

  const pickBody = (id: string): void => {
    setBodyTouched(true);
    setBodyMode('pick');
    setBodyId(id);
    setBodyBaseline(undefined);
    setProblem(undefined);
    const onIt = interfacesOnBody({ interfaces }, id);
    if (ifaceMode === 'pick') {
      if (onIt.some((i) => i.id === ifaceId)) return;
      const first = onIt[0];
      if (first !== undefined) setIfaceId(first.id);
      else {
        setIfaceMode('new');
        setIfaceDraft(blankPinoutDraft(id));
      }
    }
  };
  const newBody = (seed?: ConnectorBody): void => {
    setBodyMode('new');
    setBodyBaseline(undefined);
    const draft = seed === undefined ? blankBodyDraft() : { ...bodyDraftOf(seed), idTouched: true, labelTouched: true };
    setBodyDraft(draft);
    if (ifaceMode === 'pick') {
      setIfaceMode('new');
      setIfaceDraft(blankPinoutDraft(''));
    }
  };
  const editBody = (): void => {
    if (body === undefined) return;
    setBodyMode('edit');
    setBodyBaseline(body);
    setBodyDraft(bodyDraftOf(body));
  };
  const setBody = (patch: Partial<BodyDraft>): void => setBodyDraft((draft) => withBodyField(draft, patch, takenBodyIds));

  const pickIface = (id: string): void => {
    setIfaceMode('pick');
    setIfaceId(id);
    setIfaceBaseline(undefined);
    setProblem(undefined);
  };
  const newIface = (): void => {
    setIfaceMode('new');
    setIfaceBaseline(undefined);
    setIfaceDraft(blankPinoutDraft(body?.id ?? ''));
  };
  const editIface = (): void => {
    if (iface === undefined) return;
    setIfaceMode('edit');
    setIfaceBaseline(iface);
    setIfaceDraft(pinoutDraftOf(iface));
  };
  const setRow = (position: string, patch: Partial<PinoutRow>): void =>
    setIfaceDraft((draft) => {
      const row: PinoutRow = draft.rows[position] ?? { signal: '', label: '', dir: '', confidence: '', note: '' };
      return { ...draft, rows: { ...draft.rows, [position]: { ...row, ...patch } } };
    });
  const setIfaceLabel = (label: string): void =>
    setIfaceDraft((draft) => ({
      ...draft,
      label,
      ...(draft.idTouched ? {} : { id: suggestPinoutId(label, takenIfaceIds) }),
    }));

  const copyFrom = (id: string, mirror: boolean): void => {
    const source = interfaces.find((i) => i.id === id);
    if (source === undefined || body === undefined) return;
    setIfaceDraft((draft) => ({
      ...draft,
      rows: copyPinout(draft.rows, source, body, mirror),
      src:
        draft.src === ''
          ? `${mirror ? 'Mirrored' : 'Copied'} from pinout ${source.id} (${source.src})`
          : draft.src,
    }));
  };

  /* options */
  const familyLabel = (id: string): string => vocabNow?.['families']?.entries.find((e) => e.id === id)?.label ?? id;
  const bodyOptions = useMemo(
    (): PickOption[] =>
      bodies.map((b) => ({
        value: b.id,
        label: b.label,
        hint: `${b.positions.length} positions · ${b.id}`,
        group: familyLabel(b.family),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bodies, vocabNow],
  );
  const ifaceOptions = useMemo(
    (): PickOption[] =>
      bodyPinouts.map((i) => ({ value: i.id, label: i.label, hint: `${Object.keys(i.pins).length} pins · ${i.id}` })),
    [bodyPinouts],
  );
  const copyOptions = useMemo((): PickOption[] => {
    if (body === undefined) return [];
    return interfaces
      .filter((i) => i.id !== ifaceBaseline?.id && overlap(i, body) > 0)
      .sort((a, b) => overlap(b, body) - overlap(a, body))
      .map((i) => ({ value: i.id, label: i.label, hint: `${overlap(i, body)} of ${body.positions.length} positions · ${i.bodies.join(', ')}` }));
  }, [interfaces, body, ifaceBaseline]);
  const mirrorOptions = useMemo((): PickOption[] => {
    if (body === undefined) return [];
    const opposite = bodies.filter(
      (b) => b.gender !== body.gender && (b.id === body.mates || b.mates === body.id || b.family === body.family),
    );
    return interfaces
      .filter((i) => i.bodies.some((id) => opposite.some((b) => b.id === id)) && overlap(i, body) > 0)
      .map((i) => ({ value: i.id, label: i.label, hint: `on ${i.bodies.join(', ')}` }));
  }, [interfaces, bodies, body]);
  const mateOptions = useMemo((): PickOption[] => {
    if (body === undefined) return [];
    return bodies
      .filter((b) => b.gender !== body.gender && b.family === body.family && (b.mates === undefined || b.mates === body.id || b.mates === bodyBaseline?.id))
      .map((b) => ({ value: b.id, label: b.label, hint: b.id }));
  }, [bodies, body, bodyBaseline]);
  const templateChoices = [
    ...templatesFor(bodyDraft.family).map((t) => ({ value: t.id, label: t.label })),
    { value: CUSTOM_TEMPLATE, label: 'Custom count' },
  ];

  /* ---------------------------------------------------------------- *
   * Save: body, pinout, connector — each through the host's gate
   * ---------------------------------------------------------------- */

  const save = async (): Promise<void> => {
    if (definitions === undefined || body === undefined || iface === undefined || candidate === undefined) return;
    setBusy(true);
    setProblem(undefined);
    setStatus(undefined);
    const changes: DefinitionChange[] = [];
    const wrote: string[] = [];
    const stop = (result: DefinitionResult & { ok: false }): void => {
      setProblem({
        ...result.problem,
        message: wrote.length === 0 ? result.problem.message : `${result.problem.message} (${wrote.join(', ')} already saved)`,
      });
    };
    try {
      if (bodyDirty) {
        const mate = body.mates === undefined ? undefined : bodies.find((b) => b.id === body.mates);
        const needsMateBack = mate !== undefined && mate.mates !== body.id;
        const first = needsMateBack ? (({ mates: _m, ...rest }) => rest)(body) : body;
        let result =
          bodyMode === 'new'
            ? await createDefinition(definitions, 'bodies', first as ConnectorBody)
            : await saveDefinition(definitions, 'bodies', first as ConnectorBody);
        if (!result.ok) return stop(result);
        if (needsMateBack && mate !== undefined) {
          // a mate pair is two facts that must agree: the other body names this one back
          result = await saveDefinition(definitions, 'bodies', { ...mate, mates: body.id });
          if (!result.ok) return stop(result);
          changes.push(result.change);
          result = await saveDefinition(definitions, 'bodies', body);
          if (!result.ok) return stop(result);
          setSavedBodies((current) => mergeById(current, [{ ...mate, mates: body.id }]));
        }
        changes.push(result.change);
        wrote.push(body.id);
        setSavedBodies((current) => mergeById(current, [body]));
      }
      if (ifaceDirty) {
        const result =
          ifaceMode === 'new'
            ? await createDefinition(definitions, 'interfaces', iface)
            : await saveDefinition(definitions, 'interfaces', iface);
        if (!result.ok) return stop(result);
        changes.push(result.change);
        wrote.push(iface.id);
        setSavedIfaces((current) => mergeById(current, [iface]));
      }
      let saved: ConnectorDefinition = candidate;
      if (connectorDirty) {
        const result =
          connector === undefined
            ? await createDefinition(definitions, 'connectors', candidate)
            : await saveDefinition(definitions, 'connectors', candidate);
        if (!result.ok) return stop(result);
        changes.push(result.change);
        if (result.change.kind !== 'definition-deleted') saved = result.change.record as ConnectorDefinition;
        setSavedConnectors((current) => mergeById(current, [saved]));
      }
      setBodyMode('pick');
      setBodyId(body.id);
      setBodyBaseline(undefined);
      setIfaceMode('pick');
      setIfaceId(iface.id);
      setIfaceBaseline(undefined);
      setIdentity({ ...shownIdentity, idTouched: true, labelTouched: true });
      setStatus(`Saved ${[...wrote, saved.id].join(', ')}.`);
      props.onSaved(saved, connector === undefined, changes);
    } finally {
      setBusy(false);
    }
  };

  const revert = (): void => {
    setBodyMode('pick');
    setBodyId(startBody);
    setBodyBaseline(undefined);
    setIfaceMode(startIface === '' && startBody !== '' ? 'new' : 'pick');
    setIfaceId(startIface);
    setIfaceDraft(blankPinoutDraft(startBody));
    setIfaceBaseline(undefined);
    setIdentity(initialIdentity());
    setBodyTouched(false);
    setProblem(undefined);
  };

  /* ---------------------------------------------------------------- *
   * Screen
   * ---------------------------------------------------------------- */

  const locked = props.readOnly || busy;
  const pinoutEditable = ifaceMode !== 'pick' && !locked;
  const positions = body?.positions ?? [];
  const rows: Record<string, PinoutRow> =
    ifaceMode === 'pick' ? (iface === undefined ? {} : pinoutDraftOf(iface).rows) : ifaceDraft.rows;
  const assigned = positions.filter((p) => signalRefOf(rows[p.id]?.signal ?? '') !== undefined).length;

  return (
    <div className="cs-journey">
      <div className="cs-journey-steps">
        <FormSection
          title="1 · Body"
          say="The physical connector: family, gender and its numbered positions. The drawing belongs to the body — every pinout on it draws the same."
          right={
            bodyUsage === undefined || bodyMode !== 'pick' ? undefined : (
              <span className="cs-chip" title="Designs that use a connector on this body">
                {bodyUsage.designs.length} design{bodyUsage.designs.length === 1 ? '' : 's'}
              </span>
            )
          }
        >
          <div className="cs-journey-bar">
            {bodyMode === 'pick' ? (
              <Pick
                label="Body"
                options={bodyOptions}
                value={bodyId}
                placeholder="Pick a body"
                onChange={(id) => pickBody(id)}
                disabled={locked}
                wide
              />
            ) : (
              <span className="cs-journey-mode">{bodyMode === 'new' ? 'New body' : `Editing ${bodyBaseline?.id ?? ''}`}</span>
            )}
            <span className="cs-journey-tools">
              {bodyMode === 'pick' ? (
                <>
                  <button type="button" disabled={locked} onClick={() => newBody()}>
                    + New body
                  </button>
                  <button type="button" disabled={locked || body === undefined} onClick={editBody}>
                    Edit body
                  </button>
                  <button
                    type="button"
                    disabled={locked || body === undefined}
                    title="A new body with the same positions and the other gender, mated to this one"
                    onClick={() => body !== undefined && newBody(oppositeGenderBody(body, bodies.map((b) => b.id)))}
                  >
                    Opposite gender
                  </button>
                </>
              ) : (
                <button type="button" disabled={busy} onClick={() => pickBody(bodyBaseline?.id ?? bodyId)}>
                  Back to picking
                </button>
              )}
            </span>
          </div>

          {bodyMode === 'pick' && body !== undefined ? (
            <div className="cs-journey-facts">
              <span className="cs-chip">{familyLabel(body.family)}</span>
              <span className="cs-chip">{body.gender}</span>
              <span className="cs-chip" title={body.positions.map((p) => p.id).join(' ')}>
                {body.positions.length} positions
              </span>
              {body.partNumber === undefined ? null : <span className="cs-def-id cs-mono">{body.partNumber}</span>}
              {body.mates === undefined ? null : <span className="cs-def-id" title="mates with">⇄ {body.mates}</span>}
            </div>
          ) : null}

          {bodyMode === 'pick' && body !== undefined ? (
            <div className="cs-journey-shared">
              <span className="cs-journey-label">Pinouts on this body</span>
              {bodyPinouts.length === 0 ? <span className="cs-empty">none yet</span> : null}
              {bodyPinouts.map((p) => {
                const on = db.connectors.filter((c) => c.body === body.id && c.interface === p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={classes('cs-chip cs-chip-button', ifaceMode === 'pick' && ifaceId === p.id && 'is-active')}
                    disabled={locked}
                    title={on.length === 0 ? `${p.id} — no connector yet` : `${p.id} — connector ${on.map((c) => c.id).join(', ')}`}
                    onClick={() => pickIface(p.id)}
                  >
                    {p.label}
                    {on.length === 0 ? ' · no connector' : ''}
                  </button>
                );
              })}
              {bodyConnectors.filter((c) => c.id !== connector?.id).length === 0 || props.onOpenConnector === undefined ? null : (
                <>
                  <span className="cs-journey-label">Connectors</span>
                  {bodyConnectors
                    .filter((c) => c.id !== connector?.id)
                    .map((c) => (
                      <button key={c.id} type="button" className="cs-link" onClick={() => props.onOpenConnector!(c.id)}>
                        {c.id}
                      </button>
                    ))}
                </>
              )}
            </div>
          ) : null}

          {bodyMode === 'pick' ? null : (
            <fieldset disabled={locked} className="cs-journey-fields">
              {bodyMode === 'edit' && bodyConnectors.length > 0 ? (
                <p className="cs-doc-warning">
                  Shared: {bodyConnectors.length} connector{bodyConnectors.length === 1 ? '' : 's'} and{' '}
                  {bodyPinouts.length} pinout{bodyPinouts.length === 1 ? '' : 's'} are on this body.
                </p>
              ) : null}
              <div className="cs-form-grid">
                <Pick
                  label="Family"
                  list="families"
                  value={bodyDraft.family}
                  placeholder="Pick a family"
                  onChange={(id) => setBody({ family: id })}
                />
                <Pick
                  label="Gender"
                  say="Male is the plug, female the socket. The list is open: type a gender it lacks to add it (with its source)."
                  list="genders"
                  value={bodyDraft.gender}
                  onChange={(value) => {
                    if (value !== '') setBody({ gender: value });
                  }}
                />
                <Choice
                  label="Layout"
                  say="The family's standard layouts lay out the positions and name the builder drawing."
                  value={bodyDraft.template}
                  onChange={(value) => setBody({ template: value })}
                  choices={bodyDraft.family === '' ? [{ value: '', label: 'Pick a family first' }] : templateChoices}
                />
                {bodyDraft.template === CUSTOM_TEMPLATE ? (
                  <>
                    <Field label="Positions" value={bodyDraft.count} onChange={(value) => setBody({ count: value })} mono />
                    <label className="cs-field cs-check">
                      <input type="checkbox" checked={bodyDraft.shell} onChange={(event) => setBody({ shell: event.target.checked })} />
                      <span>Shell is a position</span>
                    </label>
                  </>
                ) : null}
                <Field
                  label="Name"
                  value={bodyDraft.label}
                  onChange={(value) => setBodyDraft((d) => ({ ...d, label: value, labelTouched: true }))}
                  placeholder="Family, angle, gender"
                />
                <Field
                  label="Id"
                  value={bodyDraft.id}
                  onChange={(value) => setBodyDraft((d) => ({ ...d, id: value, idTouched: true }))}
                  placeholder="follows the name"
                  mono
                />
                <Field
                  label="Part number"
                  say="The bare plug or socket as a stock item."
                  value={bodyDraft.partNumber}
                  onChange={(value) => setBodyDraft((d) => ({ ...d, partNumber: value }))}
                  placeholder="e.g. CON-00012"
                  mono
                />
                <Pick
                  label="Construction"
                  say="How this body is terminated: solder cup, PCB mount, … — every connector on it is, unless it says otherwise."
                  list="connector-constructions"
                  value={bodyDraft.construction}
                  clearable
                  noneLabel="not known"
                  onChange={(value) => setBodyDraft((d) => ({ ...d, construction: value }))}
                />
                <Pick
                  label="Mates with"
                  say="The opposite-gender body this one plugs into."
                  options={mateOptions}
                  value={bodyDraft.mates}
                  clearable
                  noneLabel="none"
                  placeholder="—"
                  onChange={(id) => setBodyDraft((d) => ({ ...d, mates: id }))}
                />
              </div>
              <HousingSection
                of="body"
                value={bodyDraft.housing}
                onChange={(housing) =>
                  setBodyDraft((d) => {
                    const { housing: _old, ...rest } = d;
                    return housing === undefined ? rest : { ...rest, housing };
                  })
                }
              />
              <SrcField value={bodyDraft.src} onChange={(value) => setBodyDraft((d) => ({ ...d, src: value }))} />
            </fieldset>
          )}
        </FormSection>

        <FormSection
          title="2 · Pinout"
          say="Which signal each position of the body carries. Signals are picked from the list; the label is optional."
          right={
            body === undefined ? undefined : (
              <span className="cs-count" title="positions assigned a signal">
                {assigned}/{positions.length}
              </span>
            )
          }
        >
          {body === undefined ? (
            <p className="cs-empty">Pick or make a body first.</p>
          ) : (
            <>
              <div className="cs-journey-bar">
                {ifaceMode === 'pick' ? (
                  <Pick
                    label="Pinout"
                    options={ifaceOptions}
                    value={ifaceId}
                    placeholder="Pick a pinout"
                    onChange={(id) => pickIface(id)}
                    disabled={locked}
                    wide
                  />
                ) : (
                  <span className="cs-journey-mode">{ifaceMode === 'new' ? 'New pinout' : `Editing ${ifaceBaseline?.id ?? ''}`}</span>
                )}
                <span className="cs-journey-tools">
                  {ifaceMode === 'pick' ? (
                    <>
                      <button type="button" disabled={locked} onClick={newIface}>
                        + New pinout
                      </button>
                      <button type="button" disabled={locked || iface === undefined} onClick={editIface}>
                        Edit pinout
                      </button>
                    </>
                  ) : (
                    <>
                      <Pick
                        ariaLabel="copy from pinout"
                        options={copyOptions}
                        value=""
                        placeholder="Copy from…"
                        disabled={locked}
                        onChange={(id) => copyFrom(id, false)}
                      />
                      <Pick
                        ariaLabel="mirror a pinout of the opposite gender"
                        options={mirrorOptions}
                        value=""
                        placeholder={mirrorOptions.length === 0 ? 'Mirror (none)' : 'Mirror…'}
                        disabled={locked || mirrorOptions.length === 0}
                        onChange={(id) => copyFrom(id, true)}
                      />
                      {bodyPinouts.length === 0 ? null : (
                        <button type="button" disabled={busy} onClick={() => pickIface(ifaceBaseline?.id ?? bodyPinouts[0]!.id)}>
                          Back to picking
                        </button>
                      )}
                    </>
                  )}
                </span>
              </div>

              {ifaceMode === 'edit' && ifaceConnectors.length > 0 ? (
                <p className="cs-doc-warning">
                  Shared: {ifaceConnectors.map((c) => c.id).join(', ')} {ifaceConnectors.length === 1 ? 'uses' : 'use'} this pinout too.
                </p>
              ) : null}

              {ifaceMode === 'pick' ? null : (
                <fieldset disabled={locked} className="cs-journey-fields">
                  <div className="cs-form-grid">
                    <Field label="Name" value={ifaceDraft.label} onChange={setIfaceLabel} placeholder="Device / port" />
                    <Field
                      label="Id"
                      value={ifaceDraft.id}
                      onChange={(value) => setIfaceDraft((d) => ({ ...d, id: value, idTouched: true }))}
                      placeholder="follows the name"
                      mono
                    />
                  </div>
                </fieldset>
              )}

              <div className="cs-journey-table">
                <table className="cs-rows cs-pinout-rows">
                  <thead>
                    <tr>
                      <th scope="col">Pos</th>
                      <th scope="col">Signal</th>
                      <th scope="col" title="Optional — the signal's own label when blank">
                        Label
                      </th>
                      <th scope="col" title="As seen from the device that owns the port">
                        Dir
                      </th>
                      <th scope="col">Confidence</th>
                      <th scope="col">Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map((position) => {
                      const row = rows[position.id] ?? { signal: '', label: '', dir: '', confidence: '', note: '' };
                      return (
                        <tr key={position.id} className={classes(row.signal === '' && 'is-unassigned')}>
                          <td className="cs-mono">{position.id}</td>
                          <td className="cs-pick-cell">
                            <Pick
                              list="signals"
                              ariaLabel={`position ${position.id} signal`}
                              value={row.signal}
                              clearable
                              noneLabel="not assigned"
                              placeholder="—"
                              disabled={!pinoutEditable}
                              onChange={(id) => setRow(position.id, { signal: id })}
                            />
                          </td>
                          <td>
                            <input
                              aria-label={`position ${position.id} label`}
                              value={row.label}
                              disabled={!pinoutEditable}
                              onChange={(event) => setRow(position.id, { label: event.target.value })}
                            />
                          </td>
                          <td>
                            <select
                              aria-label={`position ${position.id} direction`}
                              value={row.dir}
                              disabled={!pinoutEditable}
                              onChange={(event) => setRow(position.id, { dir: event.target.value as PinoutRow['dir'] })}
                            >
                              {['', ...PIN_DIRS].map((dir) => (
                                <option key={dir} value={dir}>
                                  {DIR_LABEL[dir]}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <select
                              aria-label={`position ${position.id} confidence`}
                              value={row.confidence}
                              disabled={!pinoutEditable}
                              onChange={(event) => setRow(position.id, { confidence: event.target.value as PinoutRow['confidence'] })}
                            >
                              {['', ...CONFIDENCES].map((c) => (
                                <option key={c} value={c}>
                                  {CONFIDENCE_LABEL[c]}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              aria-label={`position ${position.id} note`}
                              value={row.note}
                              disabled={!pinoutEditable}
                              onChange={(event) => setRow(position.id, { note: event.target.value })}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {ifaceMode === 'pick' ? null : (
                <fieldset disabled={locked} className="cs-journey-fields">
                  <SrcField value={ifaceDraft.src} onChange={(value) => setIfaceDraft((d) => ({ ...d, src: value }))} />
                </fieldset>
              )}
            </>
          )}
        </FormSection>

        <FormSection title="3 · Connector" say="The body and pinout as one orderable part — what designs reference.">
          <fieldset disabled={locked} className="cs-journey-fields">
            <div className="cs-form-grid">
              <Field
                label="Name"
                value={shownIdentity.label}
                onChange={(value) => setIdentity((i) => ({ ...i, label: value, labelTouched: true }))}
                placeholder="Body (pinout)"
                wide
              />
              <Field
                label="Id"
                say={connector === undefined ? 'Follows the name until typed.' : 'Fixed: every design refers to this connector by its id.'}
                value={shownIdentity.id}
                onChange={(value) => connector === undefined && setIdentity((i) => ({ ...i, id: value, idTouched: true }))}
                mono
              />
              <Field
                label="Part number"
                say="Your stock number for this connector. It may differ from the physical body’s number; leave blank to use the body’s."
                value={identity.partNumber}
                onChange={(value) => setIdentity((i) => ({ ...i, partNumber: value }))}
                placeholder={body?.partNumber ?? 'e.g. CON-00012'}
                mono
              />
              <Pick
                label="Construction"
                say="How it is terminated — solder cup, PCB mount, crimp, moulded … Same pinout, another construction is another connector. Blank: the body's."
                list="connector-constructions"
                value={identity.construction}
                clearable
                noneLabel={body?.construction === undefined ? 'not known' : `as the body (${constructionLabel(vocabNow, body.construction)})`}
                placeholder={body?.construction === undefined ? 'not known' : constructionLabel(vocabNow, body.construction)}
                onChange={(value) => setIdentity((i) => ({ ...i, construction: value }))}
              />
              <Pick
                label="Sourcing"
                say="Whether the bench terminates it at all — pre-made lead, bought as a finished whip. Blank: terminated on the bench as normal."
                list="connector-sourcing"
                value={identity.sourcing}
                clearable
                noneLabel="terminated on the bench"
                placeholder="terminated on the bench"
                onChange={(value) => setIdentity((i) => ({ ...i, sourcing: value }))}
              />
            </div>
            <SrcField value={identity.src} onChange={(value) => setIdentity((i) => ({ ...i, src: value }))} />
          </fieldset>
        </FormSection>

        {libraryIssues.length === 0 ? null : (
          <div className="cs-problem" role="status">
            <strong>
              This would break {libraryIssues.length === 1 ? 'something' : `${libraryIssues.length} things`} in the library
            </strong>
            <ul className="cs-problem-list">
              {libraryIssues.map((issue, index) => (
                <li key={index}>{describeIssue(issue)}</li>
              ))}
            </ul>
          </div>
        )}
        {problem === undefined ? null : <ProblemBox problem={problem} />}
        {duplicates.length === 0 ? null : (
          <p className="cs-doc-warning" role="status" data-testid="duplicate-connector">
            Same body and pinout as {duplicates.join(', ')} — this would be a duplicate.
          </p>
        )}

        <div className="cs-def-actions">
          <button
            type="button"
            className="cs-primary"
            disabled={props.readOnly || busy || !dirty || candidate === undefined}
            title={candidate === undefined ? 'Pick or make a body and a pinout first' : dirty ? 'Write to the catalog' : 'Nothing has changed'}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : connector === undefined ? (duplicates.length > 0 ? 'Add duplicate anyway' : 'Add this connector') : 'Save'}
          </button>
          {connector === undefined && !dirty ? null : (
            <button type="button" disabled={busy || !dirty} onClick={revert}>
              Revert
            </button>
          )}
          <button type="button" disabled={busy} onClick={props.onClose}>
            {connector === undefined ? 'Cancel' : 'Close'}
          </button>
          {connector !== undefined && props.onDelete !== undefined && !props.readOnly ? (
            <button type="button" className="cs-danger-quiet" disabled={busy} onClick={props.onDelete}>
              Delete…
            </button>
          ) : null}
          {connector === undefined && !dirty && status === undefined ? null : (
          <span className={classes('cs-chip', dirty && 'is-dirty')}>
            {dirty
              ? [bodyDirty && 'body', ifaceDirty && 'pinout', connectorDirty && 'connector'].filter(Boolean).join(' + ') + ' unsaved'
              : (status ?? 'saved')}
          </span>
          )}
        </div>
        <details className="cs-advanced">
          <summary title="Exactly what Save writes: the body, the pinout and the connector (stored without its composed pins).">
            Advanced: the records as JSON
          </summary>
          <pre className="cs-json-view">{JSON.stringify({ body, pinout: iface, connector: candidate }, null, 2)}</pre>
        </details>
      </div>

      <aside className="cs-journey-art" aria-label="builder art">
        {art !== undefined && artDef !== undefined ? (
          <BuiltInConnectorArt def={artDef} art={art} {...(body === undefined ? {} : { body })} sharedBy={sharedBy} />
        ) : (
          <p className="cs-empty">
            {body === undefined
              ? 'The builder art appears here once a body is picked.'
              : 'No built-in drawing for this layout — the builder shows a pin list. Upload art on the Artwork tab after saving.'}
          </p>
        )}
        {body === undefined || sharedBy.length < 2 ? null : (
          <p className="cs-journey-note" title="The drawing belongs to the body">
            Same drawing for: {sharedBy.join(' · ')}
          </p>
        )}
      </aside>
    </div>
  );
}

/** The layouts every family offers — exported for the tests. */
export const JOURNEY_TEMPLATES = BODY_TEMPLATES;

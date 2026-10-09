/**
 * Validation rules as data (`server/rules-settings.ts`, `@wirehub/model` `rules.ts`): the
 * hub's own rules and those a pack ships, an editor for one rule as JSON with examples to
 * start from, a test over every design before saving, and Save (owner or editor). The rules
 * run inside the validators, so their findings are in each design's issues panel.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { previewRule, rulesKey, rulesQuery, saveRules, type RulePreview, type RuleView } from '../settings.browser.ts';
import { draftObject, RuleEditor } from './DeclarativeEditors.tsx';
import { useStudio } from '../studio-context.tsx';
import { Button, Select, Textarea } from '@wirehub/editor-react';

/** examples: the four rule shapes the docs describe (docs/validation-rules.md); generic data only */
export const RULE_EXAMPLES: { label: string; rule: Record<string, unknown> }[] = [
  {
    label: 'Pin joined on a family, for tagged designs',
    rule: {
      id: 'example-pin-joined',
      severity: 'error',
      each: 'connector',
      where: { all: [{ eq: [{ path: 'family' }, 'd-sub'] }, { contains: [{ path: 'design.tags' }, 'shielded'] }] },
      require: { contains: [{ path: 'pinsJoined' }, '9'] },
      message: '{id} ({family}) on {design.id} must have pin 9 joined',
      src: 'synthetic example',
    },
  },
  {
    label: 'Minimum conductor area on power signals',
    rule: {
      id: 'example-power-area',
      severity: 'error',
      each: 'conductor',
      where: { contains: [{ path: 'signalKinds' }, 'power'] },
      require: { gte: [{ path: 'areaMm2' }, 0.5] },
      message: '{id} carries {signals} and is {areaMm2} mm², under 0.5 mm²',
      src: 'synthetic example',
    },
  },
  {
    label: 'A boot on every connector of a family',
    rule: {
      id: 'example-boot',
      severity: 'warning',
      each: 'connector',
      where: { eq: [{ path: 'family' }, 'd-sub'] },
      require: { contains: [{ path: 'mechanicalKinds' }, 'boot'] },
      message: '{id} has no strain-relief boot',
      src: 'synthetic example',
    },
  },
  {
    label: 'A part required on a signal between its ends',
    rule: {
      id: 'example-series-part',
      severity: 'error',
      each: 'signal-path',
      where: { eq: [{ path: 'signal' }, 'pwr-v'] },
      require: { some: { in: 'components', where: { eq: [{ path: 'category' }, 'resistor'] } } },
      message: '{signal} from {from.instance} to {to.instance} has no series resistor',
      src: 'synthetic example',
    },
  },
  {
    label: 'Each end of a design with a connector needs a shell',
    rule: {
      id: 'example-end-shell',
      severity: 'warning',
      each: 'cable-end',
      where: { gt: [{ path: 'connectorCount' }, 0] },
      require: { gt: [{ path: 'shellCount' }, 0] },
      message: '{segment} end {end} has a connector and no shell',
      src: 'synthetic example',
    },
  },
];

const pretty = (v: unknown): string => JSON.stringify(v, null, 2);

export function RulesSettings(): JSX.Element {
  const editor = useRef<HTMLElement>(null);
  const client = useQueryClient();
  const { me } = useStudio();
  const readOnly = me?.role === 'viewer';
  const query = useQuery(rulesQuery);
  const view = query.data;
  const [editing, setEditing] = useState<{ text: string; replaces?: string } | undefined>(undefined);
  const [result, setResult] = useState<RulePreview | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const strip = (r: RuleView): Record<string, unknown> => {
    const { origin: _o, pack: _p, problems: _pr, ...rule } = r;
    return rule;
  };

  const persist = async (rules: unknown[], done: string): Promise<boolean> => {
    if (view === undefined) return false;
    setBusy(true);
    const out = await saveRules(rules, view.etag);
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return false;
    }
    client.setQueryData(rulesKey, out.value);
    // the editors validate against these rules: refresh what they hold
    void client.invalidateQueries({ queryKey: ['studio', 'db'] });
    toast.success(done);
    return true;
  };

  const parse = (): Record<string, unknown> | undefined => {
    if (editing === undefined) return undefined;
    if (editor.current?.querySelector('[data-invalid-json="true"]')) {
      toast.error('Correct the invalid JSON field before testing or saving.');
      return undefined;
    }
    try {
      return JSON.parse(editing.text) as Record<string, unknown>;
    } catch (error) {
      toast.error('That is not valid JSON.', { description: error instanceof Error ? error.message : undefined });
      return undefined;
    }
  };

  const test = async (): Promise<void> => {
    const rule = parse();
    if (rule === undefined) return;
    setBusy(true);
    const out = await previewRule(rule);
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    setResult(out.value);
  };

  const saveEdit = async (): Promise<void> => {
    const rule = parse();
    if (rule === undefined || view === undefined) return;
    const others = view.local.filter((r) => r.id !== (editing?.replaces ?? rule['id']) && r.id !== rule['id']);
    if (await persist([...others, rule], `Saved rule ${String(rule['id'])}. It runs on every design from now on.`)) {
      setEditing(undefined);
      setResult(undefined);
    }
  };

  const toggle = async (r: RuleView): Promise<void> => {
    if (view === undefined) return;
    const rule = { ...strip(r), enabled: r.enabled === false };
    const others = view.local.filter((x) => x.id !== r.id);
    await persist([...others, rule], r.enabled === false ? `Rule ${r.id} is on.` : `Rule ${r.id} is off.`);
  };

  const remove = async (r: RuleView): Promise<void> => {
    if (view === undefined) return;
    await persist(view.local.filter((x) => x.id !== r.id), `Removed rule ${r.id}.`);
  };

  return (
    <section ref={editor} className="mt-6 max-w-2xl border-t border-line pt-3" data-testid="rules-settings">
      <h2 className="mb-1 text-sm font-semibold">Validation rules</h2>
      <p className="mb-2 max-w-xl text-faint">
        Checks written as data: what each rule is about, which of those it applies to, what must hold, a severity and a message. They run with the built-in checks, so they show in each design’s issues panel, and an error blocks a save. No code runs; complex cases stay code rules in a module.
      </p>
      {view === undefined ? (
        <div className="text-faint">{query.isError ? 'The rules could not be read.' : 'Loading…'}</div>
      ) : (
        <>
          {view.rules.length === 0 ? <div className="text-faint">No rules yet.</div> : null}
          <ul>
            {view.rules.map((r) => (
              <li key={r.id} className="my-1 border border-line p-2" data-rule={r.id}>
                <b>{r.id}</b> · {r.severity} · on {r.each}
                {r.enabled === false ? ' · off' : ''}
                {r.origin === 'pack' ? ` · from pack ${r.pack ?? ''}` : ''}
                <div className="text-faint">{r.message}</div>
                {r.problems.length > 0 ? <div role="alert" className="text-err">Cannot be used: {r.problems[0]}</div> : null}
                {readOnly ? null : (
                  <div className="mt-1 flex gap-3">
                    <Button type="button" variant="ghost" size="xs" onClick={() => setEditing({ text: pretty(strip(r)), replaces: r.id })}>
                      {r.origin === 'pack' ? 'Override…' : 'Edit…'}
                    </Button>
                    <Button type="button" disabled={busy} onClick={() => void toggle(r)} variant="ghost" size="xs">
                      {r.enabled === false ? 'Turn on' : 'Turn off'}
                    </Button>
                    {r.origin === 'local' ? (
                      <Button type="button" disabled={busy} onClick={() => void remove(r)} variant="ghost" size="xs">
                        Remove
                      </Button>
                    ) : null}
                  </div>
                )}
              </li>
            ))}
          </ul>
          {readOnly ? null : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Select
                aria-label="New rule from an example"
                className="w-64"
                placeholder="New rule from an example…"
                value={undefined}
                options={RULE_EXAMPLES.map((x, i) => ({ value: String(i), label: x.label }))}
                onValueChange={(value) => {
                  const example = RULE_EXAMPLES[Number(value)];
                  if (example !== undefined) setEditing({ text: pretty(example.rule) });
                }}
              />
            </div>
          )}
          {editing === undefined ? null : (
            <div className="mt-2" data-testid="rule-editor">
              {draftObject(editing.text) === undefined ? <p className="text-faint">Correct the advanced JSON to use the form.</p> : <RuleEditor value={draftObject(editing.text)!} onChange={(next) => { setEditing({ ...editing, text: pretty(next) }); setResult(undefined); }} />}
              <details className="mt-2"><summary>Advanced rule JSON</summary>
                <Textarea aria-label="Rule definition" value={editing.text} spellCheck={false} mono className="w-full" onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
              </details>
              <div className="mt-1 flex gap-2">
                <Button type="button" disabled={busy} onClick={() => void test()}>
                  Test on my designs
                </Button>
                <Button type="button" disabled={busy} onClick={() => void saveEdit()} variant="primary">
                  Save rule
                </Button>
                <Button type="button" variant="ghost" size="xs" onClick={() => { setEditing(undefined); setResult(undefined); }}>
                  Cancel
                </Button>
              </div>
              {result === undefined ? null : result.ok ? (
                <div className="mt-1" data-testid="rule-test">
                  It would raise {result.errors ?? 0} error(s) and {result.warnings ?? 0} warning(s)
                  {(result.designs ?? []).length === 0 && (result.library?.issues ?? 0) === 0 ? ': nothing today.' : ':'}
                  {(result.designs ?? []).map((d) => (
                    <div key={d.id}>
                      <b>{d.id}</b>: {d.examples.map((x) => x.message).join('; ')}
                      {d.issues > d.examples.length ? ` (and ${d.issues - d.examples.length} more)` : ''}
                    </div>
                  ))}
                  {(result.library?.examples ?? []).map((x) => (
                    <div key={x.message}>Library: {x.message}</div>
                  ))}
                </div>
              ) : (
                <ul role="alert" className="mt-1 text-err">
                  {(result.problems ?? []).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

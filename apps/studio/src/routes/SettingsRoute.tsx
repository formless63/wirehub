/**
 * `/settings` — the hub's identity on its documents: organisation name, the
 * wire spec's standard name, a rights line, a default designer and a logo
 * (`server/settings.ts`). An owner or an editor saves; a viewer reads. What is
 * left empty keeps the documents' generic text, and a module's own art still wins.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type JSX } from 'react';
import { toast } from 'sonner';

import { brandingKey, brandingQuery, saveBranding, type BrandingView } from '../settings.browser.ts';
import { EngineeringSettings } from './EngineeringSettings.tsx';
import { StoreSourcesSettings } from './StoreSourcesSettings.tsx';
import { useStudio } from '../studio-context.tsx';

const FIELDS = [
  { key: 'organisation', label: 'Organisation name', hint: 'Printed on the wire spec and the bench sheets.' },
  { key: 'standard', label: 'Standard name', hint: 'What the wire spec calls itself; empty keeps “WireHub Standard”.' },
  { key: 'rights', label: 'Rights / confidentiality line', hint: 'The drawing sheet’s title block and the wire spec’s footer.' },
  { key: 'designer', label: 'Default designer', hint: 'Printed when a drawing names none.' },
  { key: 'filePrefix', label: 'Wire spec file prefix', hint: 'What exported wire spec files start with; empty keeps “WSS_”. Letters, digits, dot, dash, underscore; up to 16.' },
] as const;

type Draft = Record<(typeof FIELDS)[number]['key'], string> & {
  notes: [string, string, string];
  tolerances: [string, string][];
};

/** what the sheet prints when nothing is set: shown as placeholders so a person edits from it */
const DEFAULT_NOTES = ['ALL DIMENSIONS ARE', 'IN MM UNLESS', 'OTHERWISE SPECIFIED'] as const;
const DEFAULT_TOLERANCES = [
  ['x.xx', '± 0.1'],
  ['x.xxx', '± 0.03'],
  ['x.xxx', '± 0.005'],
  ['FRACTIONAL', '± 1/16'],
  ['ANGLE', '± 1°'],
] as const;

const draftOf = (view: BrandingView | undefined): Draft => ({
  notes: [view?.notes?.[0] ?? '', view?.notes?.[1] ?? '', view?.notes?.[2] ?? ''],
  tolerances: DEFAULT_TOLERANCES.map((_, i) => [view?.tolerances?.[i]?.[0] ?? '', view?.tolerances?.[i]?.[1] ?? ''] as [string, string]),
  organisation: view?.organisation ?? '',
  standard: view?.standard ?? '',
  rights: view?.rights ?? '',
  designer: view?.designer ?? '',
  filePrefix: view?.filePrefix ?? '',
});

const readAsDataUri = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });

export function SettingsRoute(): JSX.Element {
  const client = useQueryClient();
  const { me } = useStudio();
  const readOnly = me?.role === 'viewer';
  const query = useQuery(brandingQuery);
  const [draft, setDraft] = useState<Draft>(draftOf(undefined));
  /** undefined: keep the stored logo; null: remove it; a data URI: replace it */
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (query.data !== undefined) setDraft(draftOf(query.data));
  }, [query.data]);

  const shown = logo === undefined ? query.data?.logoDataUri : (logo ?? undefined);
  const save = async (): Promise<void> => {
    if (query.data === undefined) return;
    setBusy(true);
    const out = await saveBranding({ ...draft, ...(logo === undefined ? {} : { logo }) }, query.data.etag);
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    client.setQueryData(brandingKey, out.value);
    setLogo(undefined);
    toast.success('Saved. New documents carry it.');
  };
  const pick = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    if (file.type !== 'image/png' && file.type !== 'image/svg+xml') {
      toast.error('The logo must be a PNG or an SVG.', { description: 'Export a JPEG as a PNG first.' });
      return;
    }
    setLogo(await readAsDataUri(file));
  };

  return (
    <div className="h-full min-h-0 overflow-auto p-4 text-[12.5px]" data-testid="settings">
      <h1 className="mb-1 text-[14px] font-semibold">Hub settings</h1>
      <p className="mb-3 max-w-xl text-faint">Who the documents are issued by. Leave a field empty to keep the generic text. A module that supplies its own title-block art takes precedence.</p>
      {query.isError ? <div role="alert">{query.error instanceof Error ? query.error.message : 'The settings could not be read.'}</div> : null}
      {query.data === undefined ? (
        query.isError ? null : <div className="text-faint">Loading…</div>
      ) : (
        <form
          className="flex max-w-xl flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-0.5">
              <span className="font-medium">{f.label}</span>
              <input
                className="rounded border border-line bg-panel px-2 py-1"
                aria-label={f.label}
                value={draft[f.key]}
                disabled={readOnly}
                maxLength={f.key === 'rights' ? 160 : f.key === 'filePrefix' ? 16 : 80}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
              <span className="text-faint">{f.hint}</span>
            </label>
          ))}
          <fieldset className="flex flex-col gap-1 border-0 p-0">
            <legend className="font-medium">Drawing general note</legend>
            {DEFAULT_NOTES.map((placeholder, i) => (
              <input
                key={placeholder}
                className="rounded border border-line bg-panel px-2 py-1"
                aria-label={`General note line ${i + 1}`}
                placeholder={placeholder}
                value={draft.notes[i]}
                disabled={readOnly}
                maxLength={24}
                onChange={(e) => setDraft({ ...draft, notes: draft.notes.map((line, j) => (j === i ? e.target.value : line)) as Draft['notes'] })}
              />
            ))}
            <span className="text-faint">The three lines beside the tolerances in the title block; up to 24 characters each. Empty keeps the generic note.</span>
          </fieldset>
          <fieldset className="flex flex-col gap-1 border-0 p-0">
            <legend className="font-medium">Drawing tolerances</legend>
            {DEFAULT_TOLERANCES.map(([labelHint, valueHint], i) => (
              <div key={i} className="flex gap-2">
                <input
                  className="w-32 rounded border border-line bg-panel px-2 py-1"
                  aria-label={`Tolerance ${i + 1} label`}
                  placeholder={labelHint}
                  value={draft.tolerances[i]?.[0] ?? ''}
                  disabled={readOnly}
                  maxLength={12}
                  onChange={(e) => setDraft({ ...draft, tolerances: draft.tolerances.map((row, j) => (j === i ? [e.target.value, row[1]] : row)) as Draft['tolerances'] })}
                />
                <input
                  className="w-28 rounded border border-line bg-panel px-2 py-1"
                  aria-label={`Tolerance ${i + 1} value`}
                  placeholder={valueHint}
                  value={draft.tolerances[i]?.[1] ?? ''}
                  disabled={readOnly}
                  maxLength={10}
                  onChange={(e) => setDraft({ ...draft, tolerances: draft.tolerances.map((row, j) => (j === i ? [row[0], e.target.value] : row)) as Draft['tolerances'] })}
                />
              </div>
            ))}
            <span className="text-faint">Up to five rows, printed in the title block. Leave all empty to keep the generic table. A per-profile override comes with drawing standards (cs-ml3).</span>
          </fieldset>
          <div className="flex flex-col gap-1">
            <span className="font-medium">Title-block logo</span>
            {shown === undefined ? <span className="text-faint">No logo.</span> : <img src={shown} alt="Logo preview" className="max-h-16 max-w-48 self-start border border-line bg-white p-1" />}
            {readOnly ? null : (
              <div className="flex items-center gap-3">
                <input type="file" accept="image/png,image/svg+xml" aria-label="Logo file" onChange={(e) => void pick(e.target.files?.[0])} />
                {shown === undefined ? null : (
                  <button type="button" className="underline" onClick={() => setLogo(null)}>
                    Remove
                  </button>
                )}
              </div>
            )}
            <span className="text-faint">PNG or SVG, up to 512 KiB. Metadata is stripped when it is saved; an SVG is cleaned of scripts and drawn to a PNG.</span>
          </div>
          {readOnly ? <div className="text-faint">Your role can view these settings but not change them.</div> : null}
          <div>
            <button type="submit" disabled={readOnly || busy} className="rounded border border-line bg-accent px-3 py-1 text-accent-ink disabled:opacity-50">
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
      <EngineeringSettings />
      <StoreSourcesSettings />
    </div>
  );
}

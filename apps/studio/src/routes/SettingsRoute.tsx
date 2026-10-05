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
import { useStudio } from '../studio-context.tsx';

const FIELDS = [
  { key: 'organisation', label: 'Organisation name', hint: 'Printed on the wire spec and the bench sheets.' },
  { key: 'standard', label: 'Standard name', hint: 'What the wire spec calls itself; empty keeps “WireHub Standard”.' },
  { key: 'rights', label: 'Rights / confidentiality line', hint: 'The drawing sheet’s title block and the wire spec’s footer.' },
  { key: 'designer', label: 'Default designer', hint: 'Printed when a drawing names none.' },
] as const;

type Draft = Record<(typeof FIELDS)[number]['key'], string>;

const draftOf = (view: BrandingView | undefined): Draft => ({
  organisation: view?.organisation ?? '',
  standard: view?.standard ?? '',
  rights: view?.rights ?? '',
  designer: view?.designer ?? '',
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
    if (file.type !== 'image/png') {
      toast.error('The logo must be a PNG.', { description: 'Export your SVG or JPEG as a PNG first.' });
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
                maxLength={f.key === 'rights' ? 160 : 80}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
              <span className="text-faint">{f.hint}</span>
            </label>
          ))}
          <div className="flex flex-col gap-1">
            <span className="font-medium">Title-block logo</span>
            {shown === undefined ? <span className="text-faint">No logo.</span> : <img src={shown} alt="Logo preview" className="max-h-16 max-w-48 self-start border border-line bg-white p-1" />}
            {readOnly ? null : (
              <div className="flex items-center gap-3">
                <input type="file" accept="image/png" aria-label="Logo file" onChange={(e) => void pick(e.target.files?.[0])} />
                {shown === undefined ? null : (
                  <button type="button" className="underline" onClick={() => setLogo(null)}>
                    Remove
                  </button>
                )}
              </div>
            )}
            <span className="text-faint">PNG, up to 512 KiB. Metadata is stripped when it is saved.</span>
          </div>
          {readOnly ? <div className="text-faint">Your role can view these settings but not change them.</div> : null}
          <div>
            <button type="submit" disabled={readOnly || busy} className="rounded border border-line bg-accent px-3 py-1 text-accent-ink disabled:opacity-50">
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

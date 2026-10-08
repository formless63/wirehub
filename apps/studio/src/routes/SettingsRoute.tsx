/**
 * `/settings` — the hub's identity on its documents: organisation name, the
 * wire spec's standard name, a rights line, a default designer and a logo
 * (`server/settings.ts`), a typeface the documents are set in and drawing art as data. An owner or
 * an editor saves; a viewer reads. What is left empty keeps the documents' generic text, and a
 * module's own art still wins.
 */

import { Link, useNavigate } from '@tanstack/react-router';
import { settingsRoute } from '../router.tsx';
import { helpForSettingsSection } from '../help.ts';
import { useDocsBase } from '../hooks/useDocsBase.ts';
import { InfoTip } from '../shell/InfoTip.tsx';
import { SETTINGS_SECTIONS, sectionHelp, settingsSection } from '../settings-sections.ts';
import './settings-sections.css';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type JSX } from 'react';
import { toast } from 'sonner';
import { Select } from '@wirehub/editor-react';
import { PAPERS, PAPER_IDS, TITLE_BLOCKS, TITLE_BLOCK_STANDARDS, type PaperId, type TitleBlockStandard } from '@wirehub/docs';

import { brandingKey, brandingQuery, fetchFonts, fontsKey, saveBranding, uploadFont, type BrandingView, type FontChoice } from '../settings.browser.ts';
import { EngineeringSettings } from './EngineeringSettings.tsx';
import { PartNumberSettings } from './PartNumberSettings.tsx';
import { RulesSettings } from './RulesSettings.tsx';
import { ModuleSettings } from './ModuleSettings.tsx';
import { RuntimeSettings } from './RuntimeSettings.tsx';
import { WebhookSettings } from './WebhookSettings.tsx';
import { StoreSourcesSettings } from './StoreSourcesSettings.tsx';
import { CodeModulesSettings } from './CodeModulesSettings.tsx';
import { useStudio } from '../studio-context.tsx';

const FIELDS = [
  { key: 'organisation', label: 'Organisation name', hint: 'Printed on the wire spec and the bench sheets.' },
  { key: 'standard', label: 'Standard name', hint: 'What the wire spec calls itself; empty keeps “WireHub Standard”.' },
  { key: 'rights', label: 'Rights / confidentiality line', hint: 'The drawing sheet’s title block and the wire spec’s footer.' },
  { key: 'designer', label: 'Default designer', hint: 'Printed when a drawing names none.' },
  { key: 'filePrefix', label: 'Wire spec file prefix', hint: 'What exported wire spec files start with; empty keeps “WSS_”. Letters, digits, dot, dash, underscore; up to 16.' },
] as const;

type Draft = Record<(typeof FIELDS)[number]['key'], string> & {
  paper: PaperId | '';
  titleBlock: TitleBlockStandard | '';
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
  paper: view?.paper ?? '',
  titleBlock: view?.titleBlock ?? '',
  notes: [view?.notes?.[0] ?? '', view?.notes?.[1] ?? '', view?.notes?.[2] ?? ''],
  tolerances: DEFAULT_TOLERANCES.map((_, i) => [view?.tolerances?.[i]?.[0] ?? '', view?.tolerances?.[i]?.[1] ?? ''] as [string, string]),
  organisation: view?.organisation ?? '',
  standard: view?.standard ?? '',
  rights: view?.rights ?? '',
  designer: view?.designer ?? '',
  filePrefix: view?.filePrefix ?? '',
});

/** a font file as base64 (the upload's `data`) */
const readAsBase64 = async (file: File): Promise<string> => (await readAsDataUri(file)).replace(/^data:[^,]*;base64,/, '');

const FONT_NOTE: Record<FontChoice['format'], string> = {
  ttf: 'TrueType: set on every sheet and in every PDF.',
  otf: 'OpenType: set on the sheets and the drawing\u2019s PDF; the formboard PDF embeds only TrueType outlines and keeps the standard sans.',
  woff2: 'WOFF2: set on the HTML sheets and the printed PDFs; the headless PDFs keep the standard sans.',
};

const readAsDataUri = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.readAsDataURL(file);
  });

export function SettingsRoute(): JSX.Element {
  const client = useQueryClient();
  const docsBase = useDocsBase();
  const search = settingsRoute.useSearch();
  const selected = settingsSection(search.section) ?? 'documents';
  const currentSection = SETTINGS_SECTIONS.find((section) => section.id === selected)!;
  const navigate = useNavigate({ from: '/settings' });
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => { if (content.current !== null) content.current.scrollTop = 0; }, [selected]);
  const { me } = useStudio();
  const readOnly = me?.role === 'viewer';
  const query = useQuery(brandingQuery);
  const [draft, setDraft] = useState<Draft>(draftOf(undefined));
  /** undefined: keep the stored logo; null: remove it; a data URI: replace it */
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const fonts = useQuery({ queryKey: fontsKey, queryFn: async () => { const out = await fetchFonts(); if (!out.ok) throw new Error(out.message); return out.value; }, retry: false });
  /** the chosen faces, as font ids ('' = the standard sans) */
  const [face, setFace] = useState<{ regular: string; bold: string }>({ regular: '', bold: '' });
  /** this hub's own drawing art as JSON text ('' = none) */
  const [art, setArt] = useState('');
  const [upload, setUpload] = useState<{ file: File | undefined; licence: boolean; busy: boolean }>({ file: undefined, licence: false, busy: false });
  useEffect(() => {
    if (query.data !== undefined) {
      setDraft(draftOf(query.data));
      setFace({ regular: query.data.font?.regular.id ?? '', bold: query.data.font?.bold?.id ?? '' });
      setArt(query.data.ownArt === undefined ? '' : JSON.stringify(query.data.ownArt, null, 2));
    }
  }, [query.data]);

  const shown = logo === undefined ? query.data?.logoDataUri : (logo ?? undefined);
  const save = async (): Promise<void> => {
    if (query.data === undefined) return;
    let artInput: Record<string, unknown> | null | undefined;
    const storedArt = query.data.ownArt === undefined ? '' : JSON.stringify(query.data.ownArt, null, 2);
    if (art !== storedArt) {
      try {
        artInput = art.trim() === '' ? null : (JSON.parse(art) as Record<string, unknown>);
      } catch {
        toast.error('The drawing art is not valid JSON.', { description: 'It is an object with faces, plugs and cutaways keyed by definition id.' });
        return;
      }
    }
    const fontChanged = face.regular !== (query.data.font?.regular.id ?? '') || face.bold !== (query.data.font?.bold?.id ?? '');
    setBusy(true);
    const out = await saveBranding(
      {
        ...draft,
        ...(logo === undefined ? {} : { logo }),
        ...(!fontChanged ? {} : { font: face.regular === '' ? null : { regular: face.regular, ...(face.bold === '' ? {} : { bold: face.bold }) } }),
        ...(artInput === undefined ? {} : { art: artInput }),
      },
      query.data.etag,
    );
    setBusy(false);
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    client.setQueryData(brandingKey, out.value);
    setLogo(undefined);
    toast.success('Saved. New documents carry it.');
  };
  const sendFont = async (): Promise<void> => {
    if (upload.file === undefined || !upload.licence) return;
    setUpload({ ...upload, busy: true });
    const out = await uploadFont({ name: upload.file.name, data: await readAsBase64(upload.file), licence: true });
    setUpload({ file: undefined, licence: false, busy: false });
    if (!out.ok) {
      toast.error(out.message, { description: out.hint });
      return;
    }
    await client.invalidateQueries({ queryKey: fontsKey });
    // a font just uploaded is the one meant: regular first, then bold
    const style = (out.value.font.subfamily ?? '').toLowerCase();
    setFace((f) => (style.includes('bold') && f.regular !== '' ? { ...f, bold: out.value.font.id } : { ...f, regular: out.value.font.id }));
    toast.success(`${out.value.font.family} is uploaded. Save to use it.`);
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
    <div className="settings-layout text-[12.5px]" data-testid="settings">
      <nav className="settings-navigation" aria-label="Settings sections">
        <h1 className="text-[14px] font-semibold">Hub settings</h1>
        <label className="settings-mobile-navigation">
          <span>Section</span>
          <select aria-label="Settings section" value={selected} onChange={(event) => {
            const section = settingsSection(event.target.value);
            if (section !== undefined) void navigate({ search: { section } });
          }}>
            {SETTINGS_SECTIONS.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
          </select>
        </label>
        <div className="settings-section-links">
          {SETTINGS_SECTIONS.map((section) => <Link key={section.id} to="/settings" search={{ section: section.id }} aria-current={selected === section.id ? 'page' : undefined}>{section.label}</Link>)}
        </div>
      </nav>
      <div className="settings-content" ref={content}>
        <header className="settings-section-heading">
          <h2 className="text-[14px] font-semibold">
            {currentSection.label}
            <InfoTip text={sectionHelp(currentSection)} href={helpForSettingsSection(selected, docsBase)} />
          </h2>
        </header>
        <section hidden={selected !== 'documents'} aria-label="Document settings" data-settings-section="documents">
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
          <div className="flex gap-3">
            <div className="flex flex-1 flex-col gap-0.5" title="The paper every document prints on unless a design or a download asks for another. The drawing, formboard, labels and schematic keep their own orientation.">
              <span className="font-medium">Paper</span>
              <Select
                aria-label="Paper"
                value={draft.paper === '' ? 'default' : draft.paper}
                disabled={readOnly}
                onValueChange={(value) => setDraft({ ...draft, paper: value === 'default' ? '' : (value as PaperId) })}
                options={[{ value: 'default', label: 'A4 (default)' }, ...PAPER_IDS.filter((id) => id !== 'A4').map((id) => ({ value: id, label: PAPERS[id].label }))]}
              />
            </div>
            <div className="flex flex-1 flex-col gap-0.5" title="The title-block layout of every sheet: ISO 7200 (a block at the bottom right) or ANSI (a full-width block). By default the paper decides: ISO for the A sizes, ANSI for Letter and the larger American sizes.">
              <span className="font-medium">Title block</span>
              <Select
                aria-label="Title block"
                value={draft.titleBlock === '' ? 'default' : draft.titleBlock}
                disabled={readOnly}
                onValueChange={(value) => setDraft({ ...draft, titleBlock: value === 'default' ? '' : (value as TitleBlockStandard) })}
                options={[{ value: 'default', label: 'Follow the paper' }, ...TITLE_BLOCK_STANDARDS.map((id) => ({ value: id, label: TITLE_BLOCKS[id].label }))]}
              />
            </div>
          </div>
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
          <fieldset className="flex flex-col gap-1 border-0 p-0" data-testid="typeface">
            <legend className="font-medium">Typeface</legend>
            <span className="text-faint">The font the drawings, the HTML sheets and the PDFs are set in. Empty keeps the standard sans. It is stored with the hub and travels inline in each document.</span>
            {(['regular', 'bold'] as const).map((slot) => (
              <label key={slot} className="flex items-center gap-2">
                <span className="w-14">{slot === 'regular' ? 'Regular' : 'Bold'}</span>
                <select
                  className="rounded border border-line bg-panel px-2 py-1"
                  aria-label={`${slot === 'regular' ? 'Regular' : 'Bold'} typeface`}
                  value={face[slot]}
                  disabled={readOnly}
                  onChange={(e) => setFace({ ...face, [slot]: e.target.value, ...(slot === 'regular' && e.target.value === '' ? { bold: '' } : {}) })}
                >
                  <option value="">{slot === 'regular' ? 'Standard sans' : 'None (the bundled bold)'}</option>
                  {(fonts.data?.fonts ?? []).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.family}
                      {f.subfamily === undefined ? '' : ` ${f.subfamily}`} ({f.format}, {f.source === 'pack' ? `pack ${f.pack ?? ''}` : 'uploaded'})
                    </option>
                  ))}
                </select>
              </label>
            ))}
            {(fonts.data?.fonts ?? []).filter((f) => f.id === face.regular || f.id === face.bold).map((f) => (
              <span key={f.id} className="text-faint">
                {f.family}: {FONT_NOTE[f.format]}
                {f.format === 'otf' && f.embeddable ? ' It has TrueType outlines, so the formboard PDF embeds it too.' : ''}
              </span>
            ))}
            {readOnly ? null : (
              <div className="mt-1 flex flex-col gap-1 rounded border border-line p-2">
                <span className="font-medium">Upload a font</span>
                <input
                  type="file"
                  accept=".ttf,.otf,.woff2,font/ttf,font/otf,font/woff2"
                  aria-label="Font file"
                  onChange={(e) => setUpload({ ...upload, file: e.target.files?.[0] })}
                />
                <label className="flex items-start gap-2">
                  <input type="checkbox" aria-label="I hold a licence for this font" checked={upload.licence} onChange={(e) => setUpload({ ...upload, licence: e.target.checked })} />
                  <span>I hold a licence that lets this font be embedded in the documents this hub generates (PDF, HTML sheets and drawings).</span>
                </label>
                <div>
                  <button type="button" className="rounded border border-line px-2 py-0.5 disabled:opacity-50" disabled={upload.file === undefined || !upload.licence || upload.busy} onClick={() => void sendFont()}>
                    {upload.busy ? 'Uploading\u2026' : 'Upload font'}
                  </button>
                </div>
                <span className="text-faint">TrueType, OpenType or WOFF2, up to {Math.round((fonts.data?.limits.bytes ?? 1536 * 1024) / 1024)} KiB, static (not a variable font). A font is kept as a file of the hub; fonts a data pack ships under fonts/ are offered here too.</span>
              </div>
            )}
          </fieldset>
          <fieldset className="flex flex-col gap-1 border-0 p-0" data-testid="drawing-art">
            <legend className="font-medium">Drawing art</legend>
            <span className="text-faint">
              Traced connector faces and plugs and wire cutaways, keyed by definition id, in the shape a module&rsquo;s art has. In force now:{' '}
              {['faces', 'plugs', 'cutaways'].map((k) => `${Object.keys((query.data?.art as Record<string, Record<string, unknown>> | undefined)?.[k] ?? {}).length} ${k}`).join(', ')}
              {' '}(this hub&rsquo;s and its packs&rsquo;). Empty keeps the generated art; a cutaway&rsquo;s SVG is cleaned of scripts and external references when it is saved.
            </span>
            <textarea
              className="min-h-24 rounded border border-line bg-panel px-2 py-1 font-mono text-[11.5px]"
              aria-label="Drawing art (JSON)"
              placeholder='{ "cutaways": { "wire-stock-id": { "svg": "<svg …/>", "width": 525, "height": 131 } } }'
              value={art}
              disabled={readOnly}
              spellCheck={false}
              onChange={(e) => setArt(e.target.value)}
            />
          </fieldset>
          {readOnly ? <div className="text-faint">Your role can view these settings but not change them.</div> : null}
          <div>
            <button type="submit" disabled={readOnly || busy} className="rounded border border-line bg-accent px-3 py-1 text-accent-ink disabled:opacity-50">
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
        </section>
        <section hidden={selected !== 'engineering'} aria-label="Engineering settings" data-settings-section="engineering"><EngineeringSettings /></section>
        <section hidden={selected !== 'numbering'} aria-label="Part numbering settings" data-settings-section="numbering"><PartNumberSettings /></section>
        <section hidden={selected !== 'rules'} aria-label="Validation rule settings" data-settings-section="rules"><RulesSettings /></section>
        <section hidden={selected !== 'authentication'} aria-label="Authentication settings" data-settings-section="authentication"><RuntimeSettings section="authentication" /></section>
        <section hidden={selected !== 'runtime'} aria-label="Runtime settings" data-settings-section="runtime"><RuntimeSettings section="runtime" /></section>
        <section hidden={selected !== 'webhooks'} aria-label="Webhook settings" data-settings-section="webhooks"><WebhookSettings /></section>
        <section hidden={selected !== 'stores'} aria-label="Catalog store settings" data-settings-section="stores"><StoreSourcesSettings /></section>
        <section hidden={selected !== 'module-settings'} aria-label="Module settings" data-settings-section="module-settings"><ModuleSettings /></section>
        <section hidden={selected !== 'modules'} aria-label="Code module settings" data-settings-section="modules"><CodeModulesSettings /></section>
      </div>
    </div>
  );
}

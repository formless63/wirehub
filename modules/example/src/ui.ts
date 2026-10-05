/**
 * The example module's UI: panels and a page, as plain React components.
 *
 * Written with `createElement`, not JSX, on purpose: the server imports the
 * module through Node's type stripping, which does not read `.tsx`. A module
 * that wants JSX keeps it in a separate entry that only the browser bundle
 * imports, or builds it to JavaScript first.
 */

import type { PanelProps, RouteProps } from '@wirehub/modules';
import { createElement as h, useEffect, useState, type ReactElement } from 'react';

import { dataOf } from './logic.ts';

/** `cable-inspector`: what the commit hook has recorded on the cable on screen. */
export function InspectorPanel(props: PanelProps): ReactElement {
  const data = props.design === undefined ? undefined : dataOf(props.design);
  return h(
    'div',
    { 'data-testid': 'example-inspector' },
    h('strong', null, 'Example module'),
    h('div', null, data === undefined ? 'No edits recorded yet.' : `Edits recorded: ${data.edits}. Last: ${data.last}`),
  );
}

/** `cable-documents`: the design's joint count, and a call to the module's own route. */
export function DocumentsPanel(props: PanelProps): ReactElement {
  const [status, setStatus] = useState<string>();
  useEffect(() => {
    let live = true;
    void props.api('GET', 'status').then((out) => {
      if (live) setStatus(String((out.body as { module?: string }).module ?? out.status));
    });
    return () => {
      live = false;
    };
  }, [props.api]);
  return h('div', { 'data-testid': 'example-documents' }, `Example: ${props.design?.joints.length ?? 0} joints; server says ${status ?? '…'}`);
}

/** `library-detail`: which record is open. */
export function LibraryPanel(props: PanelProps): ReactElement {
  return h('div', { 'data-testid': 'example-library' }, `Example: ${props.record?.kind ?? '?'}/${props.record?.id ?? '?'}`);
}

/** `settings`: the module says what it is. */
export function SettingsPanel(props: PanelProps): ReactElement {
  return h('div', { 'data-testid': 'example-settings' }, `Example settings (${props.module}): nothing to configure.`);
}

/** A UI route: `/m/example/status`. */
export function StatusPage(props: RouteProps): ReactElement {
  const [body, setBody] = useState<unknown>();
  useEffect(() => {
    let live = true;
    void props.api('GET', 'status').then((out) => {
      if (live) setBody(out.body);
    });
    return () => {
      live = false;
    };
  }, [props.api]);
  return h(
    'div',
    { 'data-testid': 'example-page' },
    h('h2', null, 'Example module status'),
    h('pre', null, JSON.stringify(body ?? null)),
    h('div', null, `${props.db.connectors.length} connectors in the library`),
  );
}

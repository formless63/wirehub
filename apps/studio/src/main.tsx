// self-hosted, no Google Fonts at runtime — weights used across the shell and editor
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import '@xyflow/react/dist/style.css';
// `studio.css` first: both stylesheets are independent Tailwind v4 builds that
// each declare `@layer … utilities;`, and CSS ranks same-named layers by where
// they were *first* declared across the whole page — not per stylesheet. Load
// `editor.css` first and its lone `@layer utilities;` claims that name ahead
// of `studio.css`'s `@layer theme, base, components, utilities;`, which then
// inserts `base` *after* the already-claimed `utilities`, so every base-layer
// reset in `studio.css` (e.g. `* { border: 0 solid }`) outranks its own
// `.border` utilities — real borders exist in markup and computed style,
// invisible on screen. Loading `studio.css` first registers its own layer
// order — utilities last, i.e. highest-priority — before `editor.css` ever
// mentions the name, so both builds agree on it.
import './studio.css';
import '@cable-studio/editor-react/editor.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { applyTheme, initialTheme } from './theme.ts';
import { browserLockClient } from './locks/lock-client.ts';

// applied before the first paint, so there is no flash of the wrong theme
// while React boots — App's own state picks up the same value (`initialTheme`
// is deterministic) and keeps it in sync from then on
applyTheme(initialTheme());

// edit locks: one client per page load — held tokens
// ride along on every write, leases are renewed and given back on tab close
const locks = browserLockClient();
locks.installFetch();
locks.start();

const host = document.getElementById('root');
if (host === null) throw new Error('#root is missing from index.html');

createRoot(host).render(
  <StrictMode>
    <App locks={locks} />
  </StrictMode>,
);

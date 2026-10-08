/**
 * Library › Import: one menu for everything that brings records in — a file through a module's
 * importer, a bulk CSV, a connection list, and the module pages that declared
 * `placement: 'library-import'` (board import). The importers keep their own dialogs; the menu
 * only opens their file pickers (`expose`), so nothing else changes about them.
 */

import { IconChevronDown, IconUpload } from '@tabler/icons-react';
import { useNavigate } from '@tanstack/react-router';
import type { ModuleRegistry } from '@wirehub/modules';
import { DropdownMenu } from 'radix-ui';
import { useCallback, useRef, type JSX } from 'react';

import { allowedRailModules } from '../modules.browser.ts';
import { ConnectionsImport } from './ConnectionsImport.tsx';
import { CsvImport } from './CsvImport.tsx';
import { ModuleImport } from './ModuleImport.tsx';
import { routesIn } from './placement.ts';

export function ImportMenu({ registry, onImported }: { registry: ModuleRegistry; onImported: () => void }): JSX.Element | null {
  const navigate = useNavigate();
  const openers = useRef<Record<'file' | 'csv' | 'connections', (() => void) | undefined>>({ file: undefined, csv: undefined, connections: undefined });
  const exposeFile = useCallback((open: () => void) => { openers.current.file = open; }, []);
  const exposeCsv = useCallback((open: () => void) => { openers.current.csv = open; }, []);
  const exposeConnections = useCallback((open: () => void) => { openers.current.connections = open; }, []);
  const hasFile = registry.importers().length > 0;
  const hasCsv = registry.importers().some((i) => i.module === 'csv-library');
  const hasConnections = registry.importers().some((i) => i.module === 'csv-library' && i.id === 'connection-list');
  const pages = routesIn(registry, 'library-import', allowedRailModules);
  if (!hasFile && pages.length === 0) return null;
  return (
    <>
      {hasFile ? <ModuleImport registry={registry} onImported={onImported} expose={exposeFile} /> : null}
      {hasCsv ? <CsvImport onImported={onImported} expose={exposeCsv} /> : null}
      {hasConnections ? <ConnectionsImport onImported={onImported} expose={exposeConnections} /> : null}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="cs-small cs-action-link" data-testid="library-import-menu" title="Bring records in: a file, a spreadsheet, a connection list or a board">
            <IconUpload size={13} aria-hidden /> Import <IconChevronDown size={11} aria-hidden />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="cs-menu" sideOffset={3} align="start">
            {hasFile ? <DropdownMenu.Item className="cs-menu-item" onSelect={() => openers.current.file?.()}>From a file…</DropdownMenu.Item> : null}
            {hasCsv ? <DropdownMenu.Item className="cs-menu-item" onSelect={() => openers.current.csv?.()}>Bulk CSV…</DropdownMenu.Item> : null}
            {hasConnections ? <DropdownMenu.Item className="cs-menu-item" onSelect={() => openers.current.connections?.()}>Connections CSV…</DropdownMenu.Item> : null}
            {pages.map((page) => (
              <DropdownMenu.Item key={`${page.module}/${page.path}`} className="cs-menu-item" onSelect={() => void navigate({ to: '/m/$module/$', params: { module: page.module, _splat: page.path } })}>
                {page.label}…
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  );
}

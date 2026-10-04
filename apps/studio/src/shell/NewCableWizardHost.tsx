/**
 * Hosts New cable at the shell, driven by `studio.newCableOpen` — so both
 * `CablesRoute`'s own "New cable" button and the quick-open "New cable"
 * command (`commands/AppCommands.tsx`, runnable from any route) open the
 * exact same modal. Mounted once in `Shell.tsx`, same as `TopBar`/`Rail`.
 *
 * New cable is the plug-and-board wizard (`NewCableWizard`). A module may
 * bring a guided flow of its own (a "recipe" journey) through a UI route.
 */

import type { JSX } from 'react';
import { useNavigate } from '@tanstack/react-router';

import { NewCableWizard, type CatalogChange } from '@cable-studio/editor-react';

import { useStudio } from '../studio-context.tsx';

export function NewCableWizardHost(): JSX.Element | null {
  const studio = useStudio();
  const navigate = useNavigate();

  if (!studio.newCableOpen) return null;

  const done = (change: CatalogChange): void => {
    studio.closeNewCableWizard();
    if (change.kind === 'created') {
      void navigate({ to: '/cables/$id', params: { id: change.design.id }, search: { view: 'build' } });
    }
  };

  return (
    <div className="cs-editor" style={{ position: 'fixed', inset: 0, zIndex: 30 }}>
      <div className="cs-modal" role="dialog" aria-modal="true" aria-label="New cable">
        <NewCableWizard
          db={studio.db}
          persistence={studio.persistence}
          designs={studio.designs}
          depictions={studio.depictions}
          onCancel={studio.closeNewCableWizard}
          onCatalogChange={done}
        />
      </div>
    </div>
  );
}

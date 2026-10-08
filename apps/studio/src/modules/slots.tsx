/**
 * Mounting module UI: the registry's panels in their slots, and the editor's
 * extension hooks built from them (`docs/modules.md`, "UI panels").
 *
 * A panel is a React component taking `PanelProps`. A panel that throws is
 * contained: it shows its own error line and the rest of the page stays up.
 */

import { deriveContinuityExport } from '@wirehub/docs';
import type { EditorExtensions, ExtraExporter } from '@wirehub/editor-react';
import type { CableDesign, Db } from '@wirehub/model';
import type { ModuleRegistry, PanelProps, PanelSlot } from '@wirehub/modules';
import { Component, useMemo, type ComponentType, type ErrorInfo, type JSX, type ReactNode } from 'react';

import { allowedRailModules } from '../modules.browser.ts';
import { moduleApi } from './api.ts';
import { routesIn } from './placement.ts';
import { ModuleSlot } from './ModuleSlot.tsx';

export class PanelBoundary extends Component<{ label: string; children: ReactNode }, { error?: string }> {
  override state: { error?: string } = {};
  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[modules] panel '${this.props.label}' failed:`, error, info.componentStack);
  }
  override render(): ReactNode {
    return this.state.error === undefined ? (
      this.props.children
    ) : (
      <div role="alert" className="cs-module-panel-error">
        {this.props.label} could not be shown: {this.state.error}
      </div>
    );
  }
}

export interface SlotContext {
  db: Db;
  design?: CableDesign;
  record?: { kind: string; id: string };
  readOnly: boolean;
  onChange?: (design: CableDesign, description?: string) => void;
}

/**
 * The order the host shows modules in within a slot, first to last; modules it does not name
 * follow in manifest order. The host decides, not the module (`docs/modules.md`, "Module slots").
 */
export const MODULE_SLOT_ORDER: Readonly<Partial<Record<PanelSlot, readonly string[]>>> = {
  'library-detail': ['suppliers'],
  'cable-documents': ['fx-rates'],
};

/** module ids with panels in `slot`, in the host's order */
export function slotModules(registry: ModuleRegistry, slot: PanelSlot): string[] {
  const ids = [...new Set(registry.panels(slot).map((p) => p.module))];
  const order = MODULE_SLOT_ORDER[slot] ?? [];
  const rank = (id: string): number => {
    const at = order.indexOf(id);
    return at === -1 ? order.length : at;
  };
  return ids.map((id, index) => ({ id, index })).sort((x, y) => rank(x.id) - rank(y.id) || x.index - y.index).map((x) => x.id);
}

/**
 * Every panel the registry has for `slot`, in manifest order. Renders nothing when there are none.
 * `framed`: each module's panels sit in one collapsible `ModuleSlot` (collapsed, host-ordered,
 * "not set up" when its required settings are empty) — how core pages mount module content.
 */
export function ModulePanels({ registry, slot, context, framed = false }: { registry: ModuleRegistry; slot: PanelSlot; context: SlotContext; framed?: boolean }): JSX.Element | null {
  const panels = registry.panels(slot);
  if (panels.length === 0) return null;
  const render = (list: typeof panels): JSX.Element[] =>
    list.map((panel) => <ModulePanel key={`${panel.module}/${panel.id}`} module={panel.module} id={panel.id} label={panel.label} slot={slot} component={panel.component} context={context} />);
  if (!framed) return <>{render(panels)}</>;
  return (
    <>
      {slotModules(registry, slot).map((id) => {
        const module = registry.module(id);
        return (
          <ModuleSlot key={id} module={id} label={module?.label ?? id} slot={slot} requiresSetup={(module?.settings ?? []).some((setting) => setting.required === true)}>
            {render(panels.filter((p) => p.module === id))}
          </ModuleSlot>
        );
      })}
    </>
  );
}

function ModulePanel(props: { module: string; id: string; label: string; slot: PanelSlot; component: unknown; context: SlotContext }): JSX.Element {
  const { module, id, label, slot, context } = props;
  const api = useMemo(() => moduleApi(module), [module]);
  const Panel = props.component as ComponentType<PanelProps>;
  const panelProps: PanelProps = {
    slot,
    module,
    db: context.db,
    readOnly: context.readOnly,
    api,
    ...(context.readOnly || context.design === undefined || context.onChange === undefined ? {} : { onChange: context.onChange }),
    ...(context.design === undefined ? {} : { design: context.design }),
    ...(context.record === undefined ? {} : { record: context.record }),
  };
  return (
    <section className="cs-module-panel" data-module={module} data-panel={id} aria-label={label}>
      <PanelBoundary label={label}>
        <Panel {...panelProps} />
      </PanelBoundary>
    </section>
  );
}

/** The registry's exporters as the Documents view's extra downloads. */
export function extraExporters(registry: ModuleRegistry): ExtraExporter[] {
  return registry.exporters().map((exporter) => ({
    id: `${exporter.module}/${exporter.id}`,
    label: exporter.label,
    ...(exporter.description === undefined ? {} : { description: exporter.description }),
    // a tester exporter reads the continuity data; the host derives it with the design's test parameters
    render: (design, db, context) =>
      exporter.render(
        design,
        db,
        exporter.source === 'continuity'
          ? { continuity: deriveContinuityExport(design, db, { ...(context?.testParameters === undefined ? {} : { parameters: context.testParameters }), ...(context?.testDefaults === undefined ? {} : { defaults: context.testDefaults }) }) }
          : undefined,
      ),
  }));
}

/** What `<CableEditor extensions>` takes, or undefined when the registry adds nothing to the editor. */
export function editorExtensions(registry: ModuleRegistry, openRoute?: (module: string, path: string) => void): EditorExtensions | undefined {
  const inspector = registry.panels('cable-inspector').length > 0;
  const documents = registry.panels('cable-documents').length > 0;
  const exporters = extraExporters(registry);
  const toolLinks = openRoute === undefined ? [] : routesIn(registry, 'document-tools', allowedRailModules).map((route) => ({ id: `${route.module}/${route.path}`, label: route.label, open: () => openRoute(route.module, route.path) }));
  if (!inspector && !documents && exporters.length === 0 && toolLinks.length === 0) return undefined;
  return {
    ...(inspector ? { inspector: (c) => <ModulePanels registry={registry} slot="cable-inspector" context={c} /> } : {}),
    // after the sheet, in a collapsed frame (ModuleSlot)
    ...(documents ? { documents: (c) => <ModulePanels registry={registry} slot="cable-documents" context={c} framed /> } : {}),
    ...(exporters.length === 0 ? {} : { exporters }),
    ...(toolLinks.length === 0 ? {} : { toolLinks }),
  };
}

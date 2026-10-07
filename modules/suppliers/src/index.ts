/** Optional runtime module; installed and enabled explicitly by a deployment. */
import { defineModule } from '@wirehub/modules';
import { importQuote, requirementsCsv } from './logic.ts';
import { supplierIntegration } from './server.ts';
import { DocumentsPanel, LibraryPanel, ProcurementPage, SettingsPanel } from './ui.ts';

export const suppliers = defineModule({
  id: 'suppliers', label: 'Suppliers', version: '0.1.1', license: 'MIT',
  integrations: [supplierIntegration],
  importers: [{ id: 'selected-quote', label: 'Selected supplier quote (review cost update)', accepts: ['.supplier-quote.json'], import: importQuote }],
  exporters: [{ id: 'requirements-csv', label: 'Procurement requirements (CSV)', description: 'Cable BOM purchasing quantities, without supplier refresh or automatic substitutions.', render: (design, db, options) => ({ mimeType: 'text/csv', fileName: `${design.id}-procurement.csv`, body: requirementsCsv(design, db, options?.['builds'] === undefined ? 1 : Number(options['builds'])) }) }],
  panels: [
    { id: 'offers', label: 'Supplier offers', slot: 'library-detail', component: LibraryPanel },
    { id: 'procurement', label: 'Procurement requirements', slot: 'cable-documents', component: DocumentsPanel },
    { id: 'configuration', label: 'Supplier connections', slot: 'settings', component: SettingsPanel },
  ],
  routes: [{ path: 'procurement', label: 'Suppliers', component: ProcurementPage }],
});

export { importQuote, offersCsv, priceAt, quoteImportFile, requirementsCsv } from './logic.ts';
export type { LookupRequest, LookupResult, SupplierOffer, SupplierId } from './types.ts';

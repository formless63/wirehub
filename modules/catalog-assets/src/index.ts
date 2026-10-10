import { defineModule } from '@wirehub/modules';
import { kicadListingRoute } from './provider.ts';
import { AssetDiscoveryPage, AssetDiscoveryPanel } from './ui.ts';

export { candidatesFromTree, KICAD, DIRECTORIES, providerSearches, subjectForRecord } from './discovery.ts';
export { listKicad } from './provider.ts';

export const catalogAssets = defineModule({
  id: 'catalog-assets', label: 'CAD model discovery', version: '0.1.0', license: 'MIT',
  integrations: [{ id: 'kicad', label: 'Public KiCad model catalog', routes: [kicadListingRoute] }],
  panels: [{ id: 'assets', label: 'Find CAD models', slot: 'library-detail', component: AssetDiscoveryPanel }],
  routes: [{ path: 'find', label: 'Find CAD models', icon: 'IconSearch', component: AssetDiscoveryPage }],
});

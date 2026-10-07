/** Explicit profiles for new imports; installed/historical links always use their own exact key. */
import type { BoardTextureProfile } from './cache.ts';
import { sourceKey } from './cache.ts';
import { buildProfileOf } from './build.ts';
import type { ModelLink } from './links.ts';
import { appearanceFactory } from './appearance-reader.ts';
import { occurrenceFactory } from './occurrence-reader.ts';
import { ModelRefusal } from './convert.ts';

export function configuredModelProfile(env: Record<string, string | undefined> = process.env): BoardTextureProfile {
  const value = env['WIREHUB_MODEL_PROFILE'] || 'exporter';
  if (value === 'exporter' || value === 'occurrence' || value === 'appearance') return value;
  throw new ModelRefusal('The configured model conversion profile is unsupported.', 'Set WIREHUB_MODEL_PROFILE to exporter, occurrence or appearance. Nothing was saved.');
}

/** Validate local artifact bytes without growing a WASM heap in the request process. */
export function assertModelProfileAvailable(profile: BoardTextureProfile, env: Record<string, string | undefined> = process.env): void {
  if (profile === 'legacy' || profile === 'exporter') return;
  try {
    if (profile === 'appearance') appearanceFactory(env['WIREHUB_OCCT_APPEARANCE_DIR'] ?? '');
    else if (profile === 'occurrence') occurrenceFactory(env['WIREHUB_OCCT_STYLES_DIR'] ?? '');
    else throw new Error('Unsupported profile');
  } catch {
    throw new ModelRefusal('The configured model conversion profile is unavailable.', 'Build and mount its pinned importer artifact on the app and worker. Nothing was saved.');
  }
}

/** Prepare an opt-in current-link upgrade, preserving embedded/placed/assembly recipes.
 * Build and verify this new key before saving it with the ordinary leased unit of work.
 * This helper does not write links, caches, signed packs or recorded revisions.
 */
export function reprofileModelLink(link: ModelLink, profile: BoardTextureProfile): ModelLink {
  const previous = buildProfileOf(link);
  if (previous === undefined || link.files === undefined) throw new Error('The model link has no recognized source recipe; it cannot be reprofiled.');
  return { ...link, asset: sourceKey(link.files, previous.budget, link.build, profile) };
}

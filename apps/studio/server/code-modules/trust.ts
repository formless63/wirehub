/**
 * The gate a pack that carries code goes through before anything of it is
 * written (`specs/runtime-modules.md` §2): owners only, the kill switch, a
 * sound `module` block for an API this hub runs, every code file pinned and the
 * manifest signed by a publisher key the hub trusts (a store's listed
 * publisher, or a key an owner pinned), and — to apply — the owner's consent
 * naming the module and version. A data pack passes untouched.
 */

import { normalStoreKey, packFileProblems, storeKeyFingerprint, verifyPackSignature, type PackManifest } from '@wirehub/catalog';
import { MODULE_API_VERSION, apiCompatibility, applyModeOf, codeModuleManifestProblems, isCodeFilePath, type CodeModuleManifest } from '@wirehub/modules';

import type { ApiResponse } from '../api.ts';
import type { StudioUser } from '../me.ts';
import { isPinned, type CodeModuleSettings } from './state.ts';

/** What the person is asked to consent to, shown with the install preview. */
export interface CodePreview {
  module: { id: string; version: string; label: string; apiVersion: string; description?: string };
  extensionPoints: string[];
  permissions: string[];
  /** live: applies at once; restart: loads on the next start (Restart WireHub) */
  apply: 'live' | 'restart';
  trust: { via: 'store' | 'pinned'; keys: { key: string; keyId: string; fingerprint: string }[] };
  /** the sentence the page shows */
  warning: string;
  /** what `consent.code` must say to apply */
  consent: string;
}

export interface CodeGateInput {
  manifest: PackManifest;
  /** `wirehub-pack.sig` as shipped */
  signature?: string;
  /** every file as shipped (what the pins cover) */
  shipped: ReadonlyMap<string, Uint8Array>;
  user?: StudioUser;
  /** from a store whose index lists the publisher and whose signature the store install verified */
  store?: { index: string; keys: string[] } | { index: string; unsigned: true };
  /** the request's own key to trust (an upload), `RW…` */
  trustKey?: unknown;
  /** the request's consent (`{ code: "<id>@<version>" }`) */
  consent?: unknown;
  apply: boolean;
  settings: CodeModuleSettings;
  allowedByEnv: boolean;
  /** module ids the image has built in */
  builtins: readonly string[];
}

export type CodeGateResult = { kind: 'data' } | { kind: 'code'; preview: CodePreview; trust: { via: 'store' | 'pinned'; keys: string[] }; pin?: string } | { kind: 'refused'; response: ApiResponse };

const WARNING = 'This module runs code in your hub, with the same access as WireHub itself: it can read and change your catalog and reach the network. Install it only from a publisher you trust.';

const refused = (status: number, error: string, hint: string, extra?: object): CodeGateResult => ({ kind: 'refused', response: { status, body: { error, hint, ...extra } } });

/** An owner of this hub in a signed-in session (a host without roles counts as one), never an API token. */
export function isOwner(user: StudioUser | undefined): boolean {
  return user !== undefined && (user.role === undefined || user.role === 'owner') && user.apiTokenId === undefined;
}

/** The key id and a sha256 fingerprint of a minisign public key, for a person to compare. */
export function keyFacts(key: string): { key: string; keyId: string; fingerprint: string } {
  return { key: normalStoreKey(key), ...storeKeyFingerprint(key) };
}

export function codeGate(input: CodeGateInput): CodeGateResult {
  const { manifest } = input;
  const codeFiles = [...input.shipped.keys()].filter((p) => p.startsWith('code/'));
  if (manifest.module === undefined) {
    if (codeFiles.length > 0) return refused(422, `The pack carries code (${codeFiles[0]}) but its manifest declares no module.`, 'Nothing was installed. A code module is declared in the manifest\'s "module" block (wirehub-module build writes it).');
    return { kind: 'data' };
  }
  const m = manifest.module as unknown as CodeModuleManifest;
  const shape = codeModuleManifestProblems(m);
  if (shape.length > 0) return refused(422, `That is not a usable code module: ${shape[0]}${shape.length > 1 ? ` (and ${shape.length - 1} more)` : ''}.`, 'Nothing was installed.', { problems: shape });
  const named = [m.server, m.browser, m.css].filter((p): p is string => p !== undefined);
  for (const path of named) if (!input.shipped.has(path)) return refused(422, `The module names ${path}, which the pack does not carry.`, 'Nothing was installed.');
  for (const path of codeFiles) if (!isCodeFilePath(path) || !named.includes(path)) return refused(422, `The pack carries ${path}, which its module does not name.`, 'Nothing was installed. Only the module\'s own entries may sit under code/.');
  const api = apiCompatibility(m.apiVersion);
  if (!api.ok) return refused(422, `${m.id} ${m.version} was refused: ${api.reason}.`, `This hub runs module API ${MODULE_API_VERSION}. Nothing was installed.`, { apiVersion: m.apiVersion, hubApiVersion: MODULE_API_VERSION });
  if (!isOwner(input.user)) return refused(403, `Only an owner can install a code module (${m.id}).`, 'Nothing was installed. Code modules run in the hub itself; ask an owner. Data packs can still be installed by editors.');
  if (!input.allowedByEnv) return refused(403, 'Code modules are turned off on this hub by the server (WIREHUB_ALLOW_CODE_MODULES=false).', 'Nothing was installed. The built-in modules still run.');
  if (input.settings.allow === false) return refused(403, 'Code modules are turned off in Settings (Code modules, Allow code modules).', 'Nothing was installed. An owner can turn them on again.');
  if (input.builtins.includes(m.id)) return refused(409, `This hub's image has a built-in module '${m.id}', which wins.`, 'Nothing was installed. A runtime module needs an id of its own.');

  // every code file covered by the signature: the manifest pins every file, and the pins hold
  if (manifest.files === undefined) return refused(422, `${m.id} ${m.version} is not signed with its files pinned.`, 'Nothing was installed. A code module must be signed (store-index.mjs sign-pack, or wirehub-module build --key).');
  const pins = packFileProblems(manifest, input.shipped);
  if (pins.length > 0) return refused(422, `${m.id} ${m.version}'s files do not match its signed manifest (${pins[0]}).`, 'Nothing was installed.', { problems: pins });

  let trust: { via: 'store' | 'pinned'; keys: string[] };
  let pin: string | undefined;
  if (input.store !== undefined) {
    if ('unsigned' in input.store) {
      return refused(422, `${m.id} ${m.version} is code, and the store does not name its publisher's key.`, 'Nothing was installed. A store pack with code must be signed by a publisher the index lists (store-meta.json "publishers").');
    }
    trust = { via: 'store', keys: input.store.keys };
  } else {
    if (input.signature === undefined || input.signature.trim() === '') return refused(422, `${m.id} ${m.version} is not signed.`, 'Nothing was installed. A code module must carry wirehub-pack.sig from its publisher.');
    let offered: string | undefined;
    if (input.trustKey !== undefined) {
      if (typeof input.trustKey !== 'string') return refused(400, '"trustKey" is the publisher\'s public key (RW…), as text.', 'Nothing was installed.');
      try {
        offered = normalStoreKey(input.trustKey);
      } catch {
        return refused(400, '"trustKey" is not a minisign public key (RW…).', 'Nothing was installed.');
      }
    }
    const keys = [...input.settings.keys.map((k) => k.key), ...(offered === undefined ? [] : [offered])].flatMap((k) => {
      try {
        return [normalStoreKey(k)];
      } catch {
        return [];
      }
    });
    if (keys.length === 0) return refused(422, `${m.id} ${m.version} is signed, but this hub trusts no publisher key for uploads.`, 'Nothing was installed. Give the publisher\'s public key ("trustKey"), compared with the publisher another way; it is pinned when you install.');
    const check = verifyPackSignature(manifest, input.signature, [...new Set(keys)]);
    if (!check.ok) return refused(422, `${m.id} ${m.version} is not signed by a key this hub trusts (${check.reason}).`, 'Nothing was installed. Pin the publisher\'s key, compared with the publisher another way.');
    trust = { via: 'pinned', keys: check.signers };
    if (offered !== undefined && check.signers.includes(offered) && !isPinned(input.settings, offered)) pin = offered;
  }

  const preview: CodePreview = {
    module: { id: m.id, version: m.version, label: m.label, apiVersion: m.apiVersion, ...(m.description === undefined ? {} : { description: m.description }) },
    extensionPoints: [...m.extensionPoints],
    permissions: [...m.permissions],
    apply: applyModeOf(m.extensionPoints),
    trust: { via: trust.via, keys: trust.keys.map(keyFacts) },
    warning: WARNING,
    consent: `${m.id}@${m.version}`,
  };
  if (input.apply) {
    const said = typeof input.consent === 'object' && input.consent !== null ? (input.consent as { code?: unknown }).code : undefined;
    if (said !== preview.consent) {
      return refused(409, `${m.id} ${m.version} runs code in your hub: installing it needs your consent.`, `Read what it may do, then install again with { "consent": { "code": "${preview.consent}" } }. Nothing was installed.`, { code: preview });
    }
  }
  return { kind: 'code', preview, trust, ...(pin === undefined ? {} : { pin }) };
}

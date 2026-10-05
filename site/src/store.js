// The module store page's logic (site/src/store-app.js draws it). Pure functions, so
// they are tested in node; the build inlines this file ahead of the app, with the
// `export` keywords dropped.

/** The `RW…` line of a minisign public key: the bare line or the two-line `.pub` file. Null when it is not one. */
export function parsePublicKey(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('untrusted comment:'));
  const key = lines.find((l) => /^[A-Za-z0-9+/]{56}$/.test(l));
  if (key === undefined) return null;
  const bytes = decodeBase64(key);
  if (bytes.length !== 42 || bytes[0] !== 0x45 || bytes[1] !== 0x64) return null;
  return { key, bytes };
}

function decodeBase64(text) {
  const bin = atob(text);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** What a person compares before trusting a key: minisign's key id and a sha256 fingerprint of the whole key (the same two values the hub prints). */
export async function keyFingerprint(bytes, subtle) {
  const keyId = [...bytes.subarray(2, 10)].reverse().map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const hash = new Uint8Array(await subtle.digest('SHA-256', bytes));
  const hex = [...hash.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { keyId, fingerprint: hex.match(/.{4}/g).join(' ') };
}

/** An absolute http(s) URL for a (possibly relative) bundle URL, or null. */
export function resolveUrl(url, base) {
  try {
    const u = new URL(url, base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** A version's review status as a label and a tone (ok | warn | err | dim). */
export function reviewLabel(review) {
  if (review === undefined || review === null || review.status === 'unreviewed') return { text: 'Unreviewed', tone: 'dim' };
  if (review.status === 'reviewed') {
    const by = review.by === undefined ? '' : ` by ${review.by}`;
    const on = review.on === undefined ? '' : ` on ${review.on}`;
    return { text: `Reviewed${by}${on}`, tone: 'ok', note: review.note };
  }
  if (review.status === 'flagged') return { text: `Flagged: ${review.reason}`, tone: 'err' };
  return { text: 'Unreviewed', tone: 'dim' };
}

export function yankedNotice(yanked) {
  if (yanked === undefined || yanked === null) return null;
  const on = yanked.on === undefined ? '' : ` (${yanked.on})`;
  return `Yanked${on}: ${yanked.reason}. Still downloadable so existing designs keep validating, but never offered for install.`;
}

/** The signature status: what the page can tell from what is published. It cannot verify the signature itself; the hub does. */
export function signatureStatus({ signaturePublished, key, official }) {
  if (!signaturePublished) {
    return {
      tone: 'err',
      title: 'Not signed',
      text: 'No index.json.minisig is published beside this index, so a hub refuses it: an unsigned index cannot be trusted.'
        + (official ? ' The official index stays unsigned until the maintainer adds the store signing key; until then it can be browsed and downloaded here but not added to a hub.' : ''),
    };
  }
  if (key === null) {
    return { tone: 'warn', title: 'Signature published, public key missing', text: 'index.json.minisig is there, but no readable wirehub-store.pub, so there is no key to check it against.' };
  }
  return {
    tone: 'ok',
    title: 'Signed',
    text: 'index.json.minisig is published beside the index. This page does not verify it: your hub does, with the key below, when you add the store (or run minisign -Vm index.json -P <key>). Compare the fingerprint with one the store owner gave you by another route.',
  };
}

// Draws the module store page from the store's own index.json, index.json.minisig and
// wirehub-store.pub (same origin, relative URLs). Text only goes in through textContent.

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

async function fetchText(path) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

function copyButton(label, getText) {
  const button = el('button', { type: 'button', class: 'secondary' }, label);
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(getText());
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed: select the text instead';
    }
    setTimeout(() => { button.textContent = label; }, 2000);
  });
  return button;
}

function statusBox(status) {
  return el('div', { class: `status ${status.tone}`, role: 'status' }, el('strong', {}, status.title), el('p', {}, status.text));
}

function packCard(pack, index, indexUrl) {
  const publisher = (index.publishers ?? []).find((p) => p.id === pack.publisher);
  const who = publisher === undefined ? pack.author?.name : `${publisher.name} (signed pack)`;
  const meta = el('p', { class: 'meta' });
  const bits = [['Domain', pack.domain], ['Licence', pack.license], ['Publisher', who ?? 'unknown']];
  for (const [label, value] of bits) meta.append(el('span', {}, `${label}: `), el('b', {}, String(value)), ' ');
  const home = pack.homepage === undefined ? null : resolveUrl(pack.homepage, indexUrl);
  if (home !== null) meta.append(el('a', { href: home, rel: 'noopener noreferrer' }, 'homepage'));
  const rows = (pack.versions ?? []).map((v) => {
    const review = reviewLabel(v.review);
    const yank = yankedNotice(v.yanked);
    const href = resolveUrl(v.url, indexUrl);
    const cell = el('td', {}, el('span', { class: `tag ${review.tone}` }, review.text));
    if (review.note) cell.append(el('div', { class: 'hint' }, review.note));
    if (yank !== null) cell.append(el('div', { class: 'yank' }, yank));
    return el('tr', { class: v.yanked ? 'yanked' : '' },
      el('td', {}, el('b', {}, v.version), v.license && v.license !== pack.license ? el('div', { class: 'hint' }, `licence ${v.license}`) : null),
      cell,
      el('td', {}, formatSize(v.size), el('div', { class: 'hint hash', title: 'sha256' }, String(v.sha256).slice(0, 16) + '…')),
      el('td', {}, href === null ? 'no download' : el('a', { href, download: '' }, 'Download .zip')));
  });
  return el('article', { class: 'pack' },
    el('h3', {}, pack.name, ' ', el('code', {}, pack.id)),
    pack.description ? el('p', {}, pack.description) : null,
    meta,
    el('div', { class: 'scroll' }, el('table', {},
      el('thead', {}, el('tr', {}, ...['Version', 'Review', 'Size', 'Download'].map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, ...rows))));
}

async function main() {
  const root = document.getElementById('store');
  const indexUrl = new URL('index.json', location.href).href;
  const [indexText, sig, pubText] = await Promise.all([fetchText('index.json'), fetchText('index.json.minisig'), fetchText('wirehub-store.pub')]);
  root.textContent = '';
  let index = null;
  try {
    index = indexText === null ? null : JSON.parse(indexText);
  } catch {
    index = null;
  }
  if (index === null || !Array.isArray(index.packs)) {
    root.append(statusBox({ tone: 'err', title: 'No store index here', text: 'index.json could not be read. Open this page from a store published to a web server, not from a file on disk.' }));
    return;
  }
  document.querySelectorAll('[data-store-name]').forEach((n) => { n.textContent = index.store?.name ?? 'Module store'; });
  const key = pubText === null ? null : parsePublicKey(pubText);
  const official = index.store?.id === 'wirehub';
  const signature = signatureStatus({ signaturePublished: sig !== null, key, official });

  const add = el('section', { class: 'add', 'aria-labelledby': 'add-title' }, el('h2', { id: 'add-title' }, 'How to add this store to your hub'));
  add.append(el('ol', {},
    el('li', {}, 'In your WireHub, open ', el('b', {}, 'Settings'), ' then ', el('b', {}, 'Store sources'), '.'),
    el('li', {}, 'Add a source with this store URL and the public key below.'),
    el('li', {}, 'Compare the fingerprint with the one the store owner published, then confirm. The hub verifies the signature on every index it fetches.')));
  add.append(el('h3', {}, 'Store URL'), el('pre', {}, el('code', { id: 'store-url' }, indexUrl)), copyButton('Copy URL', () => indexUrl));
  add.append(statusBox(signature));
  if (key !== null) {
    add.append(el('h3', {}, 'Public key ', el('a', { href: 'wirehub-store.pub', class: 'hint' }, '(wirehub-store.pub)')), el('pre', {}, el('code', { id: 'store-pub' }, pubText.trim())), copyButton('Copy key', () => key.key));
    const fp = el('p', {}, 'Key id ', el('code', { id: 'store-keyid' }, '…'), ' · fingerprint ', el('code', { id: 'store-fp' }, '…'));
    add.append(fp);
    if (globalThis.crypto?.subtle) {
      keyFingerprint(key.bytes, crypto.subtle).then((f) => {
        fp.querySelector('#store-keyid').textContent = f.keyId;
        fp.querySelector('#store-fp').textContent = f.fingerprint;
      });
    } else {
      fp.textContent = 'The fingerprint needs a secure context (https); compare the key itself instead.';
    }
  }
  root.append(add);

  const revoked = index.revokedKeys ?? [];
  const list = el('section', { 'aria-labelledby': 'packs-title' }, el('h2', { id: 'packs-title' }, `Packs (${index.packs.length})`));
  if (index.generated) list.append(el('p', { class: 'hint' }, `Index built ${index.generated}.`));
  if (revoked.length > 0) list.append(el('p', { class: 'status warn' }, `${revoked.length} publisher key(s) revoked by this store: packs signed only by them are refused by hubs.`));
  for (const pack of index.packs) list.append(packCard(pack, index, indexUrl));
  root.append(list);
}

main();

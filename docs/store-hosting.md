# Run your own store

Anyone can publish catalog packs to WireHub deployments from a store of their own: a shop with
private parts, a maker, a community. A store is **static files** (`index.json`, its signature
`index.json.minisig`, the public key `wirehub-store.pub`, and one `<id>-<version>.zip` bundle per
pack version), so any https static host serves it. No server, no database, and with the template
below no build tooling of your own. Format and trust model: `docs/catalog-store.md` section 4.

## The short way: a GitHub repository

`templates/store/` in this repository is a **template repository**. Its README is the step-by-step
guide, in short:

1. Create a repository from the template.
2. Generate two ed25519 keys on your machine with `scripts/store-index.mjs`
   (`keygen` for the store key, `publisher-keygen` for the key that signs your packs). It runs
   from a plain clone of this repository on Node 24; no install is needed for the key commands.
3. Add the private keys as the Actions secrets `WIREHUB_STORE_SIGNING_KEY` and
   `WIREHUB_PACK_SIGNING_KEY`, and put the publisher's public key in `store-meta.json`.
4. Add packs under `packs/<name>/` (format: the `wirehub-catalog-pack` skill and
   `docs/catalog-store.md`). Keep one directory per released version.
5. Settings, Pages, Source: GitHub Actions. Push to `main`.
6. Share the index URL (`https://<user>.github.io/<repo>/index.json`) and the public key
   (`wirehub-store.pub` beside it). People add it in **Settings, Store sources**.

The template's workflow (`.github/workflows/publish.yml`) is a few lines: it calls the action
below, then deploys the result to Pages.

## The `build-store` action

`.github/actions/build-store` in this repository is a composite action. In a workflow of yours:

```yaml
- uses: actions/checkout@v4
- uses: formless63/wirehub/.github/actions/build-store@<ref>
  with:
    store-signing-key: ${{ secrets.WIREHUB_STORE_SIGNING_KEY }}
    pack-signing-key: ${{ secrets.WIREHUB_PACK_SIGNING_KEY }}   # optional
```

What it does, in order (`build-store.sh` beside `action.yml`; the template's test runs the very
same script):

1. checks out nothing itself: the action's own repository, at `<ref>`, **is** the tooling
   (`scripts/store-index.mjs`, the pack checker), installed with `pnpm install --filter studio...`;
2. works on a copy of every directory under `packs/` that holds a `wirehub-pack.json`, and
   runs `verify-pack.mjs` on each (manifest, `src` on every record, the library validates with the
   pack laid over the starter catalog, no clashes);
3. signs each pack as its publisher when `pack-signing-key` is given (`sign-pack`: the manifest
   pins every file by sha256, and `wirehub-pack.sig` signs the manifest);
4. bundles the packs, builds `index.json` (with `store-meta.json`: publishers, review status,
   yanked versions, revoked keys), signs it with the store key, writes `wirehub-store.pub`;
5. verifies the index signature and, with a publisher key, every bundle's pack signature;
6. uploads the site as the Pages artifact (`upload-pages-artifact: 'false'` to skip).

| Input | Default | |
| --- | --- | --- |
| `store-signing-key` | required | PEM text of the store key |
| `pack-signing-key` | none | PEM text of the publisher key; packs are unsigned without it |
| `packs-dir` | `packs` | subdirectories are packs |
| `meta` | `store-meta.json` | |
| `store-id`, `store-name`, `homepage` | the repository's name and URL | the index's `store` entry |
| `base-url` | none | absolute URL for the bundles; relative to the index is right on Pages |
| `output-dir` | `_site` | |
| `upload-pages-artifact` | `'true'` | |

Outputs: `public-key` (the `RW...` line) and `output-dir`. A build with no store key fails: an
unsigned store is refused by every hub. If `store-meta.json` lists a publisher, the packs naming it
must carry its signature, or the build fails (that is `store-index.mjs build`'s own check).

### Pinning the tooling

The ref after `@` is the version of the store tooling. Pin a **release tag** or a **commit SHA**
for builds that do not change under you, and raise it on purpose (Dependabot's `github-actions`
ecosystem proposes the bumps). `@main` follows the repository and is only for trying things out.
A tag exists for the action only from the first release that contains it; use a SHA before that.
Bundles are deterministic for a given tooling version, so rebuilding unchanged packs gives
identical bytes and hashes.

## Hosting somewhere else

The action's output, `_site/`, is the whole store. Serve that directory from any https static host
(Cloudflare Pages, Netlify, nginx, Caddy) or a public-read bucket (S3, R2, GCS), keeping
the files together. WireHub refuses anything but https, private addresses and redirects to them,
files over 8 MB and fetches over 15 s. The signature does not care where the bytes came from, so a
mirror may copy the directory as it is. To publish to a host other than Pages from the same
repository, call the action with `upload-pages-artifact: 'false'` and copy `_site/` in a later
step (for a bucket, `aws s3 sync _site s3://my-bucket/store`, without `--delete` unless you keep
every version in the repository, since a store keeps every version it ever published).

Without GitHub at all, run the same commands by hand (`docs/catalog-store.md` section 4,
"Building and signing an index"): `bundle`, `build`, `sign`, `verify`.

## Using it

Anyone with the owner or editor role adds the store in **Settings, Store sources**: the index URL
and the public key (paste the `RW...` line, or "Fetch key from the store's `wirehub-store.pub`",
which is trust on first use, so compare the fingerprint the page shows with the one you publish
through another channel). The packs then appear under Library, Browse store, installed and updated
with a diff like any other pack. A server administrator can instead set `WIREHUB_STORE_INDEXES`
(`docs/self-hosting.md`).

## Your responsibilities

You are responsible for what your packs contain and the licence you give them; WireHub does not
review store content. Keep the private keys secret (an Actions secret, a password manager, never a
repository: the template's `.gitignore` refuses `*.key` and `*.pem`). If a key leaks, make a new one,
replace the secret, and revoke the old one (`store-index.mjs revoke`, `publisher`; phase 5 of
`docs/catalog-store.md`). Yank a broken version (`store-index.mjs yank`) rather than deleting its
bundle.

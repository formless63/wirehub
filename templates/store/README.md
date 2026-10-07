# My WireHub module store

A template for your own [WireHub](https://github.com/formless63/wirehub) module store: a
**signed, static catalog of packs** that WireHub deployments can browse and install from
(Library, Browse store). It is just this repository: no server, no build tooling of your own.
A GitHub Actions workflow bundles your packs, builds and signs the index, and publishes it on
GitHub Pages.

A store is four kinds of static file: `index.json`, `index.json.minisig` (its signature),
`wirehub-store.pub` (the public key) and the pack bundles (`<id>-<version>.zip`). You are
responsible for what your packs contain and the licence you give them; WireHub does not review
store content. Background: `docs/catalog-store.md` and `docs/store-hosting.md` in WireHub.

## 1. Use this template

On GitHub, **Use this template, Create a new repository** (public, so Pages works on a free
account), then clone it. If you rather copy the files by hand, you need the whole
`.github/workflows/publish.yml`, `packs/`, `store-meta.json` and `.gitignore`.

## 2. Generate the keys (locally, never in the repository)

You need Node 24 and git. Clone WireHub anywhere (no install step is needed for the key
commands) and run its key generator, writing **outside** this repository:

```sh
git clone --depth 1 https://github.com/formless63/wirehub /tmp/wirehub
node /tmp/wirehub/scripts/store-index.mjs keygen --out ~/wirehub-store-keys
node /tmp/wirehub/scripts/store-index.mjs publisher-keygen --out ~/wirehub-publisher-keys --id my-shop --name "My shop"
```

- `wirehub-store.key` is the **store key**: it signs `index.json`. Hubs trust your store by its
  public key (`RW...`).
- `wirehub-publisher.key` is the **publisher key**: it signs each pack, so a hub can tell the pack
  is the one you published. The template uses it. (To publish without pack signatures, delete the
  `publishers` entry in `store-meta.json` and the `publisher` of each pack manifest; the index
  signature then still covers every bundle.)

Each command prints the public key. Back the key files up somewhere private (a password
manager): if you lose a key you have to rotate it and everyone has to trust the new one.

Open `store-meta.json` and replace the placeholder publisher: set `id` and `name` to the same
values you gave `publisher-keygen` (and as `publisher` in each `wirehub-pack.json`), and `key` to the
publisher public key the command printed.

## 3. Add the secrets

In the repository, **Settings, Secrets and variables, Actions, New repository secret**:

| Secret | Value |
| --- | --- |
| `WIREHUB_STORE_SIGNING_KEY` | the whole text of `~/wirehub-store-keys/wirehub-store.key` (including its first and last lines) |
| `WIREHUB_PACK_SIGNING_KEY` | the whole text of `~/wirehub-publisher-keys/wirehub-publisher.key` |

`.gitignore` keeps `*.key` and `*.pem` out of the repository, but keep the key files outside it
anyway.

## 4. Add your packs

Each directory under `packs/` is one pack at one version, holding a `wirehub-pack.json` and
its record files. `packs/example-pack/` is the smallest valid pack (CC0, one made-up signal): look
at it, then delete it and add your own.

- Pack format, layout, versioning, licences and provenance: the **`wirehub-catalog-pack` skill**
  (`.agents/skills/wirehub-catalog-pack/SKILL.md` in WireHub) and
  [`docs/catalog-store.md`](https://github.com/formless63/wirehub/blob/main/docs/catalog-store.md) sections 2 to 4.
  The records themselves: the `wirehub-catalog-data` skill.
- Check a pack on your machine with a WireHub checkout
  (`pnpm install`, then `node .agents/skills/wirehub-catalog-pack/scripts/verify-pack.mjs <pack-dir>`);
  the workflow runs the same check and fails the build on any problem.
- **To release a new version, copy the pack to a new directory** (`packs/my-pack-1.1.0/`), bump
  `version` in its manifest and keep the old directory. The store keeps every version it ever
  published, because a design built on 1.0.0 must still be able to re-validate against it, and
  each deploy publishes exactly what is under `packs/`.
- A pack under `packs/` holds records and images, never code. Say where every value came from in its
  `src` field, and do not copy data you may not redistribute.

Commit and push to `main`: the **Publish store** workflow runs.

## 4b. Add code modules (optional)

A store can also carry **code modules**: modules that run code in a hub (an ERP link, a house rule, a
panel), installed at runtime by the hub's owner. Put each module package under `modules/<name>/`: a
`package.json` (`"main": "./src/index.ts"`), `src/index.ts` exporting a `defineModule({...})`, and
optionally a `pack/` with its data, laid out like WireHub's `modules/example` (copy it to start). The
workflow builds each one with WireHub's `wirehub-module build` into a pack (`code/<id>/server.mjs` and,
for UI, `browser.mjs`), signs it with your **publisher key** and lists it like any pack. `@wirehub/*`
come from the tooling the action pins; a module with dependencies of its own commits its
`package-lock.json`.

- Code needs the publisher: the build fails without `WIREHUB_PACK_SIGNING_KEY` and a publisher in
  `store-meta.json`, because a hub installs code only when the store lists its publisher and the
  publisher's key signed it.
- A hub owner sees what the module may do (its extension points and permissions) and consents before it
  runs. Bump the module's `version` for every release; keep the module API it was built for in mind
  (WireHub's `specs/runtime-modules.md`).
- You are responsible for what your code does. Write it as you would code for your own hub.

## 5. Enable GitHub Pages

**Settings, Pages, Build and deployment, Source: GitHub Actions.** Run the workflow once more
(Actions, Publish store, Run workflow) if it ran before you set this. When it is green your store is at

```
https://<your-user>.github.io/<this-repository>/index.json
```

(the workflow summary prints the public key too). Open that site's root to browse your packs (the page
reads your `index.json`, shows the store URL, key and fingerprint to add to a hub, and each pack's versions
with download links). A custom domain works as usual.

## 6. Share it

Give people three things:

1. the **index URL** above;
2. the **public key** (`RW...`), or a link to `wirehub-store.pub` on your site
   (`https://<your-user>.github.io/<this-repository>/wirehub-store.pub`);
3. the **fingerprint** of the key, through another channel than the site (the Store sources page
   shows it; compare it).

In WireHub, an owner or editor opens **Settings, Store sources**, pastes the URL and the key (or
chooses "Fetch key from the store's wirehub-store.pub"), checks the preview and saves. The packs
then appear under **Library, Browse store**. Server administrators can instead set
`WIREHUB_STORE_INDEXES` (`docs/self-hosting.md`).

## Pinning the tooling

`publish.yml` uses `formless63/wirehub/.github/actions/build-store@v0.5.0` <!-- x-release-please-version -->. The ref after `@` is the
version of WireHub's store tooling your builds run, because the action carries the tooling with it.
For repeatable builds pin it to a **release tag** (`@v0.2.0`) or a **commit SHA**, and raise it on
purpose when you want newer tooling (release notes: WireHub's `CHANGELOG.md`). Dependabot
(`package-ecosystem: github-actions`) can propose the bumps.

## Hosting somewhere else

GitHub Pages is only a convenience. The store is a directory of static files, and the workflow's
build step writes it to `_site/`: take that output and serve it from **any https static host**
(Cloudflare Pages, Netlify, nginx, Caddy) or an **S3 / R2 / GCS bucket** with public reads. Keep
the file names, serve `index.json` and `index.json.minisig` from the same directory as the
bundles, and use an https URL (WireHub refuses anything else). To publish from this repository
somewhere other than Pages, call the action with `upload-pages-artifact: 'false'` and copy `_site/`
yourself, for example `aws s3 sync _site s3://my-bucket/store --delete` (do not `--delete` if you rely on the
bucket keeping old files). A mirror can copy the directory as it is: the signature still verifies.
More in WireHub's `docs/store-hosting.md`.

## Rotating or losing a key

Publishers and revoked keys, yanking a bad version and review status are all in `store-meta.json`
(WireHub's `docs/catalog-store.md`, "phase 5", and `store-index.mjs publisher | yank | revoke`).
If a private key leaks: make a new one, replace the secret, tell people to trust the new store key,
and (for a publisher key) add the old key under `revokedKeys`.

## Licence

Your packs carry the licence you give them in their manifests. `packs/example-pack` is CC0-1.0.

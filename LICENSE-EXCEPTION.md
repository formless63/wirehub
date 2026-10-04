# WireHub Module Exception, version 1.0

*Additional permission under section 7 of the GNU Affero General Public
License, version 3.*

WireHub is free software: you can redistribute it and/or modify it under the
terms of the GNU Affero General Public License, version 3 only
(`AGPL-3.0-only`, the full text is in [`LICENSE`](LICENSE)), with the
additional permission below. The copyright holders of WireHub grant this
permission for every part of WireHub they hold copyright in, and contributors
grant it for their contributions (see `CONTRIBUTING.md`).

## 0. Definitions

- **"WireHub"** means the work distributed in this repository under
  `AGPL-3.0-only` with this exception, and any version of it modified by
  anyone who keeps this exception.
- **"Module API"** means
  1. the interfaces, types and functions exported by the `@wirehub/modules`
     package (itself licensed MIT, see `packages/modules/LICENSE`), and the
     extension points they describe (`docs/modules.md`); and
  2. the public exports of the entry points (`src/index.ts`) of
     `@wirehub/model` and `@wirehub/catalog` — the data types those interfaces
     take and return, and the functions published beside them for working
     with that data;

  as published in a release of WireHub.
- **"Catalog-pack formats"** means the formats of catalog records, catalog
  files and catalog packs documented in `SPEC.md` and `docs/catalog-store.md`.
- **"Independent Module"** means a work that
  1. interacts with WireHub only through the Module API, the Catalog-pack
     formats, or both; and
  2. contains no part of WireHub other than declarations of the Module API,
     code samples from WireHub's documentation, and the registration glue.
- **"Registration glue"** means the entries that name an Independent Module
  in a deployment's module manifest (`apps/studio/modules.config.ts`) and in
  the dependency declarations and lockfile of that deployment.
- **"Combined Work"** means a work made by combining WireHub with one or more
  Independent Modules, for example a built image of the WireHub app whose
  manifest registers them.

## 1. The permission

As a special exception, you may combine WireHub with Independent Modules and
copy, modify, convey and run (including for users interacting with it over a
network) the resulting Combined Work, and you may license each Independent
Module, and convey it in source or object form, **under terms of your
choice** — a permissive licence, a copyleft licence, or a proprietary one —
provided that you comply with the AGPL for WireHub itself in every other
respect.

In particular, the AGPL's requirements to license the whole work under the
AGPL (section 5(c)) and to offer Corresponding Source (sections 6 and 13) do
**not** extend to an Independent Module or to its source code, and do not
extend to the registration glue. The Corresponding Source of WireHub you
offer may omit the registration glue, provided it still builds and runs
without the Independent Modules.

## 2. What stays under the AGPL

- **WireHub and every modification of it.** A change to any file of WireHub
  (other than registration glue) is a modification of WireHub and is covered
  by the AGPL, including its network-interaction clause (section 13).
- **A module that needs WireHub changed** to work is an Independent Module
  only if those changes are themselves offered under the AGPL as part of
  WireHub.
- **Code copied from WireHub** into a module, beyond what section 0 allows,
  stays under the AGPL, and a module that contains it is not an Independent
  Module.

## 3. Catalog data

Catalog packs and catalog records are data. A pack declares its licence in
its manifest, and a record may declare its own (`docs/catalog-store.md`).
Loading, installing or publishing a pack does not place it under the AGPL;
its own licence applies.

The starter catalog data (`packages/catalog/data`, and its frozen copy in
`packages/catalog/fixtures/v1/data`) and the catalog packs of the bundled
modules (`modules/*/pack`) are not under the AGPL either: they are
dedicated to the public domain under CC0 1.0 Universal (`CC0-1.0`, the
`LICENSE` file in each of those directories).

## 4. Keeping or removing this exception

If you modify WireHub, you may extend this exception to your version, but
you are not obliged to do so. If you do not wish to, delete this file and the
mention of it in `README.md` from your version.

## SPDX

The repository is `AGPL-3.0-only` with this additional permission (in SPDX 3
notation, `AGPL-3.0-only WITH AdditionRef-WireHub-Module-Exception-1.0`),
except:

- `packages/modules/` — `MIT` (`packages/modules/LICENSE`);
- the starter catalog data, `packages/catalog/data/` and
  `packages/catalog/fixtures/v1/data/` — `CC0-1.0` (the `LICENSE` file in
  each);
- the bundled modules, `modules/*/` — `MIT` (each module's `LICENSE`), their
  catalog packs `modules/*/pack/` `CC0-1.0` (`pack/LICENSE`);
- third-party material listed in `NOTICE`, under its own licence;
- catalog packs and records that declare their own licence.

Files carry no per-file licence headers; this file and each package's
`license` field are the record.

*This exception is modelled on the GPL linking exception and the Classpath
exception. It is not legal advice; have it reviewed before you rely on it
for a commercial decision.*

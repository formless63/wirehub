# CAD model discovery

An MIT utility module for finding better physical-part models. It adds **Find CAD models** to
the Library detail panel for connectors, bodies, components and mechanicals, and a standalone
page at `/m/catalog-assets/find`. It does not install catalog records or change pinouts.

Use a manufacturer's part number when known. Component records prefill their `mpn`;
connector and mechanical `partNumber` fields may contain an internal number, so these start
with a generic label search. Searches and KiCad filenames are **unverified candidates**, even
when they contain a part number. Verify the manufacturer, exact variant, dimensions, contact
layout and allowed use before attachment. A PCB-mounted RJ45 socket is not a cable plug.

The public KiCad browser queries the official GitLab repository tree, pinned to release
`9.0.9.1`, commit `2a697f255a3654e5175e2e9b5d2abdb4ca874015` (the studio's existing board-model
library pin). It lists STEP candidates with their source, license and direct upstream download.
Choose a category, browse pages or filter filenames **within each page**. Each request reads
at most 100 entries and 256 KiB, with an eight-second deadline and a 20-page limit. It fetches
only metadata from a fixed public GitLab URL, without credentials or redirects. Nothing is
fetched on opening the panel. No CAD bytes, extracted geometry or provider tables are bundled.

Download a STEP from the provider, then use the Library's **Attach model** / **Replace model**
upload flow. Preserve the shown source URL, library release or manufacturer revision and
license in **Source citation** before choosing the upload file. The host preserves it on the model link and stored asset. The module does not automatically attach, infer an
exact match or rewrite a model; the existing upload and model-cache conversion remain the host's.

External search buttons open TE Connectivity, SnapMagic Search and Ultra Librarian in a new
tab. They need no credentials in WireHub; the external provider may require an account for
downloads. They are search links, not availability checks or automatic provider API adapters.
Provider search terms leave WireHub only when a person follows the external link.

Primary references, checked 2026-10-10:

- [KiCad downloads and official library repositories](https://www.kicad.org/libraries/download/).
  The [3D library](https://gitlab.com/kicad/libraries/kicad-packages3D) carries CC BY-SA 4.0
  with the KiCad libraries exception; linked assets retain this license, rather than the
  bundled packs' CC0 license.
- [GitLab repository tree API](https://docs.gitlab.com/api/repositories/#list-repository-tree).
- [TE example product page with STEP CAD](https://www.te.com/en/product-2-353293-3.html).
  CAD availability and terms are per product; this module does not scrape TE or redistribute
  its CAD files.
- [SnapMagic FAQ](https://www.snapeda.com/about/FAQ/): individual CAD has CC BY-SA with a
  design exception; website terms are separate. API integration requires contacting the
  provider. This module opens official searches and does not embed or mirror their catalog.
- [Ultra Librarian API documentation](https://api.ultralibrarian.com/api-docs/) and
  [products](https://www.ultralibrarian.com/products/): integration and download access are
  provider-managed. This module requires no API key and makes no undocumented API calls.

For a runtime install, build/sign this module with the normal `wirehub-module build` workflow
and review/install it from a store or upload. It has no setup domain or catalog pack. Built-in
registration is through `apps/studio/modules.config.ts`.

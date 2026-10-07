# Example module (not for production)

A reference module with one contribution to **every** extension point of the
module system (`docs/modules.md`): setup, a catalog pack, a part-number scheme, a
validation rule, an importer, an exporter, an integration route, panels in all four
slots, a UI route, an auth provider, a commit hook, owned documents and derived
records. Read `src/index.ts` for the table; copy this folder as the start of a module
of your own.

The pack-root export keeps its filesystem URL for server and built-in use. Runtime
browser entries load from opaque blob URLs, so the example omits `catalogPacks`
there: the signed bundle's data is already installed. Keep this URL guard when
copying the scaffold; ignored runtime fields are removed after module evaluation.

It is **off by default**: the studio lists it in its manifest only when the dev flag
`WIREHUB_EXAMPLE_MODULE=1` is set when the app is built or started, so it is never
offered at `/setup` on a real hub. Enabling it sets this module's part-number scheme
and commit hook for the whole deployment, so use it on a scratch checkout.

Code: MIT. Pack data: CC0-1.0. Everything is synthetic.

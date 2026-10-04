# WireHub brand

| File | Use |
| --- | --- |
| `wirehub-logo.svg` | the logo; follows the viewer's light/dark preference (`prefers-color-scheme`) |
| `wirehub-logo-dark.svg` | the logo for dark backgrounds, fixed colours (for `<picture>` sources) |
| `wirehub-mark.svg` | the square mark: favicon, app icon, avatar |
| `wirehub-header.svg` | the README header (its own dark card, so it reads on any page) |

The app's icons (`apps/studio/public/`) are rendered from `wirehub-mark.svg` by
`pnpm --filter studio brand:icons`.

## The logo

"Wire" in monoline strokes — the letters are drawn as a wire would be laid —
and "Hub" in a rounded badge. The dot of the *i* is a copper solder node. The
lettering is paths, not text, so it renders the same everywhere without a
font.

## Palette

| Token (`tokens.css`) | Light | Dark | |
| --- | --- | --- | --- |
| `--brand` | `#1d3a5f` | `#2e5e99` | the badge; deep blue |
| `--brand-ink` | `#ffffff` | `#ffffff` | the badge's lettering |
| `--brand-wordmark` | `#1d3a5f` | `#e8edf3` | the "Wire" strokes |
| `--brand-copper` | `#c06a2b` | `#e39256` | the node; warm copper |
| `--accent` | `#b9622a` | `#e39256` | the UI accent: the copper of the logo |

Keep it calm: blue for identity, copper only as a small accent. No other
colours in the marks.

## Use

The name is **WireHub**, one word, capital W and H. The logo may be used to
refer to the project; it does not imply endorsement of a fork or a
deployment. Forks that are distributed as a different product should use
their own name and mark.

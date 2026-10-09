# Prime-time status

Re-shoot of 2026-10-09 against `main` at `fc41ad5`, on the real compose stack (locally built image, `pdf` profile),
with the PC & serial, Networking, Pro audio, Automotive and AV / video packs and the FX-rates and Suppliers code
modules installed. Every route in light and dark at 1440, a subset at 1920 and 390, plus lock and conflict
scenarios (the same design open in two sessions). The screenshots are kept outside the repository. Compared against
[`prime-time-plan.md`](prime-time-plan.md) sections 1 and 2. Status is Fixed, Partly or Open; follow-ups are beads.

## Top 10

| # | Issue | Status | Beads |
| --- | --- | --- | --- |
| 1 | Modules take over core screens | Fixed: collapsed one-line slots after the content, Tools popover in Documents | cs-af2.5, cs-af2.6 |
| 2 | Hand-wiring is close to impossible | Partly: pin lists with 16 px handles, drags and the connection table work, the wizard warns and offers by signal / colour / open; the canvas still fits small | cs-af2.9, cs-af2.10, cs-5ea.10, cs-5ea.11, cs-5ea.25 |
| 3 | Vocabulary leaks into unrelated designs | Fixed | cs-af2.8 |
| 4 | First impression is an error | Fixed: no rail, chip or toast on setup, code field in the top half; one silent disabled button remains | cs-af2.1, cs-af2.2, cs-5ea.33 |
| 5 | Store install gives little feedback | Fixed: drawer with counts, toasts, confirmed restart | cs-af2.12, cs-af2.13, cs-af2.14 |
| 6 | No design system in practice | Partly: tokens, primitives, DataTable and contrast fixed; native selects and file inputs remain in Documents and Extensions | cs-5ea.1 to cs-5ea.5, cs-af2.16, cs-5ea.23, cs-5ea.30 |
| 7 | Copy explains internals | Partly: paths and migration numbers gone from most pages; env var names and the stacked Installed layout remain | cs-af2.15, cs-5ea.24, cs-5ea.35 |
| 8 | Flat navigation, one concept in four places | Fixed: grouped rail, one Extensions page, People under Settings | cs-5ea.6, cs-5ea.7, cs-af2.7 |
| 9 | Documents are three products | Fixed in content and frame; a native select and file input remain in the drawing fields | cs-5ea.13 to cs-5ea.17, cs-5ea.23, cs-5ea.29 |
| 10 | Public front door shows nothing | Fixed: README hero, GIF and document strip; home with the same; guide screenshots; docs site. The generator and store pages keep the old look | cs-af2.17, cs-af2.18, cs-5ea.19, cs-5ea.28 |

## By area

| Area | Status | Notes and beads |
| --- | --- | --- |
| 2.1 Visual design system | Partly | Tokens, contrast, dark document frames fixed. Open: native controls (cs-5ea.23), document tab style (cs-5ea.29), React Flow attribution box in dark (cs-5ea.30) |
| 2.2 Navigation | Fixed | Grouped rail, per-route titles, Board import under Library |
| 2.3 First run | Fixed | Setup reordered, starter parts numbered, "New hub" strip. Open: empty states without an action (cs-5ea.34) |
| 2.4 Core workflow | Partly | Wizard reference prefilled, review warns, handles reachable, new layout puts the wire in the middle. Open: fit zoom and truncated titles (cs-5ea.25), wizard defaults (cs-5ea.31) |
| 2.5 Feedback | Partly | Toasts, drawer, confirm dialogs. Lock and conflict re-test: the second session sees "Open in another tab" with Take over, a rejected save explains itself. Open: the holder is not told of a take-over (cs-5ea.27), toast action wraps (cs-5ea.32) |
| 2.6 Accessibility | Partly | Skip link, landmarks, focusable rows, contrast. Open: double focus ring in wizard inputs (cs-5ea.31 covers the wizard) |
| 2.7 Copy and terminology | Partly | Design is the noun. Open: wizard button says cable (cs-5ea.31), Extensions and System copy (cs-5ea.24) |
| 2.8 Responsive | Fixed | 390 shows phone summaries, 3D, cards. Open: the top bar truncates the state chip |
| 2.9 Documents | Fixed | One frame, corner stamp, paper honoured, vector PDFs. Formboard labels crowd but do not overlap |
| 2.10 Brand and site | Partly | Home and docs share the app tokens and Plex; Lighthouse accessibility 100 on home. Open: generator and store (cs-5ea.28), sign-in page unbranded (cs-5ea.26) |
| 2.11 Performance perception | Fixed | No change needed |
| Data | New finding | Duplicate part numbers across starter and pack connectors (cs-5ea.22) |

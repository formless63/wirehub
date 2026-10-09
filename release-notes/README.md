# Release notes

`release-notes/<version>.md` (for example `0.7.0.md`) is the human highlights
section for a minor release. When the release workflow publishes `vX.Y.Z`, it
prepends that file to the GitHub release body, above the changelog
release-please generated. A release with no file for its version keeps the
generated notes alone.

Write for users: what changed for them, in their words (design, source end,
destination end), one short paragraph or bullet per change. Do not repeat the
commit list; the generated changelog below carries it. Keep screenshots out of
the repository; link them from the docs site if a change needs one.

# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it
privately through GitHub: on the repository page, **Security → Report a
vulnerability** (a private security advisory). Include what you found, how to
reproduce it, and the version or commit you tested.

You can expect an acknowledgement within a week. Once a fix is ready we
publish an advisory and a release, and credit you unless you would rather we
did not.

## Supported versions

WireHub is pre-1.0. Security fixes land on `main` and in the next release;
older releases are not patched. Run a current image
(`ghcr.io/formless63/wirehub`).

## Scope

In scope: the WireHub app and server, its container image, its compose
files, and the packages in this repository.

Out of scope: third-party modules and catalog packs (report those to their
authors), and deployments' own configuration — a hub exposed to the internet
without the login enabled is a configuration problem, not a vulnerability.

## Hardening notes for deployers

- Enable the login (`AUTH_ENABLED=true`) before exposing a hub beyond your
  own machine, and terminate TLS in front of it.
- Keep `.env` out of version control (it is gitignored); generate secrets
  with `openssl rand -base64 32`.
- Modules are trusted code, built into the image (`docs/modules.md`): review
  a module as you would review WireHub itself.

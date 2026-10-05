# Changelog

## 0.1.0 (2026-10-05)


### Features

* **catalog:** the catalog codec — explode a tree into rows, render rows back ([3904e59](https://github.com/formless63/wirehub/commit/3904e59d55b7d8429f6c50f1ee4f2d3e9e106ee7))
* default stack with Garage object storage, PostgreSQL 18 and backups ([4fc0a76](https://github.com/formless63/wirehub/commit/4fc0a76a4fbd8f4c52d688b029f47346cc58af0e))
* **env:** rename STUDIO_* variables to WIREHUB_*, keep the old names as a fallback ([af6509d](https://github.com/formless63/wirehub/commit/af6509dce529fc20bb0e12e9fe949375154cdf52))
* first-run setup and the automotive domain module ([2002a5f](https://github.com/formless63/wirehub/commit/2002a5f351521760d62e2ea9461a2e96251cd3c9))
* license WireHub as AGPL-3.0-only with a module exception ([de2c41c](https://github.com/formless63/wirehub/commit/de2c41c3675c5c5392b53d5746b7493ee3a26eac))
* **modules:** split serial, networking and audio into domain packs ([530df7b](https://github.com/formless63/wirehub/commit/530df7b9cfa75f1047d5b12aeb14ffc25d06c3f4))
* **setup:** setup code, unticked modules, packs beside the catalog, *_FILE variables ([7eb039d](https://github.com/formless63/wirehub/commit/7eb039d20eef84f4ebdbf9eb939ec89e5c50615f))
* **site:** config generator on GitHub Pages; releases with release-please ([ff41043](https://github.com/formless63/wirehub/commit/ff410430cc83a172a919b22f9257e95cde3f624b))
* **stack:** one compose file with profiles and self-bootstrapping secrets ([e4b04e2](https://github.com/formless63/wirehub/commit/e4b04e22789f1fc0881149af99aeab04b79518d8))
* **stack:** the database is the default; backups through studio_ro with restore checks (S1, S2, S6, S10) ([fc344b9](https://github.com/formless63/wirehub/commit/fc344b90988adb55febe5a460f8ec94f45b73e38))
* **studio:** adopt a file deployment at migrate time; the first admin claims it ([7c406c3](https://github.com/formless63/wirehub/commit/7c406c3016a46b23bb3047a9762296d98bce4591))
* **studio:** artwork and catalog docs are staged record kinds (B7, file backend) ([37224f2](https://github.com/formless63/wirehub/commit/37224f26ddfaa3827f205ce28835ae0c05e5f1b9))
* **studio:** bytes by content address and SVG entity refusal (B4) ([ec1abb6](https://github.com/formless63/wirehub/commit/ec1abb606cf6b76e344875fed93f69bd7209ac59))
* **studio:** converted models as derived blobs on Postgres (B10) ([2515dbd](https://github.com/formless63/wirehub/commit/2515dbd20e2dfefc873b3cee004dac96325e6208))
* **studio:** edit locks in Postgres and the events stream (B6) ([a663ab2](https://github.com/formless63/wirehub/commit/a663ab2e2d002de21c6b6f248a078124d0a0f0fe))
* **studio:** first-run setup creates the organisation, its catalog and the admin (S3) ([dffa87e](https://github.com/formless63/wirehub/commit/dffa87ee09bb30cff6061a2866a85ba32826f2b5))
* **studio:** first-run setup on Postgres, and pg:import --if-empty ([f5f5aae](https://github.com/formless63/wirehub/commit/f5f5aae09e392363c181581f03aa9546b3aaf7b5))
* **studio:** import a file catalog into Postgres as one change set ([565028c](https://github.com/formless63/wirehub/commit/565028cbb1f6c6228e93b7483fd3e11724114875))
* **studio:** model links are a staged record kind (B0) ([b6cd059](https://github.com/formless63/wirehub/commit/b6cd059442a312ec3bcc2ba4adf0efdbed443340))
* **studio:** People page, environment guard, and the indicator on Postgres (S4, S5, D6) ([afac826](https://github.com/formless63/wirehub/commit/afac82627dd6d0a008b3b9543d68491a4c41c818))
* **studio:** personal API tokens (B12) and RLS on the auth tables ([6d7f9f7](https://github.com/formless63/wirehub/commit/6d7f9f7b5f30800a8d777a39defbe881baf871b6))
* **studio:** pg:gate (S1), pg:import, pg:export and db:* commands ([437605a](https://github.com/formless63/wirehub/commit/437605a4d9ff6824f421abbec32dc42d3e724b14))
* **studio:** POST /api/batch, ?dryRun=1 and /api/docs (B13) ([926978f](https://github.com/formless63/wirehub/commit/926978fefbf12ed2d135d58c9104921ad60d349e))
* **studio:** Postgres scaffold, schema migrations 0000-0013 and the pg test harness ([28889ab](https://github.com/formless63/wirehub/commit/28889ab20ebba1feee2754b9450307f5635c18dd))
* **studio:** sign-in on Postgres — local accounts, people, invitations (B8) ([5926b05](https://github.com/formless63/wirehub/commit/5926b053d8a55383c17e843e5a07711b7a1ae547))
* **studio:** the catalog export is for owners and editors ([958cba7](https://github.com/formless63/wirehub/commit/958cba7d9eaa5355397d17f27fb2efbd10a19cfb))
* **studio:** the Postgres read path — snapshot, read stores, WIREHUB_BACKEND=pg ([cc93f93](https://github.com/formless63/wirehub/commit/cc93f939e6482bc00cde5e4e1d40cf1dfcc83d91))
* **studio:** the Postgres write path — one transaction per change set (B1-B3, B7, B9) ([76c8900](https://github.com/formless63/wirehub/commit/76c8900a3ff6602fd199d0fcf309fb5d0f584514))
* **studio:** WIREHUB_TRUST_PROXY; sign-in trusts the address the hub was opened at ([47e9b79](https://github.com/formless63/wirehub/commit/47e9b794a47e0fae3837b189d8bd49b338973f43))
* WireHub logo, icons and brand tokens ([6af399d](https://github.com/formless63/wirehub/commit/6af399df8a4a32d362ad21645b2a132a3e24b734))


### Bug Fixes

* **backup:** give pull --rebase a committer identity so rebases work on hosts with no git config ([b8ef350](https://github.com/formless63/wirehub/commit/b8ef35026146a28865f846a9992c4fc4138e5a0b))
* let the browser bundle link the catalog's pack installer ([7a466fe](https://github.com/formless63/wirehub/commit/7a466fe72ad364c64dc553df8ade7c0fbecd4934))

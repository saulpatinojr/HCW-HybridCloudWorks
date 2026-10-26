# Second Brain implementation validation

Local implementation checks completed on 2026-10-26 on `feat/second-brain`.
All data used by the new tests is synthetic.

| Check | Result |
| --- | --- |
| Functions unit/integration suite, after integrating current main | 315 files, 7,139 tests passed |
| Frontend unit/component suite, after integrating current main | 376 files, 5,482 tests passed |
| Repository scripts suite | 92 files passed, one skipped; 1,911 tests passed, 116 skipped |
| Chromium and mobile Chromium admin journeys | Four passed, covering owner capture/map and other-admin denial |
| Obsidian plugin tests | Twelve passed, including native authentication transport, host module loading, Windows DPAPI round trip, and offline/conflict recovery |
| Frontend production build and plugin build | Passed |
| Terraform validation and formatting | Passed; backend initialization disabled |
| Generated container manifest consistency | Passed |
| Plugin workflow actionlint | Passed |
| Plugin production dependency audit | No vulnerabilities reported |
| Changed UI lint and formatting, Functions lint, whitespace checks | Passed |

The repository scripts suite retains its existing cloud-dependent skips.
Full frontend lint has no errors and retains four existing warnings in
`AdminAuthGuard.jsx` and `LivePagesPage.jsx`; changed workspace components
have no lint warnings.
Browser checks run the real admin shell with synthetic identity/API boundaries.
They verify the selected map note is visible on both viewport sizes. Plugin
tests exercise durable replay, concurrent edits, archives, and reference-copy
recovery; the encryption test uses Windows CurrentUser DPAPI on synthetic data.

## Live rollout evidence, 2026-10-26

The initial implementation was merged in
[#1395](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1395).
The Windows pilot found and corrected two desktop integration defects:
plugin-local dependency resolution
([#1396](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1396)) and
renderer CORS during device-code authentication
([#1397](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1397)).
Companion 1.0.2 was exercised in Obsidian 1.14.5 with synthetic notes in an
isolated vault. No original notes were enrolled during these checks.

| Live check | Evidence |
| --- | --- |
| Infrastructure with feature flags initially off | [Reviewed apply](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs/run-oXQxasnD9B2asfPv) completed; both containers use `/ownerId` |
| Functions deployment | [Deployment and smoke checks](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/40293449308) succeeded |
| Frontend deployment | [Build and deployment](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/40292619287) succeeded |
| Owner activation | [Exact-value reviewed apply](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs/run-fwX5pchSqZq7S91J) completed; identity matched the existing API Admin assignment |
| On-demand AI activation | [Reviewed apply](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs/run-rzYRMxbeU5iKqqNU) completed after Foundry deployment checks |
| Anonymous access | Status, notes, graph, search, Ask, and sync returned 401 with private/no-store and noindex headers |
| Native-client scope isolation | Actual owner token contained only `brain_sync`; sync returned protocol 1 and a regular admin endpoint rejected that token with 401 |
| Device-code sign-in and storage | Native Obsidian transport completed sign-in; Windows DPAPI cache was created outside the pilot vault |
| Notes and stable relationships | Synthetic notes synchronized to Cosmos; a resolved wikilink became a stable link |
| Offline/reconnect | A simulated transport outage retained the pending edit; reconnect uploaded it without loss |
| Concurrent edits | Actual remote and local edits preserved both versions and uploaded the recovery note |
| Rename and duplicate delivery | Rename retained identity; replaying one mutation returned the same version and record |
| Archive conflict and restore | An offline edit against a remote archive became a recovery note; restore retained identity |
| Creator content and reference copies | Backfill completed; references downloaded; a local reference edit became a recoverable working note while its source copy was restored |
| Original-vault backup | Local archive verified against every original Markdown file with SHA-256; original note files remained unchanged |

Both feature flags remain disabled by default in source, and are enabled only
for the configured production owner through private workspace variables.

The following acceptance gates remain open: owner confirmation of the hosted
capture/search/map journey; a live cited AI answer and explicit draft creation;
a Cosmos backup export/restore drill covering the new authored records;
selection and enrollment of original notes; and private Obsidian Publish
retirement. No provider response or original-note migration is claimed by the
checks above. Complete those gates in the
[rollout runbook](../runbooks/second-brain.md).

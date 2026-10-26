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
isolated vault. Companion 1.0.3 additionally closes completed code dialogs
([#1399](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1399));
reopening Obsidian reused its encrypted session without another sign-in.

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
| Selected original-note enrollment | After owner selection and successful tests of copies, two idea notes were enrolled; body hashes and structured metadata matched their baselines |
| Original-vault companion | Cached authentication worked; selected notes uploaded without pending changes and creator references downloaded into the managed folder |
| Private Publish retirement | The last published page was unpublished and retained locally/in backup; the remote published-file count is zero; both hostnames' content endpoints returned empty 401 responses |
| Hosted owner workspace | Owner confirmed the Second Brain page heading at the production route |
| Hosted notes and synchronization | Owner screenshots show the two enrolled notes, a completed index, and zero reported pending changes or conflicts |
| Access recovery update | [Deployment](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/40305251929) succeeded after [#1402](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1402); unavailable access can be retried and unsaved notes survive a failed capability refresh |
| Interactive map and retrieval release | [Frontend](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/40309024721) and [Functions](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/40309021286) deployments succeeded for [#1406](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1406); live assets include the interactive controls |
| Follow-up private boundary | Nine anonymous requests to the configured API origin returned JSON 401 with private/no-store and noindex headers, including sync references, reindex, and draft creation |
| Follow-up Obsidian access | Original vault reused its cached owner sign-in against the deployed sync API, returned protocol 1, and reported zero pending operations and no error |
| Live cited assistant | Owner confirmed a source-citing outline; subsequent review of the response found topic drift and repeated meeting evidence, so source relevance remains an open acceptance check |

Both feature flags remain disabled by default in source, and are enabled only
for the configured production owner through private workspace variables.

The following acceptance gates remain open: live verification of the improved
interactive map and focused assistant retrieval, explicit draft creation, and
a Cosmos backup export/restore drill covering the new authored records.
The restore reader now includes containers introduced by subsequent daily
exports (#1399); its regression passed, while a live restore is still pending.
The live AI result was reviewed from owner-supplied text; its contents were not
copied into this public evidence record. The owner supplied an empty unsaved-note
screen, which does not prove draft creation. No Cosmos restore is claimed above.
Publish's empty site shells can return HTTP 200; the content endpoint checks,
not the HTML shell's status, establish that no note text was returned.
Complete the remaining gates in the
[rollout runbook](../runbooks/second-brain.md).

### Map and assistant follow-up

[#1406](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1406) replaces
the static map with a force layout, dragging, pan/zoom, motion controls,
relationship filters, neighborhood focus, and responsive label placement.
It also anchors retrieval to the selected idea, reduces duplicate recording
evidence, and makes citations resolve to exact protected items. Generic
requests without an identifiable subject ask for context before using AI.

Six local desktop/mobile browser journeys passed, including dragging, zoom,
relationship filtering, capture, and other-admin denial. Source-retrieval
regressions and the answer-to-note-to-draft component journey passed. These
synthetic checks do not replace owner verification after deployment.

After integrating current main, the follow-up passed 5,495 frontend tests
on Node 26.10 and 7,200 Functions tests on Node 24.20. Line coverage was
77.79% and 94.61%, respectively, above the unchanged committed thresholds.
The first concurrent local coverage attempt had Windows worker-start failures;
sequential runs with four workers completed successfully. Required CI and
the coverage job also passed for the merged follow-up.

### Remaining restore drill

The first scheduled export containing `brain_records` had not run at the time
of rollout. The next daily export is scheduled for 03:00 UTC on 2026-10-27
(22:00 America/Chicago on 2026-10-26). A repeated invocation on the same UTC
date skips the existing immutable run; it does not add new containers to its
completed manifest. Confirm that the next run's
complete manifest includes `brain_records` before proceeding; the schedule
alone is not proof of a successful backup. The operator's Azure session also
requires renewed authentication, and an isolated restore target has not been
provisioned. Local vault backup verification does not replace this cloud drill.

Follow the existing [Cosmos restore procedure](../runbooks/cosmos-restore.md)
using its supported identity and network controls. Restore `brain_records`
to an isolated target with `/ownerId` partitioning. Verify a selected note's
body, version, revisions, links, and collection membership against its backup
baseline. Rebuild `brain_search` using the restored records and isolated source
fixtures; verify search and backlinks. Disable outbound sync, indexing timers,
and publishing against production during the drill. Record the export manifests,
counts, elapsed time, and checks here before declaring this gate complete, then
perform the restore runbook's target and temporary-access cleanup.

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
the read of the first nightly export manifest that lists `brain_records`
(the restore drill itself ran on 2026-11-04; see the last section).
The restore reader now includes containers introduced by subsequent daily
exports (#1399); its regression passed, while a live restore is still pending.
The live AI result was reviewed from owner-supplied text; its contents were not
copied into this public evidence record. The owner supplied an empty unsaved-note
screen, which does not prove draft creation. No Cosmos restore is claimed in
the rollout evidence above; the drill of 2026-11-04 has its own section at
the end.
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

### Restore drill, 2026-11-04 (isolated point-in-time restore)

The drill for [#1409](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1409)
ran on 2026-11-04 from the shared operator sign-in, with the owner's written
go-ahead of the same day. It restored `brain_records` into a new, isolated
account with Azure Cosmos DB continuous backup (point-in-time restore) rather
than from the nightly export, because reading the export from a workstation
needs a storage firewall rule and a role on `stsiteprodcus01`, and neither was
allowed for this run. Continuous backup is the account's other recovery path
(`infra/cosmos.tf`, `Continuous30Days`). The isolation, identity and network
controls of the
[Cosmos restore runbook](../runbooks/cosmos-restore.md) were kept: a scratch
resource group tagged with its expiry, no account keys read, a data-plane role
for the signed-in user only, a firewall admitting only the operator's address,
and teardown by deleting the resource group. No production resource was
changed; the production account was only read (control plane and metrics).
Nothing ran against the restored copy but the checks below: no Function App,
sync, publishing or indexing timer was attached to it.

Microsoft Learn pages used:
[restore with the CLI](https://learn.microsoft.com/azure/cosmos-db/restore-account-continuous-backup#restore-an-account-using-azure-cli),
[latest restorable timestamp](https://learn.microsoft.com/azure/cosmos-db/get-latest-restore-timestamp),
[what is restored](https://learn.microsoft.com/azure/cosmos-db/continuous-backup-restore-introduction#what-is-restored-into-a-new-account)
and [pricing](https://learn.microsoft.com/azure/cosmos-db/continuous-backup-restore-introduction#pricing).

| Step | Evidence |
| --- | --- |
| Baseline (production, read-only) | Azure Monitor hourly maximum for 20:00 to 21:00 UTC: `brain_records` 84 documents, 448 KiB; `brain_search` 2,913 documents, 3.2 MiB. Container events show `brain_records` and `brain_search` created 2026-10-26 08:33 UTC, both on `/ownerId` |
| Restore point | Latest restorable timestamp for `brain_records` read at 20:57 UTC: 2026-11-04T20:58:05Z; the restore used that timestamp |
| Target | `cosmos-site-sbx-cus` in `rg-db-site-sbx-cus` (Central US, serverless, local authentication disabled, `createMode: Restore`, `restoreMode: PointInTime`, databases to restore `hcw` / `brain_records` only, TTL disabled) |
| Restore duration | Issued 20:58:05 UTC, `provisioningState: Succeeded` at 21:09:02 UTC (about 11 minutes); the firewall update that followed took about 20 minutes |
| Restored container | `brain_records` on `/ownerId`, 84 documents in one owner partition: 6 notes, 3 conflict records, 24 revisions, 24 events, 24 receipts, 1 state, 1 sync-status, 1 indexing job. 84 equals the production baseline |
| Selected record | A note with a link, at version 5 with 5 stored revisions. Revision sequence numbers descend without gaps; the newest revision's sequence, version, title and body hash (70 bytes) equal the record's; the event for its latest sequence exists; its one link resolves to an existing record. It carries no collections, and no authored record in the backup does (0 of 9), so collection membership was verified as empty rather than skipped. The note is archived, so the site's backlink query (which excludes archived notes) returns 0 for it while the raw link count is 1, as designed |
| `brain_search` rebuild | An empty `brain_search` (`/ownerId`) and the seven source containers were created in the drill account, with three made-up fixture documents (one article, one recording, one social post about "zebra backups"). The indexer from `functions/src/lib/brain/indexing.js` ran from the restored notes plus those fixtures: 8 steps, 17 documents visited, status `complete`, 4.0 s. Result: 5 search items (2 live notes, 3 references) |
| Search and backlinks | "zebra backups" returned the 3 fixture references and nothing else; a term from a live note's title found that note; the archived selected note was excluded; a nonsense term returned 0. Backlinks of the selected note's link target: 0 through the site query (all three linkers are archived), 3 by raw count; the target record exists |
| Elapsed | Clock started 20:57:56 UTC; verification finished 21:34:12 UTC: 36 min 16 s to a verified restore and rebuilt index. Teardown followed |
| Cost | About USD 0.0001 restore charge (0.00045 GB at the Learn rate of USD 0.15/GB) plus a few hundred serverless request units; estimated, not yet visible in billing |
| Cleanup | `az group delete -n rg-db-site-sbx-cus --yes`; afterwards `az group exists` is `false` and `az cosmosdb show -n cosmos-site-sbx-cus` answers not found (the pull request for this record links the run output) |

Checked, with the result: lines 2 to 6 of #1409 (isolated target, restore and
record verification, isolated `brain_search` rebuild with search and
backlinks, this record, cleanup).

Not verified, and why: line 1, the nightly export manifest that lists
`brain_records` with `/ownerId` and a record count. The `cosmos-export`
container refuses every workstation by design; the Health page reader from
[#1546](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1546) was
merged on 2026-11-04 but the newest functions deployment (a manual
`deploy-functions.yml` run) predates it, so the tile is not live yet; and
Application Insights holds no `cosmosExportCompleted` event after
2026-10-26 because the workspace's daily cap drops the 03:00 UTC window
([#1530](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1530)).
The counts above come from the restore target, not from a manifest. The
manifest read stays open until the functions deployment lands and the
Nightly export tile shows `brain_records: N records, partition key /ownerId`.

What the drill did not rehearse: the runbook's export-based restore (its
Drills table is unchanged, since this run did not follow that procedure), the
site's public reads against the restored account, and a side-by-side
comparison with production documents (the operator sign-in holds no data-plane
role on the production account, and granting one would change production; the
comparison above is against the record's own revision chain inside the
restore).

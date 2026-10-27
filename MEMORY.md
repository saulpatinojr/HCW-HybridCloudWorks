# Continuation memory

Updated: 2026-10-27, America/Chicago (CDT). This is a dated handoff, not a live
status feed or a replacement for GitHub issues. Refresh GitHub state before acting.

Two working sessions wrote this file on the same day: the application work (AI Engine,
Ambassadors, Blogs and their deployments) and the infrastructure, CI and add-on work
(the section "Infrastructure, CI and add-on work" below). Read both.

## Resume here

1. Read this file and `.github/CONTRIBUTING.md`; inspect applicable `AGENTS.md` files.
2. Check `git status --short`, `git branch -vv`, and `git worktree list`.
3. Fetch with pruning and fast-forward `main` before starting a new branch.
4. Check `gh pr list --state open` and recent workflow runs. Continue an existing
   PR when appropriate; put new work on a branch and merge through a reviewed PR.
5. Use GitHub issues for the backlog and `CHANGELOG.md` for completed work. The
   cleanup and this handoff were requested in [#1450](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1450)
   and merged in [#1451](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1451);
   the infrastructure section was added afterwards. Standing orders for the
   owner's estate (who does what, how pull requests and reviews are handled, how
   items are linked) are in [`.claude/CLAUDE.md`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.claude/CLAUDE.md).

## Completed application work

| Work | Merged PR | Result |
| --- | --- | --- |
| AI Engine and Ambassadors | [#1438](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1438) | Bounded model refresh, accurate routing/cost states, reviewed pricing and TTS recommendations, removal of the public GitKraken footer link, responsive Ambassador layouts, and qualification-period readiness fixes. |
| Blogs | [#1446](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1446) | Official Kiro AWS RSS source and Blogs hub below Coder Corner; editable sources/articles, fallback images, filters, limits, pause/resume, manual intake, and run status. |

Both PRs are merged. Their required checks passed, including browser checks on
Chromium and Pixel 5. Blogs completed three CodeRabbit review rounds; every
finding was addressed and its threads resolved, and the final revision was approved.

## Verified deployment state

The application release `3008b238` (Blogs plus the earlier AI/Ambassador fixes)
**deployed successfully**, verified again on 2026-10-27:

- [Azure Functions release](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/40551342874): success.
- [Frontend release](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/40551348014): success.

The earlier approval blocker is resolved for these runs. Older unstarted releases
were canceled. Do not revive an old run or assume a newer commit is deployed.

At the cleanup audit, `main` was `db38bca7`, also including merged lab-host pin
PRs [#1448](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1448) and
[#1449](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1449). Those
application deployment runs do not establish that the newer lab-host pins were
applied to the host. Read the pin PR and [lab host runbook](docs/runbooks/labs-host.md)
before any infrastructure action.

## Infrastructure, CI and add-on work

Everything open is on the [HCW Work Board](https://github.com/users/saulpatinojr/projects/6): work it from the
top (P1 now, then P2 next, then P3 later; "Gated" waits for the named gate). Nothing was unpushed or uncommitted in any HCW
clone on the owner's PC when this was written, and the only open pull request in the HCW repositories belonged to another
session: [Network Eyes App #339](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/339).

**Rules that were learned the hard way** (the full list is in CLAUDE.md):

- Never print or ask for a secret, and never put a tenant, subscription or application id in a public file.
- A tag that publishes an image is irreversible: push one only after the owner's explicit word and a green dry run on the exact commit.
- No admin bypass and no force-push to `main`. Sessions never run `terraform apply` or delete Azure resources unless told to.
- A safety-check refusal is not worked around: say exactly what is blocked and why, and carry on with everything else.
- Review bots: at most three rounds each. Answer every finding on its thread, naming the commit, before resolving it. CodeRabbit's
  approval of the last push is what the ruleset needs, and it is asked for with a comment containing `@coderabbitai review`.
- The Docker-Sponsored Open Source application is tracked only by the admin calendar alert for 2026-10-30. Do not list it as waiting.

**Done today** (merged and checked on GitHub):

| What | Where |
| --- | --- |
| The CI path-filter guard follows imports across packages; 54 + 36 missing files listed | [#1442](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1442), ticket [#1428](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1428) |
| CodeQL and Terraform/Trivy checks fail loudly when a path filter cannot be read (proved live) | [#1439](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1439), ticket [#1429](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1429) |
| Lab pin bot: notes beside a pin can no longer name a version the weekly bump will move, and a test enforces it | [#1448](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1448), ticket [#1444](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1444) |
| Fresh lab pin bump (Coder, Vault, Portainer, Node.js, Caddy builder and PostgreSQL digests); nothing changes on the lab host until `bootstrap.sh` runs | [#1449](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1449) |
| Cloud Crawler add-on: Dependabot's Python updates work again; five update pull requests merged | [#35](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/pull/35), ticket [#33](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/issues/33) |
| Add-on images follow the website's base image on their own (Cloud Assessor, Cloud Crawler, Network Eyes); live proofs recorded | [CA #46](https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn/issues/46), [CC #27](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/issues/27), [NE #49](https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn/issues/49) |
| Cloud Assessor and Network Eyes add-on images `v0.1.1` published and attested | [CA #47](https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn/issues/47), [NE #50](https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn/issues/50) |

**What the next session does, in order:**

1. [#1386](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1386): add-on base images drifting from the website's pin. The automatic follow-up now exists in three add-ons,
   so check its "done when" lines and close it with the evidence if they are met.
2. [Cloud Crawler add-on #29](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/issues/29): ship Terraform reading (engine release, add-on release, then restore the website wording).
3. [Migrate Orchestrator add-on #50](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_AddOn/issues/50): prove the core-update path with a real engine bump in all four add-ons,
   and read the result of the gitleaks scan that runs on Monday 2026-11-02.
4. [#1421](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1421): the daily Cloudflare DNS audit flagged 12 changes as unexpected. All 12 are `_acme-challenge` TXT records on the main
   domain created and deleted by an actor the log calls "system unknown". The allowlist in `scripts/cloudflare-dns-audit.mjs` only knows the lab host's Caddy token, whose challenges now live in the
   lab zone, so this may be certificate validation done on Cloudflare's side. That is a guess: the audit-log entries have to be read in the Cloudflare dashboard (the owner's login) before any allowlist
   entry is added. Procedure: [the daily DNS audit](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/edge-dns-verification.md).
5. [#1431](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1431): stays open until 2026-11-10; close it if the Doc Vault "linear time" test is not seen failing in CI. Then
   [#1433](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1433), the same weakness in the frontend twin.
6. Visitor-session follow-ups from reviews: [#1403](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403) and [#1400](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1400).
   Remove the msal-node override when it is safe: [#1346](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1346).
7. Later (P3): [#1447](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1447), the lab pin bot silently dropping a publisher it cannot read, and
   [#1441](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1441), CI jobs that run repository code having no time limit.
   [#1426](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1426) is the weekly lab supply-chain issue: the bot refreshes it on Tuesdays.

Dates: Monday 2026-11-02 06:00 UTC (Dependabot run, gitleaks scan); Tuesday 2026-11-03 06:45 UTC (lab supply-chain run); 2026-11-10 ([#1431](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1431)).

**Waiting on the owner:**

1. Delete the leftover work-in-progress branch `ci/base-update-workflow` in the Network Eyes add-on (its work is superseded by the merged base-image follow, and its commit is saved in a
   bundle). A session's own delete was refused by the safety check, so run this in PowerShell:
   `gh api -X DELETE repos/saulpatinojr/HCW-NetworkEyes_AddOn/git/refs/heads/ci/base-update-workflow`
   You should see no output; the branch then disappears from the [branch list](https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn/branches).
2. Run the lab host's `bootstrap.sh` when convenient, to apply [#1449](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1449) and [#1448](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1448):
   `ssh -t hcw-lab "sudo /opt/hcw-src/lab-host/bootstrap.sh"`
   A good run ends with a `PLAY RECAP` line for `localhost` showing `failed=0` and `unreachable=0`. Pick a quiet time: the Coder, PostgreSQL, Portainer and Vault containers are recreated because their
   images changed (a reading of the roles, not something that was run). Expect one extra `changed` task, the Coder helper install, with no restart. **Check first:**
   [Portainer 2.45.3](https://github.com/portainer/portainer/releases/tag/2.45.3) no longer trusts TLS certificates issued by eMudhra (emSign), so a registry added by hand in Portainer's web page
   that uses one would stop working. Nothing in this repository configures such a connection.
3. Decisions already waiting for an answer: [#1373](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1373) (the batch of owner decisions),
   [#1392](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1392) (confirm the Terraform run that creates the Doc Vault container) and
   [#1344](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1344) (publish the first interview).
4. Optional clean-up of leftovers on the owner's PC that were not created by this work or could not be proved stale (nothing here is needed to continue):
   - Two test images, about 1.4 GB, left from [Network Eyes App #248](https://github.com/saulpatinojr/HCW-NetworkEyes_App/issues/248) (closed): `docker rmi ne248-web:test ne248-drawio:test`
   - Seven safety bundles of old commits in the `.hcw` folder of the owner's profile (`$env:USERPROFILE\.hcw\leftover-commit-bundles-2026-10-26`), about 100 KB, kept because their contents could not be
     checked against `main`. They are only backups; delete the folder once they are no longer wanted.

## Blog workflow details worth preserving

- Kiro uses its advertised RSS feed: `https://kiro.dev/blog/feed.rss`, under AWS.
- RSS runs every two hours; listing discovery runs every six hours, in UTC and
  subject to the existing scheduler switches. Manual source jobs use saved settings.
- Intake deduplicates into non-live drafts, then inspection, ContentForge, review,
  and the existing quality/image/publish gates control article publication.
- Image precedence preserves existing/generated/feed images, then checks scraped
  article/social images, then applies the configured source default. Defaults are
  captured on new imports; existing articles can be edited individually.
- Source overrides and advisory run status use the existing `admin_settings`
  container. Custom sources are untrusted; moving an official source to another
  hostname removes its official trust. Concurrent source edits return 409.
- Listing ingestion now supplies its missing default UUID generator, resolves
  relative links correctly, isolates malformed links, and reports body-read errors
  without leaking upstream response text. Status writes cannot fail a valid import.
- Full operating details: [blog workflow](docs/content/blog-machine.md#blog-source-controls-october-2026).

## Cleanup and local environment

The audit found no uncommitted work or open PRs, and only `main` on GitHub.
Old local branches `feat/blog-source-workflow` and `fix/ai-engine-model-routing-costs`
were verified against their merged PRs before deletion; `work` was already an
ancestor of `main`. Remote references and stale worktree records were pruned.

Cleanup removed generated builds, reports, caches, old task scripts, downloaded
research pages, and temporary review/approval payloads. Keep source, tracked test
fixtures (including `.log` fixtures), credentials, runtime control directories,
installed dependencies, and toolchains. Git recovery history is retained.

- Frontend and operations scripts use Node 26; Azure Functions uses Node 24.
  Check each package's `engines` and lockfile before changing versions.
- This cloud workspace retains the installed toolchains and documentation venv
  in the sibling `.hcw-tools` directory. They are not repository files.
- Installed `node_modules` are retained. Run `npm ci` in the relevant package
  only when installation is needed; run `npm test` and `npm run lint` there.
- Docs: install `scripts/docs/requirements.txt` in a venv, run
  `python scripts/docs/check_redaction.py`, `python scripts/docs/check_stale_state.py`,
  then `mkdocs build --strict`.
- Repository structure is checked by `scripts/validate-repository-structure.ps1`.
  `MEMORY.md` is an explicit owner-requested root exception and is redaction-checked.

## GitHub and release reminders

- Use the existing GitHub authentication; never copy credentials into this file.
- If Git stalls on credentials, the command-scoped helper
  `git -c credential.helper= -c 'credential.helper=!gh auth git-credential' ...`
  worked here. Preserve the managed environment's proxy and CA configuration.
- Commits used the account's public noreply email to avoid GitHub's private-email
  push rejection; obtain the appropriate public identity for the active account.
- The installed CLI's `gh pr edit` hit the retired Projects Classic API. Updating
  a PR through `gh api --method PATCH` with a JSON input file worked.
- Production workflows are manually dispatched from `main`. The integration's
  production approval request returned HTTP 403; use GitHub's production review
  UI when approval is required. Deploy Functions before the frontend.
- Keep review feedback addressed and threads resolved. Follow the repository's
  three-round review cap; leave bot code-writing triggers and Autopilot unticked.

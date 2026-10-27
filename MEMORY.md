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

Written by the second session on 2026-10-27, about 19:30 UTC. Everything open is on the
[HCW Work Board](https://github.com/users/saulpatinojr/projects/6): P1 now, then P2 next, then P3 later ("Gated" means waiting for a named
decision). Work it from the top. Before starting anything, run `gh pr list --state open` in every HCW repository: two sessions wrote this file
at the same moment today. [Network Eyes App #339](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/339) belongs to another session;
leave it alone. A session never switches the main checkout's branch; it works in its own worktree (a second copy of the files on its own branch).

### Waiting on the owner

1. **Read the audit-log entries behind [#1421](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1421), a security alert (P1).** The daily Cloudflare DNS audit
   flagged 12 changes on 2026-10-26 as unexpected, and its own instruction is to treat them as a possible stolen DNS token until the entries show otherwise
   ([what to do if one was stolen](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/dns-token-stolen.md)). What is known: all 12 are `_acme-challenge` TXT records
   (temporary records a certificate authority asks for to prove who owns a domain) on the main domain, six created and six deleted, by an actor the log calls "system unknown".
   The allowlist (the list of changes the audit treats as normal) in `scripts/cloudflare-dns-audit.mjs` knows only the lab host's Caddy token for these records, and Caddy's challenges now
   live in the lab zone. One possible explanation, not checked, is certificate validation done on Cloudflare's side. Only the owner's Cloudflare login can read the entries: the issue links the
   [audit log](https://dash.cloudflare.com/?to=/:account/audit-log) and lists each entry id; the steps are in
   [the daily DNS audit](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/edge-dns-verification.md). Add no allowlist entry before that.
2. **Run the lab host's `bootstrap.sh`** (the script that brings the lab server in line with this repository; tracked in
   [#1454](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1454)) when convenient, to apply
   [#1449](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1449) (the new versions; [#1448](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1448) changed only comments and a test).
   **Read this first.** The run restarts things on the lab server, so pick a quiet time: Coder, its PostgreSQL database and Portainer are recreated because their images changed, and Vault
   (the secrets service) restarts because its program file changed, then unseals itself. This is a reading of the roles
   ([Vault](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-host/ansible/roles/vault/tasks/install.yml),
   [Caddy](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-host/ansible/roles/caddy/tasks/main.yml)), not something that was run. Also check
   [Portainer 2.45.3](https://github.com/portainer/portainer/releases/tag/2.45.3): it no longer trusts certificates issued by eMudhra (emSign), and its notes name single sign-on, LDAPS, registry and Git-host
   connections. Nothing in this repository configures one, but one added by hand in Portainer's web page would stop working. Then run this in PowerShell:
   `ssh -t hcw-lab "sudo /opt/hcw-src/lab-host/bootstrap.sh"`
   A good run ends with a `PLAY RECAP` line for `localhost` showing `failed=0` and `unreachable=0`; several tasks reading `changed` is expected. If you see a failure, do not run it again in a loop:
   copy the last 30 lines to the session and see the [lab host runbook](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/labs-host.md).
3. **Decisions already waiting for an answer:** [#1373](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1373) (the batch of owner decisions),
   [#1392](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1392) (confirm the Terraform run that creates the Doc Vault container) and
   [#1344](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1344) (publish the first interview). Issues labelled `owner-gated` wait only for the owner's decision.
4. **Optional clean-up on the owner's PC** (nothing here is needed to continue):
   - Two test images, about 1.4 GB, left from [Network Eyes App #248](https://github.com/saulpatinojr/HCW-NetworkEyes_App/issues/248) (closed). Run `docker rmi ne248-web:test ne248-drawio:test`.
     You should see two `Untagged:` and two `Deleted:` lines; if Docker says an image is in use, stop the container that uses it first, or leave it.
   - Seven small backup files of old commits (about 100 KB) in the `.hcw` folder of the owner's profile, kept because their contents could not be checked against `main`. Deleting them cannot be undone, so
     do it only when sure. Run `Remove-Item -Recurse "$env:USERPROFILE\.hcw\leftover-commit-bundles-2026-10-26"`. You should see no output; "Cannot find path" means they are already gone.
   - In the Network Eyes add-on clone, `git fetch --prune` drops a stale local reference to a branch that no longer exists on GitHub.

### What the next session does, in order

1. [#1421](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1421), once the owner has read the entries: if they are Cloudflare's own certificate validation, add the allowlist entry with its reason; if not, follow the stolen-token runbook above.
2. [#1386](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1386): each Python add-on now has a daily workflow (`base-update.yml`) that opens the base-image follow-up pull request by itself. It was proved on
   throwaway branches, not on a real website change, so its "done when" lines 1 and 3 still wait for the next real bump. One may be close: [#1426](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1426)
   says `python:3.14.10-slim-trixie` is available but its tags "have not settled". Leave #1386 open until a real bump has produced the three pull requests, or write on the ticket that the throwaway proofs are accepted, and why.
3. [Cloud Crawler add-on #29](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/issues/29): ship Terraform reading (engine release, add-on release, then restore the website wording).
4. [Migrate Orchestrator add-on #50](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_AddOn/issues/50): prove the core-update path (the workflow that opens the engine-bump pull request) with a real bump in all four add-ons,
   and read the result of the weekly secret scan (gitleaks, which searches the whole history for leaked secrets) of Monday 2026-11-02.
5. [#1431](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1431): stays open until 2026-11-10; close it if the Doc Vault "linear time" test is not seen failing in CI. Then
   [#1433](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1433), the same weakness in the frontend twin.
6. Visitor-session follow-ups from reviews: [#1403](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403) and [#1400](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1400).
7. Later (P3): [#1346](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1346) (remove the forced version of a sign-in library, msal-node, once it is safe),
   [#1447](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1447) (the lab pin bot silently drops a publisher it cannot read) and
   [#1441](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1441) (CI jobs that run repository code have no time limit).
8. [#1426](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1426) is the weekly lab supply-chain issue (next refresh Tuesday 2026-11-03). Its pin table was written before #1449 merged, so it still shows four pins as
   behind; the next run shows them current whether or not `bootstrap.sh` has run, because it compares this repository's pins with the publishers, not the host. It also lists 1 critical and 164 high findings with
   fixes in the published lab-runner image; those fixes arrive through the `chore/lab-pins-image-tools` pull request once their publishers release.

Dates: Monday 2026-11-02 (Dependabot's weekly run, 06:00 UTC in the Cloud Crawler add-on; the weekly secret scan at about 06:17 UTC in Migrate Orchestrator and 06:23 UTC in the other three add-ons);
Tuesday 2026-11-03 06:45 UTC (lab supply-chain run); 2026-11-10 ([#1431](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1431)).

### Rules that were learned the hard way

[`.claude/CLAUDE.md`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.claude/CLAUDE.md) holds the review, link, draft-article and refusal rules, and the commands to check a pull request's
reviews. The lines below come from the owner's earlier sessions and are written down only here:

- Never print or ask for a secret, and never put a tenant, subscription or application id in a public file.
- A tag that publishes an image is irreversible: push one only after the owner's explicit word and a green dry run on the exact commit.
- No admin bypass (merging past the repository's rules) and no force-push to `main`. Sessions never run `terraform apply` or delete Azure resources unless told to.
- A safety-check refusal is not worked around: say exactly what is blocked and why, and carry on with everything else.
- Sessions merge their own pull requests once the required checks are green, every review conversation is resolved and CodeRabbit has approved the last push; never hand the owner a merge.
  The ruleset itself requires the checks and resolved conversations but no approving review (`required_approving_review_count` is 0, read from the API on 2026-10-27), so CodeRabbit's
  approval is this repository's practice, not a gate. `.claude/CLAUDE.md` still says otherwise; fixing that is [#1455](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1455).
- Review bots (CodeRabbit, Copilot and GitHub's code scanning, the automated reviewers on every pull request): at most three rounds each. Answer every finding on its thread, naming the commit,
  before resolving it. Ask CodeRabbit with a comment containing `@coderabbitai review`, and never tick the boxes in its summary (Commit to this branch, Create a new PR, Fix all pre-merge checks with AI,
  Autopilot): they make it write code. Copilot is out of credits until 2026-10-31; do not wait for its review.
- Two pull requests that touch the same lines, above all `CHANGELOG.md`, go one at a time.
- The Docker-Sponsored Open Source application is tracked only by the admin calendar alert for 2026-10-30. Do not list it as waiting.
- Obsidian and the Second Brain work are not part of this workstream.

### Done on 2026-10-27 (details in the changelog and the ticket comments)

- The pull-request check that lists which files each automated job watches now follows imports across packages and lists 54 + 36 files it was missing:
  [#1442](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1442) (ticket [#1428](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1428)). A CodeQL or Terraform/Trivy check whose path filter cannot be read now fails
  instead of being skipped, proved live: [#1439](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1439).
- The lab pin bot's notes can no longer name a version the weekly bump will move, and a test enforces it: [#1448](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1448). A fresh bump (Coder, Vault, Portainer,
  Node.js, and the Caddy builder and PostgreSQL image digests) was merged in [#1449](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1449); nothing changes on the lab host until `bootstrap.sh` runs.
- Cloud Crawler add-on: Dependabot (GitHub's service that opens pull requests for newer dependencies) works again and five update pull requests merged:
  [#35](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/pull/35), ticket [#33](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/issues/33).
- Cloud Assessor and Network Eyes add-on images `v0.1.1` were published and attested ([CA #47](https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn/issues/47),
  [NE #50](https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn/issues/50)). The three Python add-ons follow the website's base image on their own
  ([CA #46](https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn/issues/46), [CC #27](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/issues/27), [NE #49](https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn/issues/49)).

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

The audit found no uncommitted work or open PRs, and only `main` on GitHub. (That is the earlier
snapshot of 2026-10-27. In the later one, about 19:30 UTC, "Infrastructure, CI and add-on work" above names the Network Eyes
App pull request that belongs to another session. Check `gh pr list --state open` again before relying on either.)
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

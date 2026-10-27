# Memory: where the work stands, 2026-10-27 (travel handoff)

Written for the owner, working from a phone while travelling, and for any new Claude session that picks the work up.
It is a snapshot, not a source of truth: check GitHub before acting on any line. Requested in
[#1450](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1450); it is the only file of its kind allowed at the root
(see "How this file is kept" at the end).

State when written: `main` of this repository was at
[db38bca7](https://github.com/saulpatinojr/HCW-HybridCloudWorks/commit/db38bca7957f7dc439a30c00df42ba2e7d1f4ccb) with its
[`ci.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/40561024351) and
[CodeQL](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/40561025953) runs green. Every HCW clone on the owner's PC was clean,
on `main`, with nothing unpushed. The only open pull request in the HCW repositories belongs to another session:
[Network Eyes App #339](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/339).

## Start here

1. Read [`.claude/CLAUDE.md`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.claude/CLAUDE.md). It holds the standing orders:
   the session runs the work and the owner is the last gate, specialist agents do the tickets, pull requests open ready for review, and every item named to the
   owner carries its link.
2. Work the [HCW Work Board](https://github.com/users/saulpatinojr/projects/6) from the top: P1 now, then P2 next, then P3 later. "Gated" items wait for the named gate.
3. Owner commands are PowerShell 5.1 one-liners with no placeholders. If a command must be bash, say so on the line above it.

Rules that were learned the hard way (the full list is in CLAUDE.md):

- Never print or ask for a secret, and never put a tenant, subscription or application id in a public file.
- Tags that publish images are irreversible: push one only after the owner's explicit word and a green dry run on the exact commit.
- No admin bypass, no force-push to `main`, and sessions never run `terraform apply` or delete Azure resources unless told to.
- A safety-check refusal is not worked around: say exactly what is blocked and why, and carry on with everything else.
- Review bots: at most three rounds each; answer every finding on its thread (naming the commit) before resolving it.
  CodeRabbit's approval of the last push is what the ruleset needs, and it must be asked for with `@coderabbitai review`.
- Draft articles never go in this public repository (they live in the admin Drafts page and the owner's private vault).
- The Docker-Sponsored Open Source application is tracked only by the admin calendar alert for 2026-10-30. Do not list it as waiting.
- Obsidian and the Second Brain work are not part of this workstream.

## Done today (all merged, checked on GitHub)

| What | Where |
| --- | --- |
| The CI path-filter guard follows imports across packages; 54 + 36 missing files listed | [#1442](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1442), ticket [#1428](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1428) closed |
| CodeQL and Terraform/Trivy checks fail loudly when a path filter cannot be read (proved live) | [#1439](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1439), ticket [#1429](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1429) closed |
| Lab pin bot: notes beside a pin can no longer name a version the weekly bump will move, and a test enforces it | [#1448](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1448), ticket [#1444](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1444) closed |
| Fresh lab pin bump (Coder, Vault, Portainer, Node.js, Caddy builder and PostgreSQL digests) | [#1449](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1449); nothing changes on the lab host until `bootstrap.sh` runs |
| Cloud Crawler add-on: Dependabot's Python updates work again; five update pull requests merged | [#35](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/pull/35), ticket [#33](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/issues/33) closed |
| Add-on images follow the website's base image on their own (Cloud Assessor, Cloud Crawler, Network Eyes); live proofs recorded | [CA #46](https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn/issues/46), [CC #27](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/issues/27), [NE #49](https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn/issues/49) closed |
| Cloud Assessor and Network Eyes add-on images `v0.1.1` published and attested | [CA #47](https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn/issues/47), [NE #50](https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn/issues/50) closed |
| Flaky Doc Vault timing test fixed on the server side | [#1434](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1434) |

## What the next session does, in order

1. [#1386](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1386): add-on base images drifting from the website's pin. The automatic follow-up now exists in three add-ons, so
   check its "done when" lines and close it with the evidence if they are met (it carries the `owner-gated` label, so say what you did on the ticket).
2. [Cloud Crawler add-on #29](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/issues/29): ship Terraform reading (engine release, add-on release, then restore the website wording).
3. [Migrate Orchestrator add-on #50](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_AddOn/issues/50): prove the core-update path with a real engine bump in all four add-ons,
   and read the result of the gitleaks scan that runs on Monday 2026-11-02.
4. [#1421](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1421): the daily Cloudflare DNS audit flagged 12 changes as unexpected. All 12 are `_acme-challenge` TXT records on the main
   domain created and deleted by an actor the log calls "system unknown". The allowlist in `scripts/cloudflare-dns-audit.mjs` only knows the lab host's Caddy token, whose
   challenges now live in the lab zone, so this may be certificate validation done on Cloudflare's side. That is a guess: it needs the audit-log entries read in the Cloudflare
   dashboard (the owner's login) before any allowlist entry is added. Procedure: [docs/runbooks/edge-dns-verification.md](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/edge-dns-verification.md), "The daily DNS audit".
5. [#1431](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1431): stays open until 2026-11-10; close it if the Doc Vault "linear time" test is not seen failing in CI. Then
   [#1433](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1433), the same weakness in the frontend twin.
6. Visitor-session follow-ups from reviews: [#1403](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1403) and [#1400](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1400).
7. [#1346](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1346): remove the msal-node override once `@azure/identity` supports it.
8. Later (P3): [#1447](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1447), the lab pin bot silently dropping a publisher it cannot read, and
   [#1441](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1441), CI jobs that run repository code having no time limit.
9. [#1426](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1426) is the weekly lab supply-chain issue. The bot refreshes it on Tuesdays (next: 2026-11-03).
   After the lab host runs `bootstrap.sh`, the pins it lists should read "current".

Dates to remember: Monday 2026-11-02 06:00 UTC (Dependabot run, gitleaks scan); Tuesday 2026-11-03 06:45 UTC (lab supply-chain run); 2026-11-10 ([#1431](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1431)).

## Waiting on the owner

1. Delete the leftover work-in-progress branch `ci/base-update-workflow` in the Network Eyes add-on (its work is superseded by the merged
   base-image follow, and the commit is saved in a bundle). The session's own delete was refused by the safety check, so run this in PowerShell:
   `gh api -X DELETE repos/saulpatinojr/HCW-NetworkEyes_AddOn/git/refs/heads/ci/base-update-workflow`
   You should see no output; the branch then disappears from the [branch list](https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn/branches).
2. Run the lab host's `bootstrap.sh` when convenient, to apply [#1449](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1449) and [#1448](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1448):
   `ssh -t hcw-lab "sudo /opt/hcw-src/lab-host/bootstrap.sh"`
   A good run ends with a `PLAY RECAP` line for `localhost` showing `failed=0` and `unreachable=0`. Pick a quiet time: the Coder, PostgreSQL, Portainer and Vault
   containers are recreated because their images changed (this is a reading of the roles, not something that was run). Expect one extra `changed` task, the Coder helper
   install, with no restart. **Check first:** [Portainer 2.45.3](https://github.com/portainer/portainer/releases/tag/2.45.3) no longer trusts TLS certificates issued by eMudhra (emSign), so
   a registry added by hand in Portainer's web page that uses one would stop working. Nothing in this repository configures such a connection.
3. Decisions already waiting for an answer: [#1373](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1373) (the batch of owner decisions),
   [#1392](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1392) (confirm the Terraform run that creates the Doc Vault container) and
   [#1344](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1344) (publish the first interview).
4. Optional clean-up of leftovers on the PC that the session did not create or could not prove stale (nothing here is needed to continue):
   - Two test images from a Network Eyes session two days ago, about 1.4 GB: `docker rmi ne248-web:test ne248-drawio:test` (left from the work on [Network Eyes App #248](https://github.com/saulpatinojr/HCW-NetworkEyes_App/issues/248), now closed).
   - Seven safety bundles of old commits in the `.hcw` folder of your profile (`$env:USERPROFILE\.hcw\leftover-commit-bundles-2026-10-26`), about 100 KB, kept because their contents could not be checked against `main`.
     They are only backups; delete the folder once you no longer want them.

## How this file is kept

- **Dated and replaced, not appended.** Each handoff replaces this one, with the date in the title. History lives in git and in the pull requests linked above.
- **Allowed at the root on purpose.** The repository structure check ([`scripts/validate-repository-structure.ps1`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/validate-repository-structure.ps1))
  lists the only files allowed at the root, and `MEMORY.md` is on that list because of [#1450](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1450).
- **Checked for things that must not be public.** [`scripts/docs/check_redaction.py`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/docs/check_redaction.py) scans it for
  non-placeholder GUIDs (tenant, subscription and application ids) and for local file paths. The secret scan covers it like every other file.
- **Not published.** The documentation site pulls in only README, CHANGELOG and TODO, so this file is not part of the site.
- **Contents rule.** No secrets, no identifiers, no private repository names, no personal answers, and no unpublished articles.

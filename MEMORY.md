# Continuation memory

Updated: 2026-10-27, America/Chicago (CDT). This is a dated handoff, not a live
status feed or a replacement for GitHub issues. Refresh GitHub state before acting.

## Resume here

1. Read this file and `.github/CONTRIBUTING.md`; inspect applicable `AGENTS.md` files.
2. Check `git status --short`, `git branch -vv`, and `git worktree list`.
3. Fetch with pruning and fast-forward `main` before starting a new branch.
4. Check `gh pr list --state open` and recent workflow runs. Continue an existing
   PR when appropriate; put new work on a branch and merge through a reviewed PR.
5. Use GitHub issues for the backlog and `CHANGELOG.md` for completed work. The
   cleanup and this handoff are tracked in [#1450](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1450)
   and its linked PR. If that PR is still open, finish it before treating this
   handoff as the final stopping point. After merge, return to `main` and delete
   its local branch.

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

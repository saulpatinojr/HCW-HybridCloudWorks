# Working agreements

## Explanations are written for a junior administrator

Owner instruction 2026-10-21, a standing requirement for every session. The
person reading an explanation is a junior administrator: new to this estate,
without the history behind a decision, and possibly meeting the term for the
first time. An explanation that is correct but cannot be followed costs the same
round trip as a wrong one. This section is about how things are *explained*; the
next one is about how *commands* are written. Both apply at once.

- **Write the way you would talk a colleague through it at the next desk.**
  Plain, conversational sentences and short paragraphs. Say what happened and
  why it matters before the detail of how.
- **Assume no background.** Do not lean on earlier sessions, issue numbers or
  file names the reader has not met. Say in a few words what a thing is before
  relying on it: "the ruleset (the repository's merge rules)", not "the
  ruleset".
- **Avoid jargon. When a technical term cannot be avoided, explain it once,
  in a short clause, where it first appears.** "A junction (a folder that is
  really a shortcut to another folder)." Where two words are both accurate,
  use the plainer one.
- **When the owner has to act, give numbered steps.** One action per step, in
  the order they happen. Each step says what to do, gives the command from the
  next section or the exact URL, says what they should see when it worked, and
  says what to do if they see something else. A step that deletes, spends or
  cannot be undone is flagged *before* the step, not after.
- **Link the source.** Where official documentation explains the thing
  (Microsoft Learn, GitHub Docs, HashiCorp, the vendor's own page), link it,
  and link the repository's own `docs/` page, issue or PR for the history
  instead of retelling it. Use a link opened or found in search during the
  session, never one rebuilt from memory; when none can be found, say so
  rather than guess.
- **Keep the rigour; change the voice.** Plain language is not less
  information. Exact names, identifiers, command output and the line between
  "checked" and "not checked" all still go in, after the plain explanation or
  in a code block.
- **Where this applies:** everywhere in this repository. Replies, PR
  descriptions and issues, documentation, code comments, commit messages and
  replies on review threads all get the same plain wording. Length is not
  changed by this: a commit subject stays short and a code comment stays brief,
  but the words in them are ordinary ones, and a term that needs explaining is
  explained or linked.

## You run the work; the owner is the last gate, not the first

Owner instructions of 2026-10-25, repeated several times in one day, so they
are written down here instead of being asked for again. The owner is a
single person who does no GitHub administration and does not want round
trips. The session is the orchestrator of a team of agents and does the work.

- **Do every ticket you can, in order, without asking.** The owner is needed
  only for a decision that is truly theirs (money, a licence, what to say in
  their name, an outward message from them) or for an action only their own
  account can take. When a decision already has a recommendation and no one
  objects, record it on the ticket and act on it; do not ask the owner to
  "approve" something that is yours to decide.
- **A missing permission is never the reason to hand work back.** The owner
  can grant any permission. Say exactly which one is missing (the setting and
  its link), keep working on everything that does not need it, and carry on as
  soon as it is granted. The one thing you do not do is work around a refusal
  from the safety check; you ask the owner for an explicit "allow" and give
  the exact action.
- **Call out every discrepancy you notice, even when nobody asked.** Owner
  instruction 2026-10-31, given after a session pointed out that Cloud Crawler
  was the only add-on without `CORE_AUTOMERGE=true`. When one repository, file
  or setting differs from its siblings, from the documentation or from what a
  ticket says, name the difference in your message with its link, say whether
  it looks deliberate (and where that is written down) or like an oversight,
  and give the fix. Do not quietly fix it or quietly leave it.
- **GitHub administration is yours.** Rulesets, board fields and views,
  labels, issue and pull request housekeeping, variables, closing and
  reopening, merging a pull request whose checks and reviews are in order: do
  them through `gh` and the GraphQL API. Test before you ever say something
  cannot be done through the API, and show the evidence for a real limit
  (known one: GitHub has no API to create or edit a project's built-in
  workflows, so the App repositories are added to the work board by
  `C:\Users\saulp\.hcw\Sync-AppTicketsToBoard.ps1`, run hourly by the
  `HCW-board-sync` scheduled task).
  A cloud session (Claude Code on the web, claude.ai/code) has four more
  limits, because its GitHub calls go through the Claude GitHub App (the
  app installed on the owner's GitHub account for web sessions) and a
  proxy (a go-between that checks each request before it reaches GitHub),
  rather than the owner's own `gh` sign-in. The first two were seen on
  2026-11-11
  ([#1683](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1683)),
  the third on 2026-11-22 on the App's
  [`Protect main` ruleset](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_App/rules/25778324),
  and the fourth on 2026-11-23 while cutting the App's
  [v0.4.3 release](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_App/releases/tag/v0.4.3).
  - **GraphQL is refused.** GraphQL is GitHub's second API, which many `gh`
    commands use under the hood; `gh api graphql`, `gh pr view --json` and
    `gh pr list` were all refused with HTTP 403 (not allowed) "GitHub
    GraphQL is not available from Claude Code sessions". Use `gh api` with
    the REST API (GitHub's main API, the `repos/...` routes) instead. For
    jobs REST has no route for, the error names extra routes under
    `repos/{owner}/{repo}/pulls/{n}/ccr/`: `review_threads` (GET),
    `comments/{comment_id}/resolve` and `/unresolve` (POST, with a
    `comment_id` from the thread's entry in `review_threads`),
    `ready_for_review` and `convert_to_draft` (POST), and `auto_merge` (PUT
    or DELETE). These are served for cloud sessions, not by GitHub, so
    GitHub Docs does not describe them. Not yet tested from a cloud
    session: editing the work board, which is GraphQL only.
  - **Code scanning alerts cannot be read**; see "Code scanning's alerts
    are read on the pull request" below.
  - **Rulesets (a repository's merge rules) cannot be changed.** Reading
    a ruleset works, but changing one does not: on 2026-11-22 `gh api -X PUT
    repos/saulpatinojr/HCW-MigrateOrchestrator_App/rulesets/25778324` was
    refused with HTTP 403 "Write access to this GitHub API path is not
    permitted through this proxy", and the ruleset was left as it was. So
    a cloud session does not retry the call. It gives the owner the
    ruleset's link, the exact boxes and values to change, and the values to
    leave alone, then reads the ruleset back from the API to confirm the
    change once the owner says it is done.
  - **Tags cannot be pushed.** A tag is a permanent name on a commit; in
    the App and add-on repositories a `v*` tag starts the release and
    image workflows. On 2026-11-23 `git push origin v0.4.2` from a cloud
    session was refused with HTTP 403 by the proxy, and nothing reached
    GitHub. Everything before the tag still works from a cloud session:
    the version pull request, its merge, and the dry runs (`gh api -X
    POST repos/{owner}/{repo}/actions/workflows/{file}/dispatches -f
    ref=main` was accepted). So a cloud session does those, then gives
    the owner one guarded PowerShell line that fetches, refuses to tag
    unless `origin/main` is still the exact commit the dry runs passed
    on, and otherwise creates the annotated tag with the owner's GitHub
    no-reply address and pushes it. The guard matters: on 2026-11-23 the
    owner's `v0.4.2` tag landed on the dry-run commit after another pull
    request had changed `.github/workflows` on `main`, the release
    `check` job refused it, nothing was published, and since a pushed
    tag cannot be moved the release went out as `v0.4.3`.

  Sessions on the owner's own computer use the owner's `gh` sign-in and
  have none of these four cloud-session limits.
- **Use the team.** Hand each ticket, review, build and test run to the
  matching agent (see "Use the specialist agents"), brief it fully, run
  independent ones in parallel, and check what comes back yourself before you
  call it done. Agents work in their own worktrees (separate working folders
  of the same clone), and those worktrees share one `git stash` list: on
  2026-10-31 two agents stashed and popped within seconds of each other and
  each got the other's changes. So an agent never uses `git stash`; to set
  work aside it makes a temporary commit on its own branch. The session's
  scratchpad folder is shared the same way (that day one agent's pull request
  body overwrote another's `body.md`), so every file an agent writes there
  carries a name unique to its task. Every briefing says both. Other Claude sessions
  work the App repositories: message them before touching the same files,
  never duplicate their branch, and never ask one to do something your own
  permissions refused.
- **The board is the list of work.** Every open issue of the site, the four
  add-on repositories and the four App repositories is on the
  [HCW Work Board](https://github.com/users/saulpatinojr/projects/6) (the
  Ambassador outreach items stay on the private Ambassador board). Work it from
  the top: P1 now, then P2 next, then P3 later; "Gated" items wait only for the
  named gate. Close a ticket when its acceptance lines are met and say how you
  checked, linking the evidence.
- **Names follow the owner's convention.** Docker images are
  `img-<mo|ca|ne|cc>-<lab-addon|appliance-app>`, Docker OIDC connections
  `cnt-<name>`, Docker rulesets `rule-<code>-<role>`, and repositories use
  their official names (MigrateOrchestrator, NetworkEyes, CloudAssessor,
  CloudCrawler). Never "migration" or "network" as a repository name.
- **The closing summary is checked by a hook.** A Stop hook
  (`C:\Users\saulp\.hcw\check-links-hook.py`) refuses to end a turn when a
  next-steps or waiting-on-you list has a line without a link. The link goes on
  the same line as the item.

## Lines a session does not cross

Standing owner rules from earlier sessions. Until 2026-10-31 they were
scattered across those sessions' private notes and the root `MEMORY.md` handoff
file, and none of them was in this file, which is the one every session reads
first; they are collected here since
[#1455](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1455). The
section above says the session does the work; this one says the few things it
never does on its own.

- **Never print a secret, and never ask for one.** A secret is any password,
  token, key, client secret or connection string. Do not show its value in the
  terminal, a log, a commit, a pull request, an issue or chat, and do not ask
  the owner to paste one into chat; tell them which secure field to enter it
  in (a Key Vault secret, a GitHub secret's settings page) and let them do it.
- **Never put a real tenant, subscription or application id in a public file.**
  These are the long identifiers (GUIDs) that name the owner's Microsoft Entra
  directory, Azure subscriptions and app registrations. This repository is
  public, so a real one in any file, test or example is published. Use the
  placeholder `00000000-0000-0000-0000-000000000001` and the like instead. The
  redaction check
  ([`scripts/docs/check_redaction.py`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/docs/check_redaction.py))
  catches some of these in the docs and `MEMORY.md`, but not every file, so the
  rule is the session's to keep.
- **A tag that publishes an image cannot be taken back.** In a repository that
  publishes a Docker image (the four add-ons, for example), pushing a version
  tag such as `v0.1.1` starts the workflow that
  builds the Docker image and publishes it to the registry, where others can
  pull it at once. Push one only when both are true: the owner has said yes to
  that version, and a dry run (a run that builds and checks everything but
  publishes nothing) is green on the exact commit the tag will point to. In
  most add-ons that dry run is a manual run of `publish-images.yml`; its header
  comment says so, as
  [Cloud Assessor's does](https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn/blob/main/.github/workflows/publish-images.yml).
  Where the header does not say a manual run publishes nothing, do not assume
  it; ask before tagging.
- **No admin bypass and no force-push to `main`.** An admin bypass is merging
  past the repository's rules with the owner's administrator rights (for
  example `gh pr merge --admin`). A force-push rewrites history that others
  have already pulled. Every change reaches `main` through a pull request that
  meets the rules in "Pull requests open ready for review" below.
- **Never run `terraform apply` or delete an Azure resource unless the owner
  has asked for that exact change.** That includes `terraform destroy`,
  confirming a run in HCP Terraform (its confirm button is an apply), an
  `az ... delete` and a delete in the Azure portal. A plan, `terraform
  validate` and the read-only `az ... show` and `list` commands are fine.
- **Rules already written elsewhere in this file, listed here so this section
  is complete:** a refusal from the safety check is never worked around ("A
  missing permission is never the reason to hand work back", above); sessions
  merge the pull requests they open and never hand the owner a merge, with
  Dependabot's as the exception ("A Copilot
  review that recommends approval" and "CodeRabbit's approval is the merge
  signal; its request for changes is a gate", below); CodeRabbit's code-writing
  boxes are never ticked
  ("CodeRabbit's summary is a checklist to work, not to tick", below); and two
  pull requests that touch the same lines, above all `CHANGELOG.md`, go one at a
  time ("Several PRs at once, but conflicts are resolved one at a time", at the
  end). CodeRabbit is removed until further notice, so the CodeRabbit parts of
  those bullets (its approval and its boxes) are paused; the merge signal that
  replaces them is the first bullet of "Pull requests open ready for review" below.

## A new credential arrives with its register row, its test and its reminder

Owner instructions 2026-11-22. A session set up the `@claude` workflow
([#1727](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1727))
with a new one-year token and added none of the parts the admin portal
already has for keeping track of one. The token worked, but nothing in the
portal knew it existed or when it would run out; the owner noticed, not the
session. The first fix
([#1760](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1760))
then covered the register and the reminder and still missed the Keys tab and
the Services tab, and the owner had to point at those too. So this is a
checklist to go down every time, not a principle to remember.

**When it applies.** A credential is anything that signs something in: a
token, an API key, a password, a client secret, a private key or a
certificate. Go down the checklist whenever a change **adds** one, **changes**
one (a new value, a new name, a new place it is stored, a new thing that
reads it, a new expiry), or **removes** one, and whenever a change adds,
changes or removes an API or outside service the site or a workflow calls.
In an add-on or App repository the workflow change is made there, and the
checklist is a pull request in this repository opened alongside it.

**How it is recorded.** The pull request description carries the checklist as
a table: one row per place below, saying *done* (with the file), *already
correct* (checked, nothing to change) or *does not apply* (with the reason in
one sentence). A place left off the table has not been checked. If it is not
clear whether a place applies, say so and ask the owner; do not leave it out
quietly.

**The places, in the order the owner meets them in the portal**
([Admin → Integrations](https://hybridcloudworks.com/admin/integrations)):

1. **Keys tab: where the value is stored and replaced.**
   [Integrations → Keys](https://hybridcloudworks.com/admin/integrations?tab=keys)
   is where the owner pastes a new value in one step. It lists what
   [`secret-catalog.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/secret-catalog.js)
   declares, and a test holds that list to the Key Vault references in
   `infra/`, so a new row there is a Terraform change too. The owner expects
   to be able to rotate a credential here. If a credential cannot be put on
   this tab (for example it lives in GitHub, which the site cannot write to),
   say that in the table **and give the owner the shortest other way to
   rotate it**, as one command or one page; never leave the owner with a list
   of manual steps and no explanation.
2. **Services tab: the card that explains and tests it.**
   [Integrations → Services](https://hybridcloudworks.com/admin/integrations?tab=services)
   draws one card per service from
   [`serviceRegistry.jsx`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/src/components/admin/integrations/serviceRegistry.jsx).
   A card says what the service is, what it does here, which pages use it,
   which way data flows and what the key can reach, and it has a **Test**
   button. **Add to the vendor's existing card before making a new one:** a
   second credential from a vendor that already has a card goes in that card
   as its own titled box (`keyGroups`), with its own description and its own
   test, so everything from one vendor is in one place (the
   [Gen AI group](https://hybridcloudworks.com/admin/integrations?tab=services&group=gen-ai)
   holds the Anthropic card, for example). A test that needs the stored value
   runs on the server, in
   [`connection-probe.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/integrations/connection-probe.js),
   so the value never reaches a browser. Where no test is possible, the card
   says why (`untestedReason`).
3. **Overview tab.**
   [Integrations → Overview](https://hybridcloudworks.com/admin/integrations)
   is built from the same registry, so a correct card appears there by
   itself. Check that it does and that its light means what the card says.
4. **Directory tab.**
   [Integrations → Directory](https://hybridcloudworks.com/admin/integrations?tab=directory)
   explains each service to a reader, from
   [`integrationsDirectory.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/src/config/integrationsDirectory.js)
   merged with the registry. Update the vendor's existing entry (what it
   powers, its documentation link) before adding a new one.
5. **Credentials tab: the register row.**
   [Integrations → Credentials](https://hybridcloudworks.com/admin/integrations?tab=credentials)
   shows the one list of every credential the estate uses, by name only and
   never by value:
   [`register.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/credentials/register.js).
   A row says where the credential is stored, what uses it, who issues it,
   whether anything renews it and how long it lasts. A credential used in
   more than one repository under one name is one row that names them all.
6. **The reminder.** A register row with `renewal: "hand"` (only the owner
   can renew it) and a `lifetimeDays` number gets a line on the reminders
   sheet by itself. Use the issuer's real expiry where there is one, and link
   the page that states it in the comment beside the number; where the
   issuer sets none, use `HAND_ROTATION_DAYS`. Do not open an issue with a
   date in place of this: an issue does not remind anyone.
7. **The Health page.** The [Health page](https://hybridcloudworks.com/admin/health)
   probes every service that has a Test with the same function, so a card
   with a test is covered. Check that the new probe shows there.
8. **The two standards pages.**
   [`required-inputs.md`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/standards/required-inputs.md)
   (what must be set, and whether it is) and
   [`variables-and-secrets.md`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/standards/variables-and-secrets.md)
   (why a stored secret is justified here and not a keyless sign-in).
9. **The Cost page: what it costs, and the subscriptions ledger.** Every
   card has a **Cost** line saying the kind of bill in plain words: per call,
   a plan, a free allowance, or nothing (a test fails a card without one).
   Never write an amount the owner pays or guess a plan: those are the
   owner's, and they are kept on the ledger at
   [Cost → Services](https://hybridcloudworks.com/admin/cost?tab=services),
   a sheet the owner fills in by hand
   ([`cost/services.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/cost/services.js)).
   For a paid subscription, set `costOnLedger: true` on the card so it links
   the ledger, and check the vendor is among the ledger's suggestions
   (`SUGGESTED_VENDORS`): one with a Key Vault key is suggested by itself,
   and one without (a subscription only GitHub or the owner uses) is added to
   `SUGGESTED_SUBSCRIPTIONS`. Then tell the owner to add the row.
10. **The owner's own step, in the closing summary.** Say what only the owner
    can do: paste the value in the secure field, record the date it was made
    on the Credentials tab, and add the plan and price to the Cost page's
    ledger, because a session can neither read a secret nor know what the
    owner pays.

**Changing one** means going down the same list and correcting each place it
appears: a renamed secret is renamed in the catalogue, the card, the register
and both standards pages in one pull request; a new expiry changes
`lifetimeDays`.

**Removing one** means taking it out of every place above in the same pull
request, and telling the owner to revoke the old value at the issuer (with
the link), because deleting our copy does not switch the credential off. The
register's reminder row goes away by itself once the row is gone.

**Where the value is stored is a decision, and it is written in the register
row.** A value the *site's own code* reads goes in Key Vault through the Keys
tab. A value only a workflow reads is a GitHub Actions secret; putting a copy
in Key Vault that nothing reads makes an orphan, so that is done only when
the site is also given a use for it (a test, or passing it on), and the pull
request says which.

**Not every place fits every key, and that is said, not hidden.** Owner
instruction 2026-11-22. Some keys can be tested and cost nothing; some cost
money and cannot be tested; some have neither. For each key, the card says
which of these it has, in plain words: how it is **tested** (or that it
cannot be, and what to do instead), what it **costs** (a bill per call, a
subscription's limits, or nothing), how it is **replaced**, and when it
**expires**. A line that does not apply says so; it is not left out.

**Never add exposure to make a tab work.** A key that only GitHub reads stays
only in GitHub. Do not copy it into Key Vault, and do not give the site a way
to write GitHub's secrets, just so the Keys tab or a Test button has
something to do. List it instead: its box on the vendor's card says where it
is stored, gives the one line that replaces it, and links where to check it
(the Claude Code box on the Anthropic card is the example,
[`ClaudeCodeNote.jsx`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/src/components/admin/integrations/ClaudeCodeNote.jsx)).
Giving the site a new power over another system is the owner's decision,
asked for on its own, never a side effect of adding a key.

The same habit applies beyond credentials. Before calling a feature done, ask
what the admin portal already has for that kind of thing (a register, a
health probe, a reminder, a settings page, a directory entry) and add the new
thing to each, in the same pull request.

## Everything named to the owner carries its link

Owner instruction 2026-10-25, given after being told to decide "the copyleft
policy" with no link and spending five minutes looking for it. The owner has
asked for links more than once, so this is a step to follow every time, not
something to remember.

- **Every message to the owner links each item it names that the owner might
  have to find, open, decide or change, in the same sentence that names it.**
  That covers an issue, a pull request, a workflow run, an alert, a review
  thread, a settings page, a dashboard, a document, a file in the repository
  and an open decision. Link it again in the next message even if an earlier
  message already did: each message is read on its own, often from a phone.
  Not "the copyleft policy is still open" but "the copyleft policy (item 2 on
  [#1367](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1367)) is
  still open".
- **This is different from "Link the source" above.** That rule links
  documentation that explains a thing. This one links the thing itself, the
  place the owner has to go. For a settings page it is the same URL the
  browser rule in the next section asks for; keep the two in step.
- **For a file in the repository, link it on the branch where it exists
  today, and say which branch that is.** A link to `main` fails for a file that
  only exists on an unmerged branch.
- **Where no link exists, say so and give the nearest one.** If the vendor
  publishes no page for a setting, say that in one clause, link the closest
  page that was found in the session, and give the clicks from there. The rule
  about links found rather than rebuilt from memory, in "Link the source",
  still applies.
- **Check before sending.** Read the whole message once. For every item it
  names (an issue, pull request, workflow run, alert, review thread, settings
  page, dashboard, document, file or open decision), check that its link is in
  the same sentence, and add any that are missing. Do this for the closing
  summary (completed, my next steps, your next steps) first, because that is
  where the owner acts.

## Use the specialist agents

Owner instruction 2026-10-25: the specialist agents were not being used as
much as they should be.

- **Before opening a pull request, and whenever asked to review or audit
  something, hand it to the matching agent below, then act on what comes
  back.** Do the same for design and build work in these areas.
  - Docker images, the Dockerfiles and GitHub Actions workflows (the
    repository's automated jobs) that build them, and the software and base
    images an image is built from: `docker-senior-engineer`,
    `container-security-reviewer` (review only), `container-build-verifier`
    (runs the builds and checks).
  - GitHub Actions workflows, rulesets (the repository's merge rules), branch
    rules and Actions security: `github-expert-engineer`.
  - Terraform: `terraform-expert-engineer`.
  - Documentation and runbooks: `cloud-documentation-archivist`.
  - A branch or pull request before it is opened: `infrastructure-pr-reviewer`
    for Terraform, workflow and deployment-script changes; `cloud-prepress-reviewer`
    for an application or Azure change that needs an evidence check before a
    pull request or deployment.
  - **When two agents match, the one whose area most of the change is in takes
    the lead; add a second only when the change really spans two areas.** A
    Dockerfile change goes to `docker-senior-engineer`; a change to the
    workflow that builds it also goes to `github-expert-engineer` for the
    workflow's security. The agent that reviews a branch before the pull request
    is opened is the one for its main area, plus `infrastructure-pr-reviewer`
    when the change is workflow or deployment code.
- **The per-folder points a pre-PR review must check** (#1575). They were
  CodeRabbit's review notes until it was removed on 2026-11-06 (#1574). Where
  a test or CI check already fails on a violation, it is named and the
  reviewer need not repeat it; the rest no test can read, so the reviewer
  agent is told to check them by name in its briefing, for every changed
  file under that folder:
  - `functions/**` (test and reviewer): log lines are content-free (no
    document ids, tokens, file paths, route values or payloads). Two tests
    hold part of that: `no-raw-error-in-logs.test.js` (an error's own text)
    and `no-ids-in-logs.test.js` (a value named like an id, a person or the
    place a stored thing lives, and a whole value printed with
    `JSON.stringify`). The second reads names, so the reviewer still checks
    what a name does not say: an id held under a plain name (`key`, `name`),
    a route value, and a sentence that quotes text the far end chose. Owner
    decision 2026-11-24
    ([#1802](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1802)):
    a job's id is not logged (the invocation id, the reference number the
    host adds to every line, ties a line to its run), nor is a chat number,
    a refused request's path or a remote server's `Content-Type`; a fixed or
    registered name may be (a provider, a backup run's date, a registered
    tool server), and each line that keeps one is listed with its reason in
    that test's `ALLOWED` list. A write decided from an
    earlier read is guarded with `ifMatch` and handles the 412; an update
    built from request input carries no `undefined` value (`patchDoc` deletes
    the field) and no dotted key (a nested Cosmos patch). Raw errors in
    responses are a test: `no-raw-error-leaks.test.js`.
  - `infra/**` (test and reviewer): replacing or destroying a stateful
    resource is stopped by `prevent_destroy` on Cosmos, Storage, Key Vault and
    the core resources, and the plan is read by `assert-expected-plan` in
    `tfc-plan-check.yml`; the reviewer checks that no change puts a secret
    value into state.
  - `lab-host/ansible/**` (CI and reviewer): repeatable tasks are
    `ansible-lint --profile production` in `ci.yml`; the reviewer checks that
    `ansible_managed` appears only in a template, never in a copy task's
    content, and that a task that is not repeatable says why in a comment.
  - `frontend/src/pages/**` (test): public pages naming a vendor, tool, model
    or admin-side state fail `frontend/src/public-copy.test.js`; admin pages
    are exempt.
  - `docs/**` (reviewer): a command for the owner follows "Owner-facing
    instructions must be runnable" below (PowerShell unless the line above
    says bash, one line, no placeholder, exact URLs). The redaction gate
    covers ids and secrets, not this.
  Workflows and Dockerfiles are linted in CI by actionlint, zizmor and
  hadolint, with the same pinned versions everywhere: here by the
  `actionlint, zizmor, hadolint` job, which `gate` waits for, and in the four
  add-ons by steps at the end of each one's required `lint` job (`build-test`
  in MigrateOrchestrator).
- **For Microsoft and Azure facts, look them up with the Microsoft Learn
  documentation tools (`microsoft_docs_search`, `microsoft_docs_fetch`) before
  answering from memory, and link the page used.** If those tools are not
  available in the session, search and fetch the page on learn.microsoft.com
  with the web tools instead, link what was opened, and say that the Learn
  tools were not available.
- **Brief an agent as you would brief a colleague who has just walked in.** It
  starts with no context: give the goal, what has been ruled out, the files and
  links that matter, and ask for findings with a file and line for each, the
  commands it ran, and anything it could not check. Never put a token, key or
  password in the briefing; say where it is kept instead.
- **In the closing summary, say which agent was used and what it found.**
  The only work done without an agent is a change that touches none of the
  areas above, or a purely cosmetic edit with no change in behaviour (a typo, a
  wording tweak, a corrected link); say so in one line.

## Pre-publish content never goes in this public repository

Owner rule 2026-10-25. This repository is public, and the documentation site
([docs.hybridcloudworks.com](https://docs.hybridcloudworks.com/)) is built from
its `docs/` folder, so anything committed there is readable by everyone as soon
as it merges, long before the owner decides to publish it. An article that is
not finished is the owner's content, and it stays private until the owner
publishes it.

- **Drafts live in two places only: the owner's private vault, in its `Drafts`
  folder, and the admin
  [Drafts page](https://hybridcloudworks.com/admin/drafts)** (the editing
  screen on the live site, behind sign-in). The vault is a folder of notes on
  the owner's own computer, outside this repository, so there is nothing to
  link to for it; the steps to get a draft from the vault to the Drafts page
  are in the
  [idea notes runbook](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/obsidian-idea-notes.md).
- **Never commit a draft article, and never open a pull request to hold one.**
  That means no `docs/content/blog-*.md` file other than the two contract files,
  [`blog-template.md`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/content/blog-template.md)
  and
  [`blog-machine.md`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/content/blog-machine.md)
  (they describe how articles are written and contain no article text). If a
  test needs a sample article, write a made-up one into the functions tests'
  [`__fixtures__` folder](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/functions/src/lib/cms/__fixtures__)
  instead.
- **The promote script refuses repository paths on purpose.**
  [`scripts/ideas/promote-idea.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/ideas/promote-idea.mjs)
  writes a ready idea into the vault's `Drafts` folder and stops with an error
  if that folder is inside this repository, however the path is spelled. Do
  not work around the refusal; fix the vault path instead.
- **A test enforces this.**
  [`docs-content-guard.test.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/test/docs-content-guard.test.js)
  fails the `functions (azure)` check (the automated job that runs the
  functions tests, listed on every pull request) on any pull request that adds a
  `blog-*.md` file to `docs/content` besides the two contract files, and its
  message says where drafts go instead. It exists because the drafts were
  removed in [#1381](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1381)
  and should not drift back. If it fails on your change, move the file to the
  vault; do not add the name to the test's allowed list.

## Owner-facing instructions must be runnable, not descriptive

When telling the owner what to do next, give **commands they can paste**, not a
description of the goal. Specifically:

- **PowerShell by default.** The owner works at a `PS C:\Users\<you>\...`
  prompt. Write PowerShell: `$x = ...` assignment, no `$(...)` command
  substitution, no backtick line continuations pasted into anything but
  PowerShell.
- **If a command must be bash, say so on the line above it.** The owner also has
  Git Bash (`MINGW64`) open and switches between them. Two commands were lost on
  2026-08-30 to bash syntax pasted at a PowerShell prompt and to PowerShell
  backticks pasted into bash — both because the shell was assumed rather than
  stated.
- **Prefer one line.** A multi-line command is a continuation-character bug
  waiting to happen across two shells. Where a value must carry between
  commands, compute it rather than asking the owner to retype it.
- **Never leave a placeholder in a line meant to be pasted.** Not
  `THEACCOUNTNAME`, not `<your-id>`, not `THE_ADDRESS`. The rule is about
  commands, not about prose: naming a shape in a sentence — the
  `PS C:\Users\<you>\...` prompt above, or the `rg-<tier>-site-prod-cus`
  resource-group convention — describes the estate and is fine. A command is
  different, because it gets pasted exactly as written.

  Every name a command needs here is already known. `infra/variables.tf`
  carries the defaults — `stsiteprodcus01`, `func-site-prod-cus-01`,
  `kv-site-prod-cus-01` — and the resource groups in use are
  `rg-stor-site-prod-cus` (storage), `rg-web-site-prod-cus` (function app),
  `rg-sec-site-prod-cus` (Key Vault) and `rg-mgmt-plat-prod-cus` (Log
  Analytics and the action group, in the Management subscription). Look the
  value up and write it in.

  Twice on 2026-08-30 a placeholder shipped and was pasted verbatim:
  `THE_ADDRESS` produced `EmailAddressIsNotValid`, and `THEACCOUNTNAME`
  produced a DNS failure on `theaccountname.blob.core.windows.net`. Both cost
  a round trip, and in neither case did the error describe the thing being
  tested.
- **Prefer the control-plane `az` verb when one exists.** These two read the
  same container, and only the first works on Reader alone:

  ```powershell
  az storage container-rm show --storage-account stsiteprodcus01 -g rg-stor-site-prod-cus -n listenandlearn -o json | ConvertFrom-Json | Select-Object name, publicAccess
  ```

  ```powershell
  az storage container show --name listenandlearn --account-name stsiteprodcus01 --auth-mode login -o json | ConvertFrom-Json | Select-Object name
  ```

  The second is data-plane. It needs a Storage Blob Data role, and it resolves
  `stsiteprodcus01.blob.core.windows.net` — so a wrong account name fails at
  name resolution with `getaddrinfo failed`, before auth or the container is
  ever reached. That is how the `THEACCOUNTNAME` paste above disguised itself
  as a broken container.
- **If a command reads a repository file, say which branch it is on.** A
  command like `az role definition create --role-definition
  '@infra/roles/x.json'` works only if that file exists in the owner's working
  tree. When the file was added on an unmerged branch and the owner is on
  `main`, it does not — and `az` reports **`Failed to parse string as JSON`**
  naming the path, because a value that is neither valid JSON nor an existing
  file falls through to the JSON parser. The error describes the wrong subject
  entirely, which is the expensive kind.

  So pair any such command with the checkout that makes it runnable, or with a
  one-line existence check the owner can read before believing the error:

  ```powershell
  Test-Path infra/roles/static-web-app-deployer.json
  ```

  Cost two round trips on 2026-08-30. The first correction blamed PowerShell's
  splatting operator and prescribed single quotes; quoting was not the problem
  and the quoted form failed identically. Recorded that way because a
  confidently wrong rule in this file is worse than no rule.
- **Avoid `az --query` with brackets.** `[0]` and `[?...]` get re-parsed and
  fail with `] was unexpected at this time`. Use `-o json | ConvertFrom-Json`
  and filter in PowerShell.
- **Anything done in a browser needs the exact URL**, deep-linked to the page
  holding the setting — not "go to Settings and find X".

State what a successful result looks like, so the owner can tell a real failure
from a reporting failure without asking. That distinction has been the expensive
one: on 2026-08-30 the Azure portal reported a test as failed while the email
arrived, and a timer script reported 57,581 invocations where the query returned
two rows.

## Pull requests open ready for review, not as drafts

Owner decision 2026-09-05. Every PR opened from a session was arriving as a
draft, and the owner had to flip each one to ready for review before merging
— a round trip that from a phone is the whole cost of the PR. GitHub has no
repository setting that forces this; it is chosen by whoever creates the PR,
so it is recorded here, where every session reads it.

- **CodeRabbit is removed until further notice (owner instruction
  2026-11-06).** CodeRabbit is the review bot that used to read every pull
  request. Do not comment `@coderabbitai`, do not wait for a CodeRabbit
  review, and do not treat its approval as the merge signal.
  `.coderabbit.yaml` (its settings file) is deleted in every HCW repository
  that had one, and suspending the CodeRabbit GitHub App is the owner's step
  ([installed apps](https://github.com/settings/installations)). The merge
  signal is now: every required status check green on a head that is up to
  date with `main`, every review conversation answered and resolved, and the
  pre-PR specialist agent review (see "Use the specialist agents") done and
  its findings worked. Where a bullet below names CodeRabbit, only the
  CodeRabbit parts are paused until the owner restores it; the rest of each
  bullet still applies, including the pull request template, Copilot's
  findings worked on their threads within three rounds, and the code scanning
  check on the pull request and on `main` after a merge. Dependabot's pull requests still go to the
  owner: when one is green, tell the owner with its link, and do not merge it
  on a session's own judgement. A CodeRabbit request for changes left
  standing on an open pull request still blocks its merge and no new
  CodeRabbit review will replace it, so the owner dismisses it (the review's
  **⋯** menu, **Dismiss review**); a session gives the owner the link and does
  not dismiss it. Restoring means bringing back `.coderabbit.yaml` from git
  history (the
  [last version](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/0951d574373fcfe0be973a7e51c0d71e0eb585b9/.coderabbit.yaml)),
  its line in the allowed root files of
  [`scripts/validate-repository-structure.ps1`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/validate-repository-structure.ps1),
  and the App installation.
- **Create the PR ready for review.** Copilot reviews either state, CI runs
  on either state, and nothing in this repository keys on draft.
- **The PR title is one line, at most about 72 characters, in the shape
  `<area>: <what changed> (#<issue>)`.** Owner instruction 2026-11-04. The
  title is what the squash merge writes as the commit's subject (the body
  is dropped), and it is the name HCP Terraform gives the run that commit
  starts, so a long or multi-line title reaches `git log` and the Terraform
  run list as it is. `CI: one gate check, path-skipped jobs, coverage folded
  in (#1545)` is the shape; a sentence that explains the change belongs in
  the description.
- **Draft is the exception, and it is stated.** If a PR is opened before its
  own checks have been run locally, or it exists to hold a question rather
  than a change, say so in the first line of the description and open it as
  a draft. Otherwise not.
- **The description follows `.github/pull_request_template.md`.** Owner
  instruction 2026-10-08, through CodeRabbit's Description check, which
  warns on a body that skips the template's sections. Keep each section —
  Summary, Related issue or decision, Type of change, Scope and impact,
  Verification, Security and data review, Documentation and operations,
  Author checklist — and tick only the boxes that are true. Drop
  "Infrastructure changes only" when no infrastructure changed, as the
  template itself says.
- **Check for a waiting review before reporting a PR as finished, and again
  whenever the session next touches it.** Owner instruction 2026-09-10, after
  a session opened a PR, watched CI go green, reported it done, and stopped —
  while a Copilot review carrying two security findings sat on it unread. CI
  passing is not the end of a PR; the review is. Green checks and an unread
  review look identical from the outside, which is why this is a step rather
  than a habit.

  The verdict and the inline findings live in two different places and a
  session needs both — the review body carries the verdict, and the line
  comments carry what to actually fix. CodeRabbit's checklist and code
  scanning's alerts live in two more. **The lines below are bash (Git
  Bash), not PowerShell** — the same rule as the top of this file, which
  applies to a session's own commands as much as to the owner's. In a cloud
  session the first two lines are refused, because `gh pr view` uses
  GraphQL (see "GitHub administration is yours"); get the number with
  `gh api "repos/saulpatinojr/HCW-HybridCloudWorks/pulls?head=saulpatinojr:$(git branch --show-current)&state=open" --jq '.[0].number'`
  and the head with `git rev-parse HEAD`. The other lines are REST and
  work, except code scanning's (see its bullet below):

  ```bash
  PR=$(gh pr view --json number -q .number)
  gh pr view "$PR" --json headRefOid -q .headRefOid
  gh api repos/saulpatinojr/HCW-HybridCloudWorks/pulls/"$PR"/reviews --paginate --jq '.[] | select(.user.login=="copilot-pull-request-reviewer[bot]") | "\(.commit_id[0:8]) \(.state) \((.body // "") | split("\n")[0])"'
  gh api repos/saulpatinojr/HCW-HybridCloudWorks/pulls/"$PR"/comments --paginate --jq '.[] | "\(.path):line \(.line // .original_line // "unknown")\n\(.body)\n"'
  gh api "repos/saulpatinojr/HCW-HybridCloudWorks/issues/$PR/comments?per_page=100" --paginate --jq '.[] | select(.user.login=="coderabbitai[bot]") | .body' | grep -E 'up to `|Actionable comments posted|Retained concerns|_proposed_|Failed checks|^- \*\*(Critical|High|Medium|Low) ·'
  gh api "repos/saulpatinojr/HCW-HybridCloudWorks/code-scanning/alerts?ref=refs/heads/main&state=open&per_page=100" --paginate --jq '.[] | "#\(.number) \(.rule.id) \(.rule.severity) \(.most_recent_instance.location.path):\(.most_recent_instance.location.start_line)"'
  ```

  Every detail in those lines is a mistake someone has already made. Stated
  without a count on purpose: this file learned from T-722 that a number
  above a list drifts the moment the list grows, and this very sentence said
  "three" over four bullets until review caught it.

  - **The reviews line prints the commit a review judged**, and the line
    above prints the head, because only a review of the head is the merge
    signal below. A review looks the same whether it read the current code
    or three pushes ago, and the sha is the only thing that says which.
  - **`--paginate`, because `gh api` stops at thirty.** A PR with more
    review comments than that silently returns a prefix, and a section whose
    whole point is finding every outstanding item cannot end at an arbitrary
    cut. The same default truncated a board listing to its first thirty rows
    on 2026-09-10 and made four open issues look absent.
  - **A comment on an outdated line still knows where it was.** `.line` goes
    null once the code beneath a comment has moved, but `.original_line`
    survives, so falling back to it keeps a finding locatable instead of
    printing a shrug. Only a comment with neither is genuinely unplaced.
  - **The bot login differs between the two APIs.** REST spells it
    `copilot-pull-request-reviewer[bot]`; `gh pr view --json reviews` spells
    the same actor `copilot-pull-request-reviewer`, with no suffix. A filter
    written for one and run against the other matches nothing and reads
    exactly like "no reviews yet".
  - **CodeRabbit's checklist is an issue comment, not a review**, edited in
    place each round, so its line reads the issue comments and keeps the
    lines that name work. Its `up to` line names the commit that round
    judged, the same question the reviews line answers for Copilot. While
    it reads `Currently processing new changes`, the next round is coming.
  - **Code scanning's alerts are read on the pull request before the merge,
    and on `main` after it.** Owner decision 2026-11-24
    ([#1545](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1545)):
    CodeQL runs on pull requests again, as well as on pushes to `main` and
    weekly. On a pull request each of the three `Analyze` jobs looks at the
    changed files first and skips its analysis when none is in its language,
    so a green `Analyze` job is either "analysed" or "skipped"; its log says
    which. It is not a required check, so nothing here greys out the merge
    button. Before merging, read the three `Analyze` jobs of the CodeQL run
    on the head (all green, none failed or cancelled) and code scanning's
    review comments, which arrive with the other line comments in the
    comments line above (author `github-advanced-security[bot]`), and work
    each one like any other thread. To read the alerts list for the pull
    request, the line takes `ref=refs/pull/<n>/merge` in place of
    `ref=refs/heads/main`. After the merge the line is run on `main` as
    written, once the merge's push run has finished (about four
    minutes) with all three `Analyze` jobs green: a failed or cancelled
    analysis uploads nothing, and the workflow cancels an in-progress run
    when the next push lands, so a run that did not succeed is not "no new
    alerts". Rerun it, or wait for a later `main` run that contains the
    merge, before reading the list. A new alert is the merging session's
    follow-up. The query goes in the URL: `-f state=open` beside `--paginate`
    silently returned nothing for Dependabot alerts on 2026-09-29, while
    three were open. **A cloud session cannot read the list.** The alerts
    and analyses routes answer HTTP 403 "Resource not accessible by
    integration"; a push to `main` gets no `CodeQL` check (the pass/fail
    line on the commit) to read instead; and the CodeQL run saves no
    artifact (a file a run keeps for download), so its results cannot be
    fetched either
    ([#1683](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1683)).
    On a pull request a cloud session can read the `Analyze` jobs (the
    check runs of the head commit) and the review comments, and that is
    its check before the merge. After the merge, in a cloud session, check
    that the three `Analyze` jobs of the CodeQL
    run on the merge commit are green, then put a line in the closing
    summary's "your next steps" that links the
    [code scanning page](https://github.com/saulpatinojr/HCW-HybridCloudWorks/security/code-scanning)
    and gives the merge time, so the owner can spot an alert newer than
    the merge. Do not keep retrying the call. An alert the owner then
    reports is still the merging session's follow-up, or the next
    session's.

  Then work the loop: fix every recommendation, push, reply on each thread
  naming the commit, resolve it, and ask for another review of the new head.
  Repeat until the review of the current head recommends approval, which is
  the merge signal below. A finding judged wrong is answered on its thread
  with the reason rather than silently skipped — disagreeing is allowed,
  ignoring is not.

  **Copilot is one teammate wearing two hats, and `@copilot review` can bring
  back either.** It reviews as `copilot-pull-request-reviewer` and it commits
  as `copilot-swe-agent`, and a request for a review may come back as a
  review, as a fix pushed straight to the branch, or as both. That is the
  service working, not a surprise to be audited.

  Owner instruction 2026-09-10, after a session described two perfectly good
  commits from the agent as "not asked for" and made a small ceremony of
  vetting them:

  - **When the agent fixes the finding, that is the finding closed.** Take it
    as the only thing that was wrong, reply on the thread acknowledging the
    fix and naming its commit, resolve, and treat the change as the precursor
    to a green head. The acknowledgement is that reply and the resolve —
    there is no commit to make for it, since the agent's own push is already
    the change. Once it is posted and the review of that head recommends
    approval, merge. Do not re-derive the fix, re-review it line by line, or
    hold the PR open to prove it was read.
  - **When the fix does not actually close the finding, say so and correct
    it.** Push the correction, explain on the thread what was still open, and
    ask for another review. That is the same loop as any other round.
  - **Disagreement is welcome; suspicion is not.** A finding judged wrong, or
    a fix judged incomplete, gets a reason on the thread and a counter-
    proposal. What it does not get is silence, or a reply that reads as
    guarding the branch against a colleague.

  A plain push also triggers a fresh review on its own, so the comment is
  rarely needed to get one.
- **A Copilot review that recommends approval is the owner's "merge".** Owner
  decision 2026-09-05: Copilot code review has authority to approve PRs in
  this repository, so when its review of the **current head** recommends
  approval, a session merges without waiting for the owner to say so —
  provided every status check the repository ruleset requires is green on
  that head and no review thread is unresolved. Read the verdict, not the
  wording: Copilot's approval line has changed before (in this repository it
  has read `This pull request is ready to be approved.`), so key on a review
  that recommends approval, never on an exact string. A review that
  recommends changes, or any review thread still unresolved on the head, is
  not that: fix, push, and wait for the next review of the new head. Ready
  for review on its own is still not permission to merge.
- **CodeRabbit's approval is the merge signal; its request for changes is a
  gate.** The ruleset (the
  repository's merge rules for `main`, the `Default` ruleset, id 20680114,
  [settings page](https://github.com/saulpatinojr/HCW-HybridCloudWorks/rules/20680114))
  does not require any approving review. Read from the API on 2026-10-31 with
  `gh api repos/saulpatinojr/HCW-HybridCloudWorks/rulesets/20680114` (the
  ruleset was last changed 2026-10-20 09:05 UTC), its `pull_request` rule has
  `required_approving_review_count: 0` and `require_last_push_approval:
  false`. What it does require is every review conversation resolved
  (`required_review_thread_resolution: true`), the required status checks
  green on a head that is up to date with `main` (`required_status_checks`,
  strict), and no deleting or force-pushing `main` (`deletion`,
  `non_fast_forward`); it also dismisses an old approval when new commits are
  pushed, and no one is on its bypass list. GitHub explains each of these
  settings on
  [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

  **The required checks are five**, since the owner applied the ruleset on
  2026-11-04 for
  [#1545](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1545)
  (read back from the API that day, `updated_at` 14:11 UTC): `gate` (the
  last job of `ci.yml`, which waits for every other CI job and fails if any
  failed), `Validate root and documentation policy`, `dependency-review`,
  `fmt, validate, tflint` and `Trivy IaC misconfiguration scan`. The three
  CodeQL `Analyze …` contexts and the ten single CI job names left the list.
  CodeQL runs on pull requests again since the owner's decision of
  2026-11-24, as well as on pushes to `main` and weekly, and its contexts
  stay off the list.
  The payload, the `gh api` line that applied it and the read-back are in the
  [required checks runbook](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/required-checks.md);
  `scripts/ruleset-contexts.test.mjs` holds the list.

  So no approval is needed, but **a review that asks for changes still blocks
  the merge** until a newer review from the same reviewer replaces it, even
  after every thread is resolved and the commit it judged is long gone. Seen
  on [#1460](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1460)
  on 2026-10-31: CodeRabbit's request for changes on `baf10df` was still
  standing three pushes later, and the merge API refused with `1 review
  requesting changes by reviewers with write access` (HTTP 405). When that
  happens, comment `@coderabbitai review` so it reviews the current head.
  A fresh review does not always replace the old one: on #1460 CodeRabbit
  withdrew its request on the thread and its next review found nothing, yet
  it posted no approval, and it refuses `@coderabbitai resolve` and
  `@coderabbitai approve` from the pull request's author. Then the owner
  dismisses the old review (its **⋯** menu, **Dismiss review**), with a link
  to where CodeRabbit withdrew it. A session does not dismiss a review to get
  past it.
  [`.coderabbit.yaml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.coderabbit.yaml)
  still has `request_changes_workflow: true` and `allow_author_approval:
  false`: CodeRabbit posts a review asking for changes while any of its
  findings is open, and approves the head once every thread is resolved and
  its pre-merge checks pass. That approval of the **current head** is the
  signal to merge, read the same way as Copilot's verdict above, and the round
  cap in the next bullet still applies. Since 2026-11-01 the review that
  carries it is asked for, not automatic (`auto_review.enabled: false`,
  [#1487](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1487);
  how to ask is in "Each bot's first review is waited for" below). Sessions
  merge the pull requests they open on it; never hand the owner a merge. **Dependabot's pull requests are
  the exception:** `.coderabbit.yaml` lists `dependabot[bot]` under
  `ignore_usernames`, so CodeRabbit never reviews them and no CodeRabbit
  approval will arrive, and its comment says the owner approves them (no
  runbook describes that step further). Do not wait for CodeRabbit on one,
  and do not merge one on a session's own judgement; tell the owner it is
  ready, with its link. Two separate controls stop a session approving its
  own work. GitHub does not let the author of a pull request approve it, and
  a session authors as the owner's account. Separately, `.coderabbit.yaml`'s
  `allow_author_approval: false` makes CodeRabbit ignore `@coderabbitai
  approve` from the author, so the author cannot have the bot approve
  instead.

  History, briefly: on 2026-10-18 the owner chose option F on
  [#972](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/972),
  which set the count to 1 with last-push approval so that CodeRabbit's
  approval was a required gate (proven on
  [#1272](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1272)).
  By the ruleset's change of 2026-10-20 both settings were back at `0` and
  `false`; no record of why was found in the repository when this was written.
  Making the approval a gate again is the owner's decision, to be recorded on
  [#1455](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1455),
  and the ruleset change is the owner's to make. A session that finds the
  count above 0 again reads it from the API and updates this bullet.
- **Every review bot is worked, for at most three rounds each; then all
  green is the merge.** Owner instruction 2026-10-08, after Copilot reviews
  resumed on #1034 and #1035 and CodeRabbit (#1031) began posting a
  checklist with each review. It replaces the 2026-10-03 bullet that turned
  Copilot review off and capped it at two rounds once it returned.

  - **Two reviewers on the pull request, none optional, and code scanning
    beside them.** Copilot (`copilot-pull-request-reviewer`) and
    CodeRabbit (`coderabbitai`) review a PR. Every finding from each is
    fixed, or answered on its thread with the reason, and the thread
    resolved, as the bullets above and below say. A finding is not optional
    because its bot is not a required check. Code scanning
    (`github-advanced-security`, posting CodeQL's alerts) reviews pull
    requests too. Owner decision 2026-11-24: CodeQL runs on pull requests
    again, for the languages the pull request touched, as well as on each
    push to `main` and weekly
    ([#1545](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1545),
    trade-off in the required checks runbook; it was off pull requests from
    2026-11-04 until then). An alert a change introduces is posted as a
    review comment on the pull request and is worked there before the
    merge. The run on `main` after the merge is still read, because it
    analyses every language and a skipped language was not analysed on the
    pull request: an alert that appears on
    [code scanning](https://github.com/saulpatinojr/HCW-HybridCloudWorks/security/code-scanning)
    after the merge is fixed by the session that merged, in a follow-up (a
    cloud session cannot look at that page's list, so it hands the owner
    the page instead; see "Code scanning's alerts are read on the pull
    request").
  - **Each bot's first review is waited for, and CodeRabbit's is asked
    for.** A PR is not merge-ready until Copilot and CodeRabbit have each
    reviewed it once.
    Copilot reviews on its own. CodeRabbit does not, since the owner's
    decision of 2026-11-01
    ([#1487](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1487)):
    `.coderabbit.yaml` has `auto_review.enabled: false`, because on the free
    plan every push and every "Update branch" spent one of the five included
    reviews an hour, and on 2026-11-01 three pull requests used the hour
    between them while #1485 waited for the review that would lift a stale
    request for changes. Now a push or an "Update branch" starts no review
    and spends nothing; only the ask does. So once the required checks are
    green on the head you want read, comment `@coderabbitai review` (the
    whole comment is the command). "Review rate limited" in its reply means
    the hour's allowance is spent and no review happened: wait for the
    minute it names, then ask again for the same head. Once a head has been
    reviewed, ask again only for a head that changed. If a bot's first review has not
    arrived an hour after it was due (Copilot: after the required checks
    went green; CodeRabbit: after the first ask that was not rate limited,
    since a rate-limited ask starts no review), say so on the PR, naming the
    bot, and treat it as unavailable for that PR: reviews stopped arriving
    altogether once before (2026-10-03), and a PR does not wait on a
    reviewer that is not coming.
  - **At most three rounds per bot.** A round is one review of a head by one
    bot, and the fixes pushed in answer to it. Work the loop above for a
    bot's first three reviews; after the third round's fixes are pushed,
    merge once required checks are green and every thread is replied to and
    resolved. Do not request, or wait for, a fourth review. The cap
    overrides the approval bullet above: before the cap, a review that
    recommends changes still means fix, push and wait for the next review;
    once the third round's fixes are pushed, the final head needs no review
    recommending approval. A review that does arrive on the final head still
    has its findings answered on their threads before the merge. #835 and
    #836 ran three and four Copilot rounds; the owner put a loop at "more
    than 3 turns".
  - **CodeRabbit's summary is a checklist to work, not to tick.** Its
    walkthrough comment is not a review thread, so nothing blocks the merge
    on it, which is what makes it easy to miss. It carries actionable
    comments, the Merge Risk section's **Retained concerns** and hardening
    proposals (its `_proposed_` lines), and the **Failed checks** among its
    pre-merge checks. On #1035 a medium security concern lived there and in
    no thread. Work every item, then post one PR comment with a table of
    each item and what was done: the commit that fixed it, or the reason it
    was not done. Then comment `@coderabbitai run pre-merge checks`. The
    checkboxes are triggers, not records of work: **Commit to this branch**,
    **Create a new PR** and **Fix all pre-merge checks with AI** make
    CodeRabbit write and push code, and **Autopilot** makes it keep pushing
    past the round cap. Do the work by hand, to the file's own style, and
    leave them unticked; never tick Autopilot.
  - **A code scanning alert is fixed in code, or dismissed by the owner.**
    Its thread closes on the next analysis once the code is fixed. An alert
    that is right but intended (a test that makes a file world-readable to
    prove the helper refuses it, alert 398 on #1035) is neither rewritten to
    slip past the query nor dismissed by a session: a session's dismissal is
    refused as a CI bypass. Give the owner the alert's page, under
    `https://github.com/saulpatinojr/HCW-HybridCloudWorks/security/code-scanning/`,
    and the reason to choose (**Used in tests**, **False positive** or
    **Won't fix**); their dismissal closes the thread. What GitHub enforces
    and what this file adds differ here. Neither the `CodeQL` check nor the
    `Analyze …` jobs are required checks since 2026-11-04, so a red one
    does not block the merge button. Since the owner's decision of
    2026-11-24 CodeQL runs on pull requests again, so code scanning posts
    each alert as a review comment once more, and the ruleset's
    conversation resolution blocks on that thread until the alert is fixed
    or dismissed (as alert 398's did on #1035 until the dismissal closed
    it). What this file adds: a red `CodeQL` or `Analyze …` check on a pull
    request is read and worked before the merge even though GitHub would
    allow the merge, and an alert found on `main` after a merge is the
    merging session's to fix in a follow-up pull request, or to hand to the
    owner with its page and the reason to choose.

  The `copilot_code_review` rule is still absent from the `Default` ruleset
  (20680114). Its parameters were `review_on_push: true` and
  `review_draft_pull_requests: true`, should the owner want it back.
- **Every review conversation is resolved before the merge, including the
  ones that ask for nothing.** Owner instruction 2026-09-06, after a merge
  was blocked with `A conversation must be resolved before this pull request
  can be merged` on a thread that was a validation note rather than a change
  request. The repository ruleset requires conversation resolution, so an
  open thread of any kind blocks the merge button the same way a failing
  check does. The session that owns the PR resolves each thread once it has
  acted on it: a change request gets the fix pushed and a one-line reply
  naming the commit; a question gets the answer; a validation or
  informational comment gets a reply saying it was read and, if it asked
  for nothing, that nothing changed. Resolve through the API
  (`resolveReviewThread` in GraphQL; in a cloud session the REST route
  `POST repos/saulpatinojr/HCW-HybridCloudWorks/pulls/<n>/ccr/comments/<comment_id>/resolve`,
  with a `comment_id` from that thread's entry in
  `.../pulls/<n>/ccr/review_threads`) after the reply, never before it — an unexplained
  resolution reads as dismissal to the next reviewer. Never resolve a thread
  to get past it: a thread whose ask has not been met stays open and the PR
  waits.

## Several PRs at once, but conflicts are resolved one at a time

Owner instruction 2026-09-10. Working more than one PR in a session is fine
and often faster. What is not fine is carrying two of them into the same
lines at once, because the second conflict is always worse than the first:
it lands on a file that has already been hand-merged, so the resolution has
to be re-derived rather than repeated.

- **Work them in parallel until they touch.** Independent PRs — different
  directories, different files — proceed together with no special handling.
- **The moment two open PRs would edit the same lines, stop one.** Finish the
  first through to merge, then fix the conflict on the next, then the next.
  One at a time, in a decided order, rather than all of them at once against
  a base that keeps moving.
- **`CHANGELOG.md` is the file this happens on.** Nearly every PR appends to
  the same `[Unreleased]` section, so two PRs open together will collide
  there even when they share no code. Treat a second changelog entry as the
  signal to serialise, not as a surprise when the merge button goes red.
- **Rebases follow the same rule: complete one, then rebase the next onto
  it.** Rebasing every open branch onto a new `main` at once means resolving
  the same upstream change several times over, once per branch, with no way
  to reuse the answer. Land one, rebase the next onto the result, land it,
  and continue. A branch waiting its turn is cheaper than a branch rebased
  twice.

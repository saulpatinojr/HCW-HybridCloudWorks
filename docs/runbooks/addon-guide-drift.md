# Add-on guide drift check

> **Status: built 2026-10-25 for [issue #1356](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1356).**
> The website half is in place. The check is live for an add-on only once that
> add-on's repository adds the caller below, and the issue closes after that.

**Scope:** the check that catches an add-on's integration guide saying something
different from the website, what it compares, how an add-on repository switches
it on, and how to read a failure.

**Authority:** this page does not authorize a change. Editing an add-on
repository is that repository's own pull request.

## Why it exists

Every add-on repository has an integration guide
(`docs/website-integration/integration-guide.md`). The guide pastes a copy of the
add-on's row from the website's catalogue
([`frontend/src/data/addons/catalogue.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/src/data/addons/catalogue.js)).
A copy of something that lives somewhere else goes out of date. On 2026-10-24 two
guides still said `coming` twelve days after the site had made those add-ons
`available`. People fixed them by hand, which only lasts until the next change.
So the check makes the difference fail a job instead of waiting for someone to
notice in a review.

## What it checks

It reads three files and changes nothing:

1. **The website's catalogue row** for the add-on's id, from `main`.
2. **The row pasted in the guide.** That is the first `js` code block under the
   guide's heading that starts "Catalogue row".
3. **The add-on's port**, from the lab host's settings,
   [`lab-host/ansible/group_vars/all.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-host/ansible/group_vars/all.yml)
   (the same file the lab host reads), but only when the guide states a port.

It then compares these twelve fields, item by item and in order for lists: `id`,
`title`, `summary`, `origin`, `panePath`, `healthPath`, `providers`,
`technology`, `status`, `capabilities`, `docsUrl`, `articleSlugs`. With a stated
port that is thirteen. It fails when:

- any field differs (the message names the field and both values);
- the website's catalogue no longer has the add-on's id ("the site no longer lists this add-on");
- the guide has no "Catalogue row" heading, no `js` block under it, or a block
  that cannot be read as one `{ ... }` object.

A row that says `coming` on one side and `available` on the other is just a
`status` difference, so it fails the same way.

When all is well it prints `in step: N fields compared`.

The code is [`scripts/addons/check-guide-drift.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/addons/check-guide-drift.mjs),
tested by `scripts/addons/check-guide-drift.test.mjs`. It uses only what comes
with Node, holds no secret and fetches nothing itself: the workflow hands it
files.

## How an add-on repository switches it on

The comparison is written once, here, as a *reusable workflow* (a workflow that
another repository can call, like calling a function):
`.github/workflows/addon-guide-check.yml`. The add-on repository adds a small
workflow of its own that calls it. The add-on's id is the one in the website's
catalogue (`migration`, `network-assessment`, `cloud-assessment`,
`cloud-crawler`).

1. In the add-on repository, create `.github/workflows/guide-drift.yml` with
   the text in the block below. Replace `network-assessment` with that add-on's id.
2. Add one more line, as the first line under `guide:` and level with
   `permissions:`. It starts `uses: ` and is made of three parts joined with no
   spaces: the path `saulpatinojr/HCW-HybridCloudWorks/.github/workflows/addon-guide-check.yml`,
   then `@`, then the full 40-character commit of the website repository that
   holds `addon-guide-check.yml`. Put a space and `# main` after it. That commit
   is not known until this change is merged (fill it in after the merge): take it
   from the merge commit of the pull request that added the workflow, or from
   the latest commit on `main`. The line is left out of the block below on
   purpose, so nobody pastes a line that cannot run.
3. Open a pull request in the add-on repository. The check should pass. To see
   it fail once, change the `summary` in the guide's pasted row and push; the
   job should go red and name `summary`. Put it back and it goes green.

The caller file, without its `uses:` line:

```yaml
name: Integration guide against the website

on:
  schedule:
    - cron: '35 6 * * 1'
  pull_request:
    paths:
      - docs/website-integration/**
      - .github/workflows/guide-drift.yml
  workflow_dispatch:

permissions: {}

jobs:
  guide:
    permissions:
      contents: read
    with:
      addon-id: network-assessment
```

`permissions: contents: read` on the calling job is needed: the called workflow
can keep or lower the permission the calling job gives it, never raise it
([GitHub Docs, reusing workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
note under "Nesting reusable workflows"), and its checkout steps need to read.
The weekly run is what catches the website changing under a guide that nobody
touched; the pull request run catches a guide edited into disagreement.

**Why the commit is pinned.** The called workflow fetches its own script at the
commit you give it, so a pinned commit means the script that judges your guide
cannot change under you. The website's data (the catalogue and the lab host
settings) is always read from `main`, because the point is to compare with the
website as it is now. The workflow needs no secret and no token of its own.

**Keeping the pin fresh.** Each add-on repository already has Dependabot's
`github-actions` ecosystem switched on (read 2026-10-25), so Dependabot opens a
pull request when the website's commit moves. This repository has no tags or
releases, which does not matter: per
[Dependabot's supported ecosystems](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories),
when the commit is not tied to a tag it "will update the GitHub Actions to the
latest commit". Each such pull request is a bump of the script, so read what
changed in `scripts/addons/check-guide-drift.mjs` before merging it.

## How to read a failure

The job summary (the page for the run, under the job's name) shows the website
commit it compared against and the message. Example:

```text
The guide for "network-assessment" no longer matches the website (2 problems):
  - status: the site says "available", the guide says "coming"
  - capabilities: the site says ["downloads","clipboard-write"], the guide says ["downloads"]
```

| What it says | What it means | What to do |
| --- | --- | --- |
| `<field>: the site says A, the guide says B` | The guide's pasted row is out of date | Edit the guide's row so that field reads A. The website is the authority. If A is wrong, fix the website first. |
| `<field> ... the guide says (not in the row)` | The guide's row is missing a field | Add it with the website's value. |
| `port: the site's lab host says A, the guide says B` | The guide's port row is out of date | Change the guide's "loopback port" row to A. |
| `port: ... group_vars has no port for "<id>"` | The guide states a port, but the lab host does not run this add-on | Expected while an add-on is `coming`: say "not assigned" in the guide's port row, which states no port. |
| `the site no longer lists this add-on` | The id is not in the catalogue: renamed or removed on the website | Check the id in the caller, and the website's catalogue for the rename. |
| `the guide has no heading that starts "Catalogue row"` or `no js block` | The guide was restructured | Put the row back under a heading that starts "Catalogue row" in a `js` code block. |
| `row block is not a readable object` | The pasted text is not one `{ ... }` object | Fix the syntax. Comments and trailing commas are fine; a second object or a function call is not. |
| `No integration guide at <path>` | The caller's path is wrong | Pass `guide-path` in the caller's `with:`. |

Exit codes: 1 means the guide has drifted or cannot be read as a row; 2 means
the check was set up wrongly (bad id, wrong path).

## What this does not prove

- It compares text with text. It does not check that the add-on really serves
  what the row says, only that the guide and the website agree.
- It does not compare `menuLabel`, `comingSince` or `comingReason`.
- The workflow was read against GitHub's documentation, and the script is
  tested; the reusable workflow's first run in an add-on repository is its first
  real proof. The commit the workflow fetches its script at comes from the `job`
  context's `workflow_sha`, documented in
  [Contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts),
  and the job stops with a clear message if GitHub does not supply it.

## Rollback

Delete the caller workflow in the add-on repository. Nothing else holds state.

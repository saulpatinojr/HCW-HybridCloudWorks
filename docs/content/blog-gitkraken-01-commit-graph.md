---
title: Reading 1,193 commits in the Commit Graph, no account needed
subtitle: Clone this site's public repository, open it in VS Code with GitLens 19.4, open the Commit Graph without signing in, and read what 1,193 commits on main say about how the site is built.
date: 2026-10-20
track: how-to
part: 1 of 3
tags: [git, gitlens, gitkraken, vs-code, github]
reading: 8
---

On 2026-10-20 the repository behind this site had **1,193 commits on `main`**,
and the newest of them ends its subject line with `(#1301)`. 841 of those
commits end the same way, with a pull request number in brackets, because
nearly everything that has reached `main` since late August arrived as one
squash-merged pull request. That is a history you can read, if you have
something better than `git log` to read it with.

GitLens 19.4, released on 2026-10-15, is the version that made this part
possible without a sign-in. Its release notes say: "As of GitLens 19.4, the
Commit Graph no longer requires an account on public and local repositories."
This repository is both, so the graph opens cold. This part opens it and reads
four things from it: how squash-merged pull requests line up, how to find a
pull request's commit from its number, how one bot's weekly bumps look over
six weeks, and where an open branch left `main`.

## What you'll have at the end

| Piece | Result |
| --- | --- |
| A clone | The site's public repository, full history, about 124 MB of packed objects on 2026-10-20 |
| The Commit Graph | Open on that clone, with no GitKraken account and no sign-in prompt |
| Four readings | The squash-merge line, one pull request found by number, one bot's cadence, one branch's fork point, each checked against a `git` command |
| A line between free and paid | What GitLens asked nothing for, and what its 19.4 notes say needs an account or a Pro plan |

## What it costs

**Nothing.** VS Code is free, GitLens is a free extension, and the repository
is public under the Apache License 2.0. The 19.4 notes draw the paid line at
private repositories: there the graph "is still part of GitLens Pro", with a
three-day preview that "starts on its own, with no account needed". A public
clone never reaches that line. Disk is the only cost, and it is the clone.

---

## Why read it this way

### A graph, because squash merges hide the shape in a list

`git log --oneline` on this repository prints 1,193 lines that look alike. A
squash merge folds a branch into one commit on `main`, so the list shows no
branches, no merges, and no sense of which commits landed together on a Monday
morning. The graph draws the same commits as rows on lanes, so a bot's weekly
run reads as a rhythm and an open branch reads as a lane leaving `main`.

The alternative is the pull request list on GitHub. It knows the pull
requests; it does not know which commit on `main` each one became, and it
cannot show two branches against each other.

### This repository, because its history is unusually regular

The repository's working agreements, in
[`.claude/CLAUDE.md`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.claude/CLAUDE.md),
run every change through a pull request, and the repository's settings allow
squash and rebase merges and refuse merge commits. The result is a `main` made
almost entirely of one-commit-per-pull-request rows. The exception is the
first month: the last merge commit on `main` is dated 2026-08-24 and reads
`Merge pull request #201 from HybridCloudWorks/chore/retire-migration-surface`.
Everything after it is squashed. A history with one visible change of policy
in it is a good one to learn a graph on.

### No account, because the point is the first five minutes

Before 19.4 the graph asked for a GitKraken account on every repository. For a
tutorial that is a wall: the reader has to decide whether to sign up before
seeing anything. On a public repository that wall is gone, and the notes say
which doors remain closed, which is the kind of honesty this part can repeat
rather than discover.

---

## Prerequisites

- git. Checked with the clone commands below on Windows 11; the same lines
  work in PowerShell and bash.
- VS Code, with the GitLens extension at **19.4 or later**. The account-free
  graph on public repositories is a 19.4 change; an earlier GitLens will ask
  you to sign in.
- About 200 MB of disk: on 2026-10-20 the packed objects were 124 MB and the
  checked-out tree 77 MB.
- **No GitKraken account.** Do not create one for this part; the point is to
  see what opens without it.

The numbers in this part were read from the repository on 2026-10-20 with
`git`. The GitLens behaviour is as its 19.4 and 19.3 release notes describe
it, read the same day.

---

## The steps

### 1. Clone the repository, with its whole history

PowerShell or bash:

```bash
git clone https://github.com/saulpatinojr/HCW-HybridCloudWorks.git
```

```bash
cd HCW-HybridCloudWorks
```

Not `--depth 1`: a shallow clone has one commit and no graph to read.

**Verify:**

```bash
git rev-list --count origin/main
```

On 2026-10-20 it printed `1193`. Yours prints at least that.

### 2. Open the folder in VS Code and open the Commit Graph

Open the `HCW-HybridCloudWorks` folder in VS Code. Open the command palette
and run **GitLens: Show Commit Graph**.

**Verify:** the graph opens on `main` with the newest commit at the top, and
nothing asks you to sign in. If a sign-in prompt appears, check the GitLens
version in the Extensions view: the account-free graph on public and local
repositories arrived in 19.4.

<!-- screenshot: the Commit Graph open on the repository, main at the top, the newest row reading "Cost analysis: Foundry's first month recorded on an estimate (#849) (#1301)", no sign-in banner visible -->

### 3. Read the squash-merge line

Look at the top of the graph: one lane, one row per pull request, every
subject ending in `(#…)`. Scroll down past August and the lane splits into
two-parent merge rows named `Merge pull request #…`. That is the policy
change: the repository moved from merge commits to squash merges, and the
graph shows the seam.

**Verify:**

```bash
git log origin/main --merges --format='%ad %s' --date=short | head -1
```

```text
2026-08-24 Merge pull request #201 from HybridCloudWorks/chore/retire-migration-surface
```

And the count of squashed rows:

```bash
git log origin/main --no-merges --format='%s' | grep -c '(#[0-9]*)$'
```

On 2026-10-20 it printed `841`. The 124 merge commits before the seam plus
these 841 are about 965 merged pull requests; the `1301` in the newest subject
is GitHub's shared counter for issues and pull requests, so it is an upper
bound, not a count.

### 4. Find a pull request's commit from its number

Open the graph's search and type `#1301`. One row matches: the squash commit
for pull request 1301. Its subject names two numbers, and they mean different
things: `(#849)` is the issue the work belongs to, and `(#1301)`, last, is
the pull request. The repository writes them in that order on purpose.

**Verify:**

```bash
git log origin/main --grep='(#1301)' --oneline
```

```text
15370072 Cost analysis: Foundry's first month recorded on an estimate (#849) (#1301)
```

What this step did not need: an account. What it would need one for: the pull
request's own details, its reviews and its checks, which GitLens reads through
a connected GitHub integration. The commit is in your clone; the pull request
is on GitHub.

<!-- screenshot: the graph search box containing "#1301" with the single matching row highlighted -->

### 5. Follow one bot's weekly bumps

Search for `frontend-minor-patch`. Dependabot groups the frontend's minor and
patch updates into one pull request, and
[`.github/dependabot.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/dependabot.yml)
schedules every one of its nine ecosystems `weekly` on `monday`. The matching
rows on 2026-10-20, newest first: 2026-10-20 (#1299), 2026-10-14 (#1137),
2026-10-08 (#1000), 2026-09-28 (#784), 2026-09-25 (#708 and #654), 2026-09-14
(#595), 2026-09-07 (#408).

Not every date is a Monday, and that is the reading. The graph shows when a
pull request was merged, not when the bot opened it. A Monday bump merged on
Wednesday sits on Wednesday.

**Verify:**

```bash
git log origin/main --author=dependabot --format='%ad' --date=format:%A | sort | uniq -c
```

On 2026-10-20: 39 of the 75 Dependabot commits on `main` landed on a Monday,
14 on a Friday, and the rest across the other four days.

### 6. Spot where a branch left main

First make every branch visible. In the filter dropdown beside the graph's
search box choose **All Branches**, and in the same dropdown's Graph Options
turn on remote-only branches. With **Current Branch** or **Smart Branches**
selected, or remote-only branches hidden, an unmerged branch has no lane, and
the comparison below finds nothing.

Now every remote branch that is not yet in `main` is a lane, and the row
where its lane leaves `main` is its fork point. On
2026-10-20 the repository had 11 remote refs, six of them Dependabot branches
named `dependabot/…`, each one commit above the `main` it was created from.
Those exact branches will be gone by the time you read this; the repository
deletes a branch when its pull request merges, and whichever branches are open
on your day make the same shape.

**Verify:**

```bash
git branch -r --no-merged origin/main
```

Every name it prints is a lane in the graph. That names the lanes; it does
not name the fork point. For that, take the first branch it printed and ask
git for the newest commit the branch and `main` share.

PowerShell:

```powershell
$b = (git branch -r --no-merged origin/main | Select-Object -First 1).Trim(); git log --oneline -1 (git merge-base origin/main $b)
```

bash:

```bash
b=$(git branch -r --no-merged origin/main | head -1 | tr -d ' '); git log --oneline -1 "$(git merge-base origin/main "$b")"
```

The one line it prints is the row on `main` where that branch's lane leaves
it. Find the same subject in the graph; the lane starts on the row above it.

<!-- screenshot: the graph with one dependabot/ branch selected, its single commit on its own lane and the main row it forked from -->

---

## How to know it worked

- `git rev-list --count origin/main` prints at least `1193`.
- The Commit Graph opened with no sign-in prompt.
- The last merge commit on `main` is dated `2026-08-24`, and every row above
  it ends in a pull request number.
- Searching `#1301` finds one row, and `git log --grep='(#1301)'` prints the
  same subject.
- `git branch -r --no-merged origin/main` prints the same names as the lanes
  leaving `main`.

Each reading has a `git` command beside it because the graph is a view of the
clone, not a second source. If the graph and the command disagree, the command
is right and the graph is out of date; GitLens refreshes when the repository
changes.

---

## When it doesn't work

**The graph asks you to sign in on this repository.** Check two things. The
GitLens version is 19.4 or later; the notes say the account went away in 19.4
for public and local repositories, so 19.3 still asks. And the folder you
opened is the clone, with its `.git` directory, not a downloaded zip of the
tree; GitLens needs a repository to read.

**The graph asks you to sign in on a repository of your own.** That is the
line the 19.4 notes draw. On privately hosted repositories the graph "is still
part of GitLens Pro", and "the first time you open it on a private repository,
a 3-day preview starts on its own, with no account needed". After the preview,
the graph on that repository needs a plan. A public repository, or a local one
with no private remote, does not.

**Start Work or Start Review asks you to sign in.** Expected. The same notes
say those two "now ask you to sign in up front, instead of signing you in
silently". They read your issues and pull requests across connected
integrations, which is account work. Nothing in this part uses them.

**The search finds nothing for `#1301`.** Your clone is older than that pull
request's merge, which it cannot be if you cloned after 2026-10-20, or you
cloned shallow. `git rev-list --count origin/main` printing `1` is a shallow
clone; clone again without `--depth`.

**A Dependabot branch from step 6 is not there.** It merged. Run the
`git branch -r --no-merged origin/main` line again and pick a name it prints
today.

---

## What's next

[Part 2](https://docs.hybridcloudworks.com/content/blog-gitkraken-02-mcp-server/)
puts the same repository in front of an AI coding session, with the GitKraken
MCP server as its hands on git and pull requests.
[Part 3](https://docs.hybridcloudworks.com/content/blog-gitkraken-03-stacked-prs/)
takes the repository's one-conflict-at-a-time rule to GitLens 19.3's
Auto-Rebase Stack. Both links point at the drafts on the documentation site;
once an article is published, it lives on hybridcloudworks.com under
`/github/blog/` and its title's slug.

The author is a GitKraken Ambassador; GitKraken did not review this article
and the numbers in it come from the repository, not from GitKraken.

<!-- Sources, read 2026-10-20 (the CMS strips this comment):
  repository: README.md lines 14 and 113-116 (public, Apache-2.0); LICENSE
  git log origin/main: 1,193 commits, 124 merges, 841 non-merge subjects ending "(#N)", last merge 2026-08-24 (#201), first commit 2026-07-22
  newest commit 15370072 "Cost analysis: Foundry's first month recorded on an estimate (#849) (#1301)"
  .github/dependabot.yml: nine schedule blocks, each interval weekly, day monday
  Dependabot commits on main: 75, 39 on Mondays, 14 on Fridays; frontend-minor-patch rows #408 #595 #654 #708 #784 #1000 #1137 #1299
  git branch -r on 2026-10-20: 11 refs, six dependabot/
  git count-objects -vH: size-pack 123.54 MiB
  .claude/CLAUDE.md: "Pull requests open ready for review, not as drafts"; "Several PRs at once, but conflicts are resolved one at a time"
  repository settings read with gh repo view on 2026-10-20: squashMergeAllowed true, rebaseMergeAllowed true, mergeCommitAllowed false, deleteBranchOnMerge true, isPrivate false
  not in the repository: GitLens 19.4 (2026-10-15) and 19.3 (2026-10-01) release notes, help.gitkraken.com/gitlens/gitlens-release-notes-current/, read 2026-10-20
  not verified: the GitLens UI steps (steps 2-6) were written from the release notes and the extension's documented commands, not run for this draft
-->

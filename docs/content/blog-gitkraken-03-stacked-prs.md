---
title: "Merge conflicts on stacked pull requests: a repository's rules meet Auto-Rebase Stack"
subtitle: This repository resolves one conflict at a time, and the file it conflicts on is CHANGELOG.md. What that rule costs by hand, what GitLens 19.3's Rebase Stack and Auto-Rebase Stack and GitKraken Desktop 12.6's stacked pull requests change, and a walk-through of the CHANGELOG conflict itself.
date: 2026-10-20
track: how-to
part: 3 of 3
tags: [git, gitlens, gitkraken, rebase, pull-requests, merge-conflicts]
reading: 8
---

Between 2026-10-01 and 2026-10-20, 325 commits reached this repository's
`main`, and **233 of them changed `CHANGELOG.md`**. The file is 17,390 lines
long, and every entry goes in near the top, under `## [Unreleased]` at line
18. Two pull requests open at the same time will both insert a few lines into
the same section of the same file, and whichever merges second conflicts.

The repository's working agreements already know this. The section titled
"Several PRs at once, but conflicts are resolved one at a time" in
[`.claude/CLAUDE.md`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.claude/CLAUDE.md)
names the file: "`CHANGELOG.md` is the file this happens on." This part reads
that rule, walks the conflict by hand on two branches, and then reads what
GitLens 19.3 (2026-10-01) and GitKraken Desktop 12.6 add for a stack of
them.

## What you'll have at the end

| Piece | Result |
| --- | --- |
| The rule | Why this repository serialises conflicts, and the one file that forces it |
| A conflict, by hand | Two branches, one `CHANGELOG.md` section, one rebase, the markers you will see and the resolution |
| The squash trap | Why rebasing a stacked branch after its base squash-merges replays commits that are already on `main`, and the `--onto` that avoids it |
| What the tools change | Rebase Stack, Auto-Rebase Stack and Force Push Stack from GitLens 19.3; stacked pull requests and multi-commit diff from Desktop 12.6 |

## What it costs

**Nothing.** The walk-through runs in a clone of your own, or in a fork of
this repository, with git alone. The GitLens stack commands are in the
extension's 19.3 release notes with no `PRO` or `PREVIEW` marker beside them;
the notes' legend reserves `PRO` for features that "require a trial or paid
plan for use on privately hosted repos" and `PREVIEW` for ones that "require a
GitKraken Account". Auto-Rebase Stack hands conflicts to GitKraken AI, whose
weekly allowance the 19.1 notes tie to the plan you are on; a hand-resolved
rebase costs nothing.

---

## Why one at a time

### Parallel until they touch

The rule has three sentences worth quoting. "Independent PRs — different
directories, different files — proceed together with no special handling."
Then: "The moment two open PRs would edit the same lines, stop one. Finish the
first through to merge, then fix the conflict on the next, then the next."
And for rebases: "Land one, rebase the next onto the result, land it, and
continue. A branch waiting its turn is cheaper than a branch rebased twice."

The reason given is the second conflict: it "lands on a file that has already
been hand-merged, so the resolution has to be re-derived rather than
repeated." Two branches rebased onto a moving `main` at once mean resolving
the same upstream change twice, with no way to reuse the first answer.

### The changelog is the collision because every change records itself

The repository's `CHANGELOG.md` records completed work only, under Keep a
Changelog headings, and each pull request adds its own entry at the top of
its section. Two pull requests on 2026-10-19 and 2026-10-20 show the shape.
#1300 inserted 16 lines at line 45, under **Quality & Verification**. #1301
inserted 13 lines at line 593, under **Changed**. Different sections, so no
conflict. Had both been features, both would have inserted at line 20, and
git would have had two different insertions at one point with no way to
order them.

That is a textual conflict with an obvious right answer: keep both. It is
also the repository's most common conflict, which is why the agreements call
a second changelog entry "the signal to serialise, not a surprise when the
merge button goes red."

CodeRabbit does not review the file at all; `.coderabbit.yaml` excludes
`CHANGELOG.md` in its `path_filters`. The conflict is the author's.

### Squash merges make stacks harder than they look

The repository allows squash and rebase merges and refuses merge commits, so
a merged pull request becomes one new commit on `main`. If branch B was built
on branch A, then after A squash-merges, B's history still holds A's
original commits, and `main` holds a different commit with the same content.
A plain `git rebase main` on B replays A's commits first, and every one of
them conflicts with the squash that already contains it. The fix is to tell
git where B's own commits start:

```bash
git rebase --onto main A B
```

That replays only B's commits, the ones after A, onto `main`. Forget `--onto`
and the first conflict is not in `CHANGELOG.md` but in every file A touched,
with both sides identical.

---

## Prerequisites

- git, for `git rebase --onto`.
- A clone of your own, or a fork of this repository: any repository with a
  changelog that grows at the top.
- For steps 5 and 6: VS Code with GitLens 19.3 or later, and GitKraken
  Desktop 12.6 or later. Neither is needed for the hand walk-through.

The repository counts were read on 2026-10-20. The GitLens and Desktop
behaviour is as their release notes describe it, read the same day; this part
has not run Auto-Rebase Stack against this repository's changelog, and says
where it is describing the notes rather than a result.

---

## The steps

### 1. Make two branches that both add a feature entry

From `main`, make branch `a` and add one entry at the top of the Features
section of `CHANGELOG.md`, then commit. Go back to `main`, make branch `b`,
add a different entry at the same place, commit. Both branches are now one
commit above `main`, and both inserted at the same line.

**Verify:**

```bash
git log --oneline main..a
```

```bash
git log --oneline main..b
```

Each prints one line.

### 2. Land the first, by squash

Merge `a` into `main` the way the repository would, as a squash:

```bash
git checkout main
```

```bash
git merge --squash a
```

```bash
git commit -m "Feature A (#1)"
```

**Verify:** `git log --oneline -1 main` prints the squash commit, and
`git log --oneline main..a` still prints `a`'s original commit, because a
squash does not mark the branch merged. That is the squash trap from above,
made visible.

### 3. Rebase the second onto the result, and read the conflict

```bash
git rebase main b
```

git stops and names the file, `CONFLICT (content): Merge conflict in
CHANGELOG.md`, with the commit it could not apply on the line after. Open
`CHANGELOG.md` at the Features heading. Between the markers are two
blocks: `main`'s side holds Feature A's entry, your branch's side holds
Feature B's. Neither is wrong. Keep both, newest first, delete the three
marker lines, then:

```bash
git add CHANGELOG.md
```

```bash
git rebase --continue
```

**Verify:** `git log --oneline main..b` prints one commit, and
`CHANGELOG.md` holds both entries under Features with no `<<<<<<<` left:

```bash
grep -c '^<<<<<<<' CHANGELOG.md
```

prints `0`.

<!-- screenshot: CHANGELOG.md at the Features heading with the conflict markers visible, Feature A's entry on one side and Feature B's on the other -->

### 4. Do it again with a stack, and use --onto

Now make `c` on top of `b`, with a third entry, so `c` is a stack of two.
Squash-merge `b` into `main` as in step 2. Then rebase `c`:

```bash
git rebase --onto main b c
```

Only `c`'s own commit replays. Without `--onto`, git would try `b`'s commit
first, against a `main` that already contains it, and you would resolve
Feature B against itself before ever reaching Feature C.

**Verify:** `git log --oneline main..c` prints one commit, and
`git rebase` stopped at most once, on the Features section.

### 5. Read what GitLens 19.3 does with the same stack

This step is the release notes, not a result. GitLens 19.3, released on
2026-10-01, added three commands for exactly this shape:

- **Rebase Stack** "now does the whole chain in one go. It replays each
  layer onto the one below it and the bottom layer onto the stack's trunk."
  That is steps 3 and 4 as one action, with the base of each layer tracked
  for you rather than typed after `--onto`.
- **Auto-Rebase Stack** "hands conflicts to AI the whole way up. When it
  needs your help it pauses instead of unwinding." A rebase that pauses
  leaves you at step 3's markers; one that unwinds leaves you back at the
  start. For the changelog conflict, where the answer is "keep both", an
  automatic resolution is the kind a reviewer can check in seconds, which is
  what the verify line at the end of this step is for.
- **Force Push Stack** is offered "with every rewritten branch pre-checked",
  and only "when the stack has drifted from its trunk". A rebased branch
  needs a force push, and a stack needs one per layer.

What stays the same is the repository's rule. The notes describe one stack
rebased in one go; the agreements say to land one pull request before
rebasing the next onto it. Those agree. What the tools change is the cost of
each turn, not the order of turns.

**Verify, if you run it:** after any automatic resolution, count the entries
under the Features heading before and after. An entry the AI dropped is the
failure to look for, and it is one `grep` away:

```bash
grep -c '^- \*\*' CHANGELOG.md
```

The number after the rebase is the number before plus the entries your
branches added. Anything less is a lost entry.

### 6. Read what GitKraken Desktop 12.6 adds at the other end

Desktop 12.6's notes add the stack at creation time: "When the target branch
already has an open pull request, GitKraken can add the new pull request to a
stack," and the Create Pull Request panel "identifies the pull requests that
the new one will stack on." The notes list this for GitHub.com. The same
release's multi-commit diff shows consecutive commits' "combined changes in
the right panel", which is how you read a stack's whole change before opening
it. The notes also record "improved merge conflict resolution performance
when a merge adds and deletes many files", a performance fix rather than a
new resolver. Version 12.5 is dated 2026-09-15; the 12.6 notes carry no date
on the page as read on 2026-10-20.

**Verify:** the Create Pull Request panel names the pull request your branch
will stack on.

---

## How to know it worked

- After step 3, `grep -c '^<<<<<<<' CHANGELOG.md` prints `0` and both entries
  are under Features.
- After step 4, `git log --oneline main..c` prints one commit; the `--onto`
  did its job.
- After any automatic resolution, the entry count is before plus what your
  branches added.

---

## When it doesn't work

**The rebase conflicts in files the branch never touched.** You rebased a
stacked branch onto `main` without `--onto` after its base squash-merged.
Both sides of each marker read the same. `git rebase --abort`, then rebase
with `--onto main` and the old base, as in step 4.

**A second branch conflicts in the same lines you just resolved.** That is
the case the rule exists for, and it is why the agreements say to land the
first before rebasing the next. Finish one, merge it, then rebase the next
onto the result and resolve once.

**Auto-Rebase Stack paused.** Expected, by the notes: it pauses "instead of
unwinding" when it needs help. Resolve the markers it stopped on as in step 3,
then take the notes' **Continue with Auto-Rebase**, which "carries on through
the rest of the stack, not just the branch you fixed".

---

## What's next

[Part 1](https://hybridcloudworks.com/github/blog/reading-a-1300-pull-request-repository-with-the-commit-graph-no-account-needed)
reads this repository's history in the Commit Graph with no account, and
[part 2](https://hybridcloudworks.com/github/blog/the-gitkraken-mcp-server-inside-an-ai-coding-session)
puts the GitKraken MCP server in front of a coding session that works it.

The author is a GitKraken Ambassador; GitKraken did not review this article,
and the counts in it are the repository's own.

<!-- Sources, read 2026-10-20 (the CMS strips this comment):
  git log origin/main --since=2026-10-01: 325 commits, 233 touching CHANGELOG.md
  wc -l CHANGELOG.md: 17390; "## [Unreleased]" at line 18; "### Features" at line 20
  git show 15370072 (#1301): CHANGELOG.md hunk @@ -593,6 +593,19 @@; git show a0efbf3a (#1300): hunk @@ -45,6 +45,22 @@
  CHANGELOG.md header: Keep a Changelog, completed work only
  .claude/CLAUDE.md: "Several PRs at once, but conflicts are resolved one at a time" (quoted lines)
  .coderabbit.yaml: path_filters excludes CHANGELOG.md
  repository settings read with gh repo view on 2026-10-20: squashMergeAllowed true, rebaseMergeAllowed true, mergeCommitAllowed false
  not in the repository: GitLens 19.3 (2026-10-01) and 19.4 (2026-10-15) release notes and legend, help.gitkraken.com/gitlens/gitlens-release-notes-current/; GitKraken Desktop release notes, help.gitkraken.com/gitkraken-desktop/current/ (12.5.0 dated 2026-09-15; 12.6.0 carries no date on the page)
  not verified: Rebase Stack, Auto-Rebase Stack and Force Push Stack were not run against this repository for this draft; step 5 and the last troubleshooting entry describe the release notes
  not verified: the walk-through in steps 1-4 was not run for this draft (the drafting session's git was confined to its worktree); the CONFLICT line in step 3 is git's standard content-conflict message, not captured output
-->

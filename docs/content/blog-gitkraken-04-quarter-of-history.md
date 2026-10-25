---
title: What 636 pull requests left behind
subtitle: In 71 days one repository merged 636 pull requests, and its git history shows who opened them, which file collided, what squash merging hid, and where the one-conflict-at-a-time rule came from.
date: 2026-10-25
track: build-log
tags: [git, github, merge-conflicts, commit-graph, ai-assisted-development]
reading: 8
---

Between 2026-07-22 and 2026-09-30, 71 days, the repository behind this site
merged **636 pull requests** and recorded **868 commits** on `main`. On the
single busiest day, 2026-09-29 (UTC), 31 pull requests merged, and 25 of the 31
commits that landed that day edited the same file.

That file is `CHANGELOG.md`, and it is why this article exists. I wanted to
know how a history this busy stays readable, how many conflicts it hid, and
whether the rule I wrote down about them came from evidence or from a hunch.
Every number below comes from `git` or the GitHub command line, and the
commands are in the last section so you can check me.

A few words, since I will use them throughout. A **commit** is one saved
change. A **pull request** is a request to merge a branch (a line of commits
that runs alongside `main`) into `main`, the branch everything ships from. A
**merge conflict** is what git reports when two branches changed the same
lines and it cannot choose between them
([GitHub's page on merge conflicts](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/addressing-merge-conflicts/about-merge-conflicts)).

## The setup

One person runs the site, and many of the changes are written in sessions with
an AI coding assistant. The repository's own
[working agreements](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.claude/CLAUDE.md)
say that a session "authors as the owner's account". That one fact limits what
the history can tell me, and I come back to it below.

The constraint that made this interesting was speed. Work that arrives that
quickly will keep touching the same files.

## Who opened the 636

I asked GitHub who authored each merged pull request:

| Opened by | Pull requests | Share |
| --- | --- | --- |
| The owner's account | 566 | 89% |
| Dependabot (GitHub's bot that opens dependency-update pull requests, [about it](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates/about-dependabot-version-updates)) | 56 | 9% |
| A GitHub App the repository owns, for regenerating checked-in files | 12 | 2% |
| GitHub's coding agent | 1 | under 1% |
| One other account | 1 | under 1% |

Automation opened 69 of the 636, about 11%. That is the honest answer to "how
many by automation and how many by hand", and the second half is weaker than it
looks. The 566 from the owner's account include everything a session wrote, so
I cannot split hand-written from assistant-written pull requests from
authorship.

The nearest signal is the `Co-Authored-By` line a commit can carry
([GitHub explains these trailers](https://docs.github.com/en/pull-requests/committing-changes-to-your-project/creating-and-editing-commits/creating-a-commit-with-multiple-authors)).
653 of the 868 commits (75%) carry at least one. 603 of the 868 (69%) carry one
from an AI coding assistant; the other 50 name bots, the owner, or GitHub's own
assistant. Read that as "a session was involved", not as "the assistant wrote
69% of the code". A squash commit (a pull request
folded into one commit, [GitHub's page on merge methods](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges))
keeps the trailers of every commit inside it, so one involved session marks the
whole thing.

The pace is the part to notice. The median pull request took about 13
minutes from opening to merge. 519 of the 636, 82%, merged within the hour,
and 16 stayed open longer than a day. Among the pull requests that later
merged, at most 10 were open at once. Pull requests closed without merging are
not in that count, so the true peak may be higher.

## The history changed shape in the middle

The first thing that did not add up was that 868 commits and 636 pull
requests do not line up. Before 2026-08-25 there were 414 commits for 177 pull requests, about 2.3
commits per pull request, counting both methods. From 2026-08-25 to the end of the quarter there were 454 commits for 459
pull requests: about one each.

The cause is how the pull requests were merged. A **merge commit** keeps every
commit of the branch and adds one more commit that joins it to `main`. There
are 124 in the quarter. The first is dated 2026-08-05 and the last 2026-08-24;
119 of them merge a pull request and 5 bring `main` into a branch. **Squash
merging** folds a whole pull request into one commit whose subject ends in the
pull request number, like `(#151)`. The first such commit is dated 2026-08-21,
so for four days, 2026-08-21 to 2026-08-24, both methods were in use. From
2026-08-25 every pull request was squashed.

Here is a stretch from 2026-08-05, redrawn from `git log --graph` with the
commit subjects left off and the eight commits of one branch collapsed to a
single line ([the `git log` manual](https://git-scm.com/docs/git-log)):

```text
*   ce497be6 2026-08-05
|\
| * 477099b2 2026-08-05
| *   1b5c0974 2026-08-05
| |\
| |/
|/|
* |   0a763182 2026-08-05
|\ \
| * | ... (eight more commits of the same shape)
|/ /
| * e76761b1 2026-08-05
|/
* 0ff4d430 2026-07-30
```

The left column is `main`. The right-hand lines are branches that left it
and came back. After 2026-08-24 this picture is a single straight line, which
is tidy to read and hides something I will get to.

## One conflict git kept

That picture contains a conflict. Branch `e76761b1`, a batch of reviewed
dependency updates, left `main` at `0ff4d430` on 2026-07-30. While it sat open,
[pull request #26](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/26)
merged into `main` as `0a763182`. Both had changed the same stretch of one
GitHub Actions workflow file (a file that tells GitHub what to run):

- The branch changed 2 lines: `actions/checkout@v4` became `@v7`, and
  `actions/setup-node@v4` became `@v7`.
- Pull request #26 rewrote the job around them: 90 lines added and 26 removed.

Git could not choose between a two-line change and a rewrite of the same
lines. The session merged `main` into the branch,
[commit `1b5c0974`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/commit/1b5c0974bca89e6bfc691a0d14cc00910701f16a),
and git recorded the stop in the commit message: `# Conflicts:` followed by the
workflow's path. The answer was plain: take `main`'s whole rewrite, then apply
the two version bumps on top. I checked it, and the difference between `main`'s
side and the finished file is exactly those two lines:

```diff
-      - uses: actions/checkout@v4
+      - uses: actions/checkout@v7
-        uses: actions/setup-node@v4
+        uses: actions/setup-node@v7
```

The branch then merged as
[pull request #30](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/30)
(`ce497be6`), the top line of the graph.

That is the clean version of a conflict: two changes that are both right, and
a resolution that keeps both. It is also nearly unique. Of the 124 merge
commits, `git diff-tree --cc` finds a hand-made change in only 3
(a merge's result that differs from both of its parents, which is how a
hand-made resolution shows up; [git's explanation of the combined diff](https://git-scm.com/docs/git-diff#_combined_diff_format)):
this one; a second, a merge of `main` into a long-lived branch that changed 47
files (workflows, front-end files and lockfiles), with hand-made lines in a
`package.json` and its lockfile (the file that pins exact dependency
versions); and a third, a Dependabot merge that changed two lines of another
workflow file.

## What the squash merges hid

Here is what I could not measure. From 2026-08-25 every pull request was
squashed, and I found no way to count its conflicts. The mechanism, as I read
it: a conflict is resolved on the branch, before the merge, in the branch's
own commits. The squash then folds them into one commit that shows the
finished change. Nothing in that commit says a conflict happened.

So the history cannot tell me how many conflicts there were. I can tell you
what the history does show: the file they happen in.

## The file that collides

Of the 868 commits, 373 touched `CHANGELOG.md`, 43%. It is the project's list
of finished work, kept in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format, and nearly
every pull request from the owner's account adds its entry near the top, under the same `[Unreleased]`
heading. Two pull requests open together will often insert lines at the same
spot, and when they do, the one that merges second tends to conflict. No code needs to
be shared.

On 2026-09-29, the busiest day, 25 of the 31 commits edited it. All 25 carry
the owner's commit author name. The six that did not, five from Dependabot and one
from the GitHub App, touched other files. That day came 19 days after I wrote
a rule about exactly this file.

## The rule, and where it came from

On 2026-09-10 the working agreements gained a section called "Several PRs at
once, but conflicts are resolved one at a time"
([pull request #486](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/486),
[commit `9e28c8a1`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/commit/9e28c8a13046469b50a99b45385c745493c511f7)).
It says to work pull requests in parallel until they touch the same lines,
then stop one and land the other first. Its reason is a sentence I still
agree with: the second conflict "lands on a file that has already been
hand-merged, so the resolution has to be re-derived rather than repeated." It
names the file: "`CHANGELOG.md` is the file this happens on."

I should be straight about the evidence. The rule is recorded as an owner
instruction, and the pull request that added it gives a reason, not a count. I
cannot tell you from the history whether conflicts fell afterwards. The data
above shows the pressure on the file, not the effect of the rule.

## What I would do differently

These are opinions. I have not tried the first two.

- **Make conflicts countable.** When a rebase (replaying a branch's commits on
  top of a newer `main`) hits one, I would add a line to the pull request
  description. Squash merging keeps this history readable,
  but it erases the evidence, and a rule should have a number behind it.
- **Give each pull request its own changelog file** that a script assembles
  at release time, so two pull requests never edit the same line. The cost is
  the script, and I would weigh it against 373 commits.
- **Choose the merge method before the first pull request.** Every figure that
  spans 2026-08-05 to 2026-08-24 mixes two merge methods. The mismatch
  between 868 and 636 is how it shows.

## Where it stands

The repository has a rule, a named file and a quarter of numbers. It does not
have a conflict count, and this article cannot supply one. I did not check
whether the squash-versus-merge choice changed how quickly pull requests landed,
or compare the weeks before and after the rule for any change in behaviour.

The author is a GitKraken Ambassador
([the programme](https://www.gitkraken.com/ambassador)); GitKraken did not
review this article. The numbers came from `git` and the GitHub command line,
not from GitKraken's tools. For those, see
[part 1](https://docs.hybridcloudworks.com/content/blog-gitkraken-01-commit-graph/),
which reads this history in the Commit Graph, and
[part 3](https://docs.hybridcloudworks.com/content/blog-gitkraken-03-stacked-prs/),
which walks the `CHANGELOG.md` conflict by hand. Both links point at drafts on
the documentation site; a published article lives on hybridcloudworks.com
under `/github/blog/` and its title's slug.

## How these numbers were counted

Run these in a full clone of the
[repository](https://github.com/saulpatinojr/HCW-HybridCloudWorks) (not
`--depth 1`), after `git fetch origin main`. They were run on 2026-10-25 at
`origin/main` `b7928763`, in bash (Git Bash on Windows), on a US Central
(UTC-5) machine. The quarter is calendar Q3, and the repository's first commit
is 2026-07-22, so nothing is cut at the start. `git log --since` and `--until`
read dates in your machine's time zone and `gh` searches use UTC. At the end of
the quarter that matters for one commit, `46db4972`, made on the evening of
2026-09-30 Central time and so already 2026-10-01 in UTC: a machine in UTC
counts 867 commits, not 868. The GitHub CLI's
[`gh pr list`](https://cli.github.com/manual/gh_pr_list) manual covers
`--search` and `--json`.

**The first commit, so the 71 days.** It prints `2026-07-22`. From there to
2026-09-30 is 10 + 31 + 30 days.

```bash
git log origin/main --reverse --format=%ad --date=short | head -1
```

**The commits in the quarter.** It prints `868`.

```bash
git log origin/main --since=2026-07-01 --until=2026-10-01 --oneline | wc -l
```

**The merged pull requests.** It prints `636`.

```bash
gh pr list --state merged --search "merged:2026-07-01..2026-09-30" --limit 1000 --json number --jq length
```

**Who opened them.** It prints 566, 56, 12, 1 and 1 beside the five account
names. Automation is 56 + 12 + 1 = 69, and 69 / 636 is 10.8%.

```bash
gh pr list --state merged --search "merged:2026-07-01..2026-09-30" --limit 1000 --json author --jq '.[].author.login' | sort | uniq -c | sort -rn
```

**Commits with a co-author trailer.** It prints `653`, which is 75.2% of 868.

```bash
git log origin/main --since=2026-07-01 --until=2026-10-01 -i --grep='^Co-Authored-By:' --oneline | wc -l
```

**The trailers from an AI coding assistant.** It prints `603`, which is 69.5%
of 868. The other 50 commits name bots, the owner, or GitHub's own assistant.

```bash
git log origin/main --since=2026-07-01 --until=2026-10-01 -i --grep='^Co-Authored-By: Claude' --oneline | wc -l
```

**The names on all the trailers.** One count per name, per trailer line.

```bash
git log origin/main --since=2026-07-01 --until=2026-10-01 --format=%b | grep -i '^co-authored-by:' | sed 's/ *<.*//' | sort | uniq -c | sort -rn | head
```

**The busiest day for merges.** The first line is `31 2026-09-29`, in UTC.

```bash
gh pr list --state merged --search "merged:2026-07-01..2026-09-30" --limit 1000 --json mergedAt --jq '.[].mergedAt[0:10]' | sort | uniq -c | sort -rn | head -3
```

**The commits on that day, and the ones that touched the changelog.** They
print `31` and `25`.

```bash
git log origin/main --since=2026-09-29T00:00:00Z --until=2026-09-30T00:00:00Z --oneline | wc -l
```

```bash
git log origin/main --since=2026-09-29T00:00:00Z --until=2026-09-30T00:00:00Z --oneline -- CHANGELOG.md | wc -l
```

**Who wrote those 25.** It prints `25` beside the owner's commit author name
(the name in the commit, not a check of the GitHub account).

```bash
git log origin/main --since=2026-09-29T00:00:00Z --until=2026-09-30T00:00:00Z --format=%an -- CHANGELOG.md | sort | uniq -c
```

**The commits that touched the changelog in the quarter.** It prints `373`,
which is 43.0% of 868.

```bash
git log origin/main --since=2026-07-01 --until=2026-10-01 --oneline -- CHANGELOG.md | wc -l
```

**The merge commits, the last one's date and the first one's.** They print
`124`, `2026-08-24` and `2026-08-05`.

```bash
git log origin/main --since=2026-07-01 --until=2026-10-01 --merges --oneline | wc -l
```

```bash
git log origin/main --since=2026-07-01 --until=2026-10-01 --merges -1 --format=%ad --date=short
```

```bash
git log origin/main --since=2026-07-01 --until=2026-10-01 --merges --reverse --format=%ad --date=short | head -1
```

**Which merge commits merge a pull request.** They print `119` and `5`.

```bash
git log origin/main --since=2026-07-01 --until=2026-10-01 --merges --grep='^Merge pull request' --oneline | wc -l
```

```bash
git log origin/main --since=2026-07-01 --until=2026-10-01 --merges --invert-grep --grep='^Merge pull request' --oneline | wc -l
```

**The first squash commit.** The subject ends in a pull request number. The
first line printed is dated `2026-08-21`.

```bash
git log origin/main --no-merges -E --grep='\(#[0-9]+\)$' --reverse --format='%h %ad %s' --date=short | head -3
```

**The merge commits with a hand-made change.** It prints three hashes:
`e1ff5b19`, `6127bb77` and `1b5c0974`. For the second, `git diff --stat
6127bb77^1 6127bb77` ends `47 files changed`.

```bash
for c in $(git log origin/main --merges --format=%h); do [ -n "$(git diff-tree --cc --no-commit-id -r $c)" ] && echo $c; done
```

**Commits and pull requests before and after the switch.** The commits print
`414` and `454`; the pull requests print `177` and `459`. 414 / 177 is 2.3.

```bash
git log origin/main --since=2026-07-01 --until=2026-08-25 --oneline | wc -l
```

```bash
git log origin/main --since=2026-08-25 --until=2026-10-01 --oneline | wc -l
```

```bash
gh pr list --state merged --search "merged:2026-07-01..2026-08-24" --limit 1000 --json number --jq length
```

```bash
gh pr list --state merged --search "merged:2026-08-25..2026-09-30" --limit 1000 --json number --jq length
```

**The conflict's message.** It shows `# Conflicts:` and a workflow path.

```bash
git show -s --format=%B 1b5c0974
```

**The resolution against `main`'s side.** It prints the four changed lines
shown above.

```bash
git diff 1b5c0974^2 1b5c0974 -- .github/workflows/migrate-data.yml
```

**Each side's change to that file.** The first prints 90 insertions and 26
deletions; the second, 2 and 2.

```bash
git diff --stat 0ff4d430 0a763182 -- .github/workflows/migrate-data.yml
```

```bash
git diff --stat 0ff4d430 e76761b1 -- .github/workflows/migrate-data.yml
```

**The rule's merge time.** It prints `2026-09-10T17:12:14Z`.

```bash
gh pr view 486 --json mergedAt --jq .mergedAt
```

The pull request timings need the opened and merged times, saved first:

```bash
gh pr list --state merged --search "merged:2026-07-01..2026-09-30" --limit 1000 --json number,createdAt,mergedAt > q3.json
```

```python
import json, statistics
from datetime import datetime
prs = json.load(open("q3.json"))
t = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
mins = [(t(p["mergedAt"]) - t(p["createdAt"])).total_seconds() / 60 for p in prs]
print(round(statistics.median(mins), 1))
print(sum(m <= 60 for m in mins), sum(m > 1440 for m in mins))
events = sorted([(t(p["createdAt"]), 1) for p in prs] + [(t(p["mergedAt"]), -1) for p in prs])
now = most = 0
for _, step in events:
    now += step
    most = max(most, now)
print(most)
```

It prints `12.7`, then `519 16`, then `10`. The last is the most open at once
among pull requests that merged; ones closed without merging are not in the
list, so the true peak may be higher.

<!-- Sources and checks, 2026-10-25 (the CMS strips this comment):
  all repository figures: the commands in "How these numbers were counted", run in a worktree of origin/main b7928763
  .claude/CLAUDE.md: "authors as the owner's account" and "Several PRs at once, but conflicts are resolved one at a time" (quoted lines)
  pull request 486 / commit 9e28c8a1: the rule's origin, "Two owner instructions from 2026-09-10"
  the site footer links the GitKraken Ambassador programme page (https://www.gitkraken.com/ambassador, HTTP 200 on 2026-10-25)
  documentation links opened with curl on 2026-10-25, all HTTP 200: docs.github.com (merge conflicts, pull request merges, Dependabot, multiple authors), git-scm.com (git-log, git-diff combined diff format), keepachangelog.com, cli.github.com/manual/gh_pr_list
  not verified: that conflicts fell after the 2026-09-10 rule (the history cannot show it); that the mechanism in "What the squash merges hid" is what happened on any given pull request (it is a reading of how squash merges work); whether the third hand-made merge commit (e1ff5b19) was a conflict (it changed two lines of one workflow file); how many of the 566 pull requests from the owner's account were written in assistant sessions
  not verified: the two "would do" suggestions (a changelog file per pull request; a conflict line in the description) were not tried
  not verified: the docs.hybridcloudworks.com links to parts 1 and 3 point at drafts that are not published
-->

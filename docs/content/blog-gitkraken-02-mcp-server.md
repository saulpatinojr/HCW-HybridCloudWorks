---
title: The GitKraken MCP server inside an AI coding session
subtitle: What an MCP server is, how gk mcp install puts GitKraken's in front of a coding session, what its Git and pull request tools let the session do on a one-person platform that runs every change through a pull request, and the one thing it does not do.
date: 2026-10-20
track: how-to
part: 2 of 3
tags: [git, gitkraken, mcp, ai-agents, github, pull-requests]
reading: 9
---

This site is built by one person, and between 2026-07-22 and 2026-10-20 its
repository merged about 965 pull requests: 841 squash commits on `main` with
a pull request number at the end of the subject, and 124 merge commits from
the first month, before the repository stopped allowing them. That is more
than ten a day, and most of them were written in AI coding sessions. A
session that cannot see the repository's state, make a branch, commit, push
and read a review is not a session that can finish a pull request. The
GitKraken MCP server is how the sessions here do those things.

This part says what an MCP server is, installs this one, and walks one change
through the repository's real flow: a worktree, a commit, a push, a pull
request and the review loop that follows. It ends with what the server does
not do, which is merge.

## What you'll have at the end

| Piece | Result |
| --- | --- |
| A definition | What an MCP server is, in two paragraphs, and what "tools" means in that sentence |
| An installed server | GitKraken's MCP server wired into your coding session with `gk mcp install` |
| A tool inventory | What the session can now do to a repository and to its pull requests, named by what they do |
| One worked flow | A change taken from a worktree to a pushed branch and a reviewed pull request, the way this repository does it, naming which step is the server's and which is the GitHub CLI's |
| The boundary | What the review bots do, what the rules do, and why no tool in this part merges |

## What it costs

**Nothing for the server, and a plan for half of the tools.** The GitKraken
CLI is a free download, and its MCP documentation lists one prerequisite
before the install: the CLI "installed and authenticated (`gk auth login`)".
So this part, unlike
[part 1](https://docs.hybridcloudworks.com/content/blog-gitkraken-01-commit-graph/),
needs a GitKraken account. Which plan depends on which tools you use, and the
MCP tools reference (last updated March 2026, read 2026-10-20) draws the line
by section. The Git tools are "available on all plans; private remote
operations require Pro or higher", so steps 1 to 4 below run on any plan
against a public repository. The pull request tools "require Pro or higher",
and the issue tools require "Pro or higher for cloud issue trackers (GitHub
Issues, GitLab, Jira Cloud)", so step 6 does not. The GitLens tools "require a
GitLens plan". The author's plan comes with the Ambassador programme named at
the end of this article. The coding session itself is whatever you already
pay for.

---

## Why an MCP server, and why this one

### What an MCP server is

The Model Context Protocol is a way for an AI application to call code that
lives outside it. A **server** is a small program that lists what it can do
as named **tools**, each with typed inputs, and runs one when asked. The AI
application, called the **host** or **client**, reads that list at start-up,
and when the model decides a tool would help, the host runs it and hands the
result back as text or, in newer hosts, as a small rendered panel.

That is the whole mechanism. A server for git exposes tools whose inputs are
paths and branch names and whose outputs are what git would have printed. The
model never runs git itself; it asks, the host runs the tool, and the answer
comes back inside the conversation. The protocol is what lets one server
serve many hosts, which is why GitKraken's install command takes the host's
name as its argument.

### GitKraken's, because it covers both halves of a pull request

A session working this repository needs two kinds of tool. The first is git:
status, log, diff, branch, worktree, commit, push. The second is the hosting
platform: read a pull request and its reviews, read an issue. Most git
servers stop at the first half. GitKraken's tools reference lists git,
GitLens, issue and pull request sections together, so a session can take a
change from a worktree to a pushed branch and read the review that follows
through one server and one authentication. What the reference does not list,
opening the pull request and merging it among them, stays with the GitHub
CLI, and this part says so at each step.

The alternative is letting the session run `git` and `gh` as shell commands.
That works, and this repository's sessions did it for months. What a server
adds is a typed surface: the host knows what each tool is for, can show the
call before it runs, and can refuse a category of call without parsing shell
text. For a one-person platform where the session authors as the owner's own
account, a surface the host can see is worth more than one it has to guess at.

### Two rendered panels, for the host that can draw them

Two of the server's tools come with **MCP Apps**, which GitKraken's
documentation names **Git Status** and **Git Graph**: in a host that can
render them, the result arrives as a panel rather than text. Elsewhere, in the
documentation's words, "the base tool output appears normally."

---

## Prerequisites

- The GitKraken CLI, `gk`, installed and signed in with `gk auth login`.
- A coding session that can host an MCP server. GitKraken's MCP Apps page
  names `vscode`, `vscode-insiders` and `claude-desktop` as values the install
  command accepts, and offers `gk mcp config` for hosts it does not.
- A clone of a repository you can push to. The one from part 1 is public,
  so you can read it but not push; fork it, or use a repository of your own.

The repository facts below were read on 2026-10-20, and the server's install
command and app names are as GitKraken's documentation gave them the same
day. The tools are named by what they do, not by their identifiers, because
identifiers change between releases and verbs do not.

---

## The steps

### 1. Install the server into your host

PowerShell or bash, for VS Code:

```bash
gk mcp install vscode
```

The command writes the host's MCP configuration for you. For a host the
command does not know, `gk mcp config` followed by the host's name prints the
configuration to paste in. The documentation's own line for one terminal
host registers the server as a standard-input process:

```bash
claude mcp add -t stdio gitkraken gk mcp
```

**Verify:** restart the host, and its MCP server list shows the GitKraken
server under the name the install step gave it: `GitKraken` in VS Code,
`gitkraken` where you registered it by hand as above. The name is whatever
you or the installer wrote; what matters is that it is listed and answers.
Then use the documentation's own prompt for the status app,
"What changes are pending in the repo"; a host that can render apps shows the
Git Status panel, and one that cannot shows the same answer as text.

<!-- screenshot: the host's MCP server list with "gitkraken" present, and the Git Status panel open on a clean working tree -->

### 2. Read the inventory

Ask the session to list the server's tools, and read the list against
GitKraken's MCP tools reference, which groups them by section and says of
itself that it "will change over time as we add more tools and consolidate
the existing ones". As read on 2026-10-20:

- **Git**, on the repository: status; log or diff; blame; branch (list or
  create); checkout; worktree (list or add); stash; add or commit; push.
- **Repository**: read a file's content.
- **GitLens**: open Launchpad, open the commit composer, start work on an
  issue, start a review of a pull request. Each opens a worktree and a window
  and hands the task to an agent.
- **Issues**: the ones assigned to you, one issue's detail, and add a comment.
- **Pull requests**: the ones assigned to you, one pull request's detail, its
  comments, and create a review.
- **GitKraken**: list your workspaces.

Now mark what writes. On the repository side: creating a branch, adding a
worktree, staging (`add`), commit, push, stash, and checkout, which changes
the working tree. Several tools carry both a read and a write action (branch
lists or creates, worktree lists or adds, add-or-commit), so mark the action,
not the tool. On the platform side: the issue comment and the pull request
review. Everything else reads. And mark what is
not on the list at all: creating a pull request, replying on or resolving a
review thread, reading a check's status, and merging. This repository's
sessions do those with the GitHub CLI, which is why the steps below name
which tool does what.

**Verify:** you can name, for each tool, which section it is in and whether
it writes. If you cannot, do not let the session use it yet.

### 3. Start the change in a worktree

This repository's sessions never switch the main checkout's branch; each pull
request is built in its own git worktree, under `.claude/worktrees/`, which
the repository's
[`.vscode/settings.json`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.vscode/settings.json)
hides from the editor's file view and search. Ask the session to add a
worktree for a new branch from `origin/main`.

**Verify:** the worktree tool's answer names a new directory and a new branch,
and the main checkout is still on `main`. The git equivalent:

```bash
git worktree list
```

Two lines: the main checkout on `main` and the new one on your branch.

### 4. Make the change, read it back, commit

Edit in the worktree. Then ask for status and the diff before the commit, not
after: a session that commits without reading its own diff is the one that
commits the file it meant to leave out.

**Verify:** the commit tool's answer carries a new SHA, and the log tool shows
it as the branch's one commit above `origin/main`.

### 5. Push, then open the pull request with the GitHub CLI

Push with the push tool. Opening the pull request is not one of the server's
tools, so the session does it with `gh pr create`, the way it did before the
server was connected; the repository's
[`.claude/settings.json`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.claude/settings.json)
allows `gh pr` commands for exactly this. Two of the repository's agreements
apply here, and the session has to know them because no tool does. The
description follows
[`.github/pull_request_template.md`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/pull_request_template.md),
whose eight sections run from Summary to Author checklist. And the pull
request opens **ready for review, not as a draft**: an owner decision from
2026-09-05, after every session's pull request arrived as a draft and had to
be flipped from a phone.

**Verify:** the pull request exists, its body has the template's sections,
and it is not a draft.

<!-- screenshot: the new pull request's page with the template's eight headings visible in the description -->

### 6. Work the review loop

Now the repository does its part. CodeRabbit reviews every push on its own;
[`.coderabbit.yaml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.coderabbit.yaml)
turns on `auto_review`, and posts a request for changes while a finding is
open and an approval once every thread is resolved. CodeQL runs on every pull
request from
[`.github/workflows/codeql.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/workflows/codeql.yml)
and posts each alert as a review comment. The repository's ruleset requires
every review conversation resolved before a merge, so an informational
comment blocks the button as surely as a finding.

Ask the session to read the pull request with the server's detail and
comments tools: the verdict is in the review's body, the findings are the
inline comments. The check results and the threads' resolved state are not in
either tool; the session reads those with the GitHub CLI, as the working
agreements' own command lines do. Then it fixes each finding in the worktree,
commits and pushes with the server, and replies on each thread naming the
commit and resolves the thread through the GitHub API, because the server
has no tool for either. The working agreements cap this at three rounds per
bot.

**Verify:** every thread on the pull request is resolved, the required checks
are green on the current head, and CodeRabbit's latest review of that head
approves.

---

## How to know it worked

- The host lists the `gitkraken` server, and a status request answers.
- `git worktree list` shows the main checkout still on `main`.
- The pull request has the template's sections and is not a draft.
- Every review thread is resolved and the head's checks are green.
- Code scanning has no open alert on the head. A resolved thread does not
  close an alert, and the repository's rule is that nothing merges while one
  is open; read them with the GitHub CLI against the pull request's merge
  ref, and expect zero.

Then the merge, which is the step this part does not have a tool for. The
session merges with the GitHub CLI, when the current head carries an
approving review, green checks and no open code-scanning alert. The server made the worktree, the commits
and the push, and read the reviews; the GitHub CLI opened the pull request
and will merge it; the rules decided when it was done. Those are different
jobs, and keeping them in different hands is what makes a one-person
repository safe to automate.

---

## When it doesn't work

**`gk mcp install` does not know your host.** The install command covers a
short list; GitKraken's page names `vscode`, `vscode-insiders` and
`claude-desktop`. For anything else, `gk mcp config` with the host's name
prints the configuration, and you paste it where that host keeps its MCP
servers.

**The status tool answers with text and no panel.** The host cannot render
MCP Apps. The documentation is explicit that the base tool still works; only
the panel is missing. Nothing in the flow above needs the panel.

**The session commits in the main checkout.** It skipped step 3, or the
worktree tool answered with a path it then ignored. Move the commit to a
branch, reset the main checkout to `origin/main`, and start the worktree
again. The main checkout is the one the owner has open; a session that
switches its branch switches it under them.

**A review thread will not resolve.** It has not been answered. The ruleset
blocks the merge on an open thread of any kind; reply first, naming the
commit or the reason, then resolve. Never resolve to get past it.

---

## What's next

[Part 3](https://docs.hybridcloudworks.com/content/blog-gitkraken-03-stacked-prs/)
takes two of these pull requests that touch the same file, which in this
repository is nearly always `CHANGELOG.md`, and puts the repository's
one-conflict-at-a-time rule beside GitLens 19.3's Auto-Rebase Stack. The
links in this article point at the drafts on the documentation site; once an
article is published, it lives on hybridcloudworks.com under `/github/blog/`
and its title's slug.

The author is a GitKraken Ambassador; GitKraken did not review this article,
and the repository facts in it are the repository's own.

<!-- Sources, read 2026-10-20 (the CMS strips this comment):
  git log origin/main: 841 non-merge subjects ending "(#N)", 124 merge commits, first commit 2026-07-22, newest #1301; 90 days
  repository settings read with gh repo view on 2026-10-20: mergeCommitAllowed false, squashMergeAllowed true
  .vscode/settings.json: files.exclude, search.exclude, files.watcherExclude for **/.claude/worktrees
  CHANGELOG.md (entry near line 8342): ".claude/worktrees/ (agents' temporary checkouts)"
  .github/pull_request_template.md: eight "## " sections, Summary ... Author checklist
  .claude/CLAUDE.md: "Pull requests open ready for review, not as drafts" (owner decision 2026-09-05); review loop, three rounds per bot; conversation resolution
  .claude/settings.json: permissions allow Bash(git push *), Bash(gh pr *), Bash(gh api *): the sessions' shell git and gh use
  git log --merges: branches named HybridCloudWorks/claude/... and HybridCloudWorks/codex/... in August 2026 merge commits: evidence the pull requests were written in AI sessions
  .coderabbit.yaml: auto_review enabled, request_changes_workflow true, allow_author_approval false
  .github/workflows/codeql.yml: pull_request and push on main, weekly schedule
  not in the repository: help.gitkraken.com/mcp/mcp-apps/ (gk mcp install <client>, vscode / vscode-insiders / claude-desktop, gk mcp config, Git Status and Git Graph, prompt "What changes are pending in the repo", "If it does not, the base tool output appears normally", gk auth login prerequisite); help.gitkraken.com/cli/gk-cli-mcp/ (claude mcp add -t stdio gitkraken gk mcp)
  not in the repository: help.gitkraken.com/mcp/mcp-tools-reference/ (last updated March 2026, read 2026-10-20): the tool list in step 2 is that page's, section by section, and its plan lines are quoted in "What it costs"; the page lists no tool that creates a pull request, replies on or resolves a review thread, reads checks, or merges
  not verified from the repository: that the site's sessions have the GitKraken MCP server connected; no .mcp.json or MCP configuration is tracked in the repository. The GitHub CLI steps are supported by .claude/settings.json's gh permissions and the working agreements' command lines.
  not verified from the repository: the rule that every pull request is built in its own worktree is not written in a tracked file; the evidence is the .vscode exclusion, the CHANGELOG entry and the sessions' practice
-->

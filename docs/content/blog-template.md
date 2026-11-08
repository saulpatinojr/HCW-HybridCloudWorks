# Blog template — two tracks, one voice

Everything in the series follows this. It exists so the posts read as one
publication, and so writing the next one is easier than the last.

There are **two tracks**. Every subject gets both, because they answer different
questions for different readers.

| Track | Answers | Reader | Voice |
| --- | --- | --- | --- |
| **How-to** | *What do I build, why that, and how?* | Someone about to do this | Instructional, present tense, second person |
| **Build log** | *What actually happened when you did it?* | Someone in the middle of it, stuck | Narrative, past tense, first person |

The how-to is the recipe. The build log is what the kitchen looked like
afterwards. Publish the how-to first — it is the reference — and the build log
as its companion.

---

## Naming: use generic names, always

**No real tenant, org, domain, subscription or resource names.** Not because
they are secret, but because a reader copying a snippet with your resource
names in it gets an error and does not know which parts to change.

The scheme below is used identically in every post. Readers learn it once.

| Thing | Use | Never |
| --- | --- | --- |
| Organisation | `acme` | a real org |
| Repository | `acme/platform` | a real repo |
| Domain | `example.com` | a real domain |
| API hostname | `api.example.com` | a real hostname |
| Workload token | `app` | a product name |
| Function App | `func-app-prod-cus-01` | a real app name |
| Key Vault | `kv-app-prod-cus-01` | |
| Cosmos account | `cosmos-app-prod-cus` | |
| Storage accounts | `stappprodcus01`, `stappfuncprodcus01` | |
| Resource groups | `rg-<category>-app-prod-cus` | |
| Identities | `id-plat-terraform-prod-cus-01`, `id-app-github-deploy-prod-cus-01` | |
| Subscription / tenant / object IDs | `<subscription-id>`, `<tenant-id>`, `<org-id>` | a real GUID, ever |

**Two things stay real**, because genericising them destroys the point:

- **Azure region names.** The lesson about region availability is only testable
  if the reader can run the command and see the same answer. Regions are Azure's
  product facts, not your environment.
- **Error codes and error text.** `AADSTS700213` is the string a reader will
  paste into a search box at 11pm. That is the whole value.

---

## Track 1 — How-to

### Shape

1. **What you'll have at the end.** One paragraph and a resource list. The
   reader decides here whether to keep reading.
2. **What it costs.** A real number, or a ceiling. Cost is an architectural
   input, not a footnote.
3. **Why these services.** The section that makes it worth reading rather than
   skimming — see below.
4. **Prerequisites.** Exactly what must exist first, and what must *not*.
5. **The steps.** Numbered, each one runnable, each ending in something you can
   verify.
6. **How to know it worked.** Commands and expected output, not "you should now
   see…".
7. **What to do when it doesn't.** The three or four most likely failures and
   what they actually mean.

### The "why these services" section

This is the difference between a how-to and documentation. For every service,
state the alternative you rejected and the constraint that decided it:

> Flex Consumption rather than Elastic Premium, because Premium bills for
> always-on instances and the budget is $150/month total.

Never justify a choice with "best practice" or "recommended". Name the
constraint. If you cannot, the choice was arbitrary and the reader should know
that too.

### Steps

Every step is copy-pasteable and ends in a check:

````markdown
### 3. Create the deployment identity

```bash
./scripts/bootstrap.ps1 -WhatIf   # preview, changes nothing
./scripts/bootstrap.ps1
```

**Verify:** `az identity show -n id-plat-terraform-prod-cus-01 -g rg-mgmt-boot-prod-cus`
returns a `clientId`. Note it — the next step needs it.
````

A step with nothing to verify is not a step, it is a sentence.

---

## Track 2 — Build log

### Shape

1. **Open with the number or the error.** The first sentence should be
   something only this project could say.
2. **The setup, briefly.** What we were doing and the one constraint that made
   it interesting. An unlimited budget produces no decisions worth reading.
3. **Three to five things that went wrong, in order.** The body of the post.
   Each one gets:
   - what we expected
   - what happened, with the real error text
   - **why the error pointed somewhere other than the cause**
   - what we changed
4. **What I'd do differently.** If the answer is "nothing, that was the cost of
   finding out", say that rather than inventing a lesson.
5. **Where it stands**, ending with what is *not* done.

The third bullet in (3) is the one readers remember and the reason the post
exists. An error that names its own cause is not worth writing about.

---

## Voice, both tracks

**Do**

- Real numbers, real error strings, real commands.
- Say what you rejected, not only what you chose.
- Admit the self-inflicted failures. They are the most useful and the most
  credible part of any build log.
- Short paragraphs. Let a one-line paragraph carry a turn.
- Explain the *shape* of a failure — "it failed in a way that looked like a
  permissions problem" is the transferable part.

**Don't**

- No "seamless", "robust", "leverage", "journey", "unlock", "game-changing".
- No emoji as section markers.
- No list where a sentence works. Lists are for genuinely parallel things.
- No conclusion that restates the introduction.
- No screenshots of terminal text. Paste the text.

**Tense and person.** How-to: present tense, second person ("you"), imperative
in steps. Build log: past tense, first person. Do not mix them within a post.

---

## The three technologies, made concrete

Every post should make all three tangible rather than name-checking them:

| | Show this | Not this |
| --- | --- | --- |
| **Terraform** | Real plan output, resource counts, a guard that fired, what state knew that reality didn't | "We used infrastructure as code" |
| **Azure** | The specific service and its specific limit — region availability, name scope, quota, which RBAC plane | "We deployed to Azure" |
| **GitHub** | Actions, OIDC subject claims, workflow gates, what is *not* stored anywhere | "CI/CD pipeline" |

---

## Front matter

```yaml
title:      # A claim or a number, not a topic. Six words or fewer.
subtitle:   # One sentence naming what actually happens here.
date:
track:      # how-to | build-log
part:       # n of N
tags:       # azure, terraform, github-actions, iac
reading:    # minutes
```

Articles are now written on the site, in **Admin → Drafts**
(`/admin/drafts`): the editor has a field for each key above, the markdown
body, and a live preview, and a save is instant from any device. **Send to In
Review** puts the article on the Content Queue; nothing is published from the
Drafts page.

A draft written somewhere else comes in through **Paste or upload a markdown
draft** on the same page: choose one or more `.md` files from the private
vault, or paste one draft into the box. Each file is in the format this page
describes, front matter first and then the article, and becomes a draft;
nothing is published. A second upload of an article with the same title is
reported as already present rather than saved again. **After the upload, the
Drafts page is the source of truth:** a later edit to the file does not reach
the site.

Drafts never live in this repository, which is public. There is no longer an
import from `docs/content` (the route that read files from `main` was
removed), and the only `blog-*.md` files here are this template and
`blog-machine.md`, which describe how articles are written and contain no
article text.

## Code blocks

Real output, trimmed but never invented. Inline `code` for identifiers,
resource names, variables and error codes.

Never paste a secret, subscription id, tenant id, or token — not even a
redacted one. Use the placeholder scheme above.

### A pricing scenario in a post

One fence language is not code. A block whose language is `pricing-scenario`
and whose body is a scenario query string from `/tools/comparison` renders as
that page's scenario card, read-only — the bars, the totals, the breakdown —
with an "Open in the comparison tool" link, priced from the same daily cache
the tool reads:

````markdown
```pricing-scenario
scenario=three-tier-web&extras=backup,dr-warm-standby&egress=1000&region=us-east-1
```
````

The body is what **Copy link** on the tool puts on the clipboard, minus the
host and path. An unknown scenario or extra falls back the way the tool's URL
does, and a region the tool does not know falls back to `us-east-1`.

### A landing zone in a post

The same shape for the Landing Zone Builder. A block whose language is
`landing-zone` and whose body is a build's query string from
`/tools/landing-zone` renders as a read-only card: the diagram, the selected
components with a line each, and an "Open in the Landing Zone Builder" link
that carries the same build:

````markdown
```landing-zone
lz=mg,policy,mgmt,hub,fw&corp=2
```
````

The body is what **Copy link** on the builder puts on the clipboard, minus the
host and path; a bare body is the full default build. `lz=` lists the platform
components by short id (`mg`, `policy`, `mgmt`, `hub`, `fw`, `id`), `corp=` and
`online=` count the landing zones, and the knobs travel as `hub.cidr`,
`spoke.cidr`, `fw.sku`, `dns`, `loc` and `root`. The card normalises the way
the tool does: a component named without what it needs brings its dependencies
along, an unknown token is dropped, and a knob that fails its check is its
default. Nothing is fetched; the card is drawn from the fence alone.

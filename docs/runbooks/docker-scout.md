# Docker Scout — checking the add-on images

> **Status: in use from 2026-10-25.** Written when the owner moved the add-on
> images to the `img-…` Docker Hub repositories and asked how to use what the
> Docker plan includes. Facts here were read on that day; each says where.

**Scope:** how the three tool add-on images (migration, network assessment,
cloud assessment) are checked for known vulnerabilities and policy problems,
where each check runs, and how to run Scout on your own desktop.

**Authority:** this page does not authorize a change. Turning Scout on for a
repository, and storing a Docker token anywhere, are the owner's decisions.

## What you have

- **The plan.** Docker Team, one seat, with *Docker Scout-enabled
  repositories: Unlimited* (the owner's Docker billing page, 2026-10-25;
  [Docker's plan FAQ](https://www.docker.com/pricing/faq/) says the same of
  Team). So there is no cost to enabling Scout on every repository.
- **The images.** `hybridcloudworks/img-mo-lab-addon`, `img-ne-lab-addon` and
  `img-ca-lab-addon` on Docker Hub. The lab host runs each by digest, and the
  digests are in `lab-host/ansible/group_vars/all.yml`.
- **What Scout is.** A service that reads an image's list of packages (its
  SBOM, which these images carry as an attestation), compares it with a
  vulnerability database, and grades it against policies
  ([Docker Scout](https://docs.docker.com/scout/),
  [policies](https://docs.docker.com/scout/policy/)).

## Five checks, and which one is for what

| Check | Where it runs | When | What it does |
| --- | --- | --- | --- |
| Trivy before publishing | each add-on repository's `publish-images.yml` | on a release tag | stops the push when the image has a HIGH or CRITICAL vulnerability with a fix |
| **Lab supply chain** (`lab-supply-chain.yml`, the scan step) | this repository | every Tuesday | looks again at the digests the host actually runs, the two lab images **and the three add-on images**, with Trivy; opens one issue, or comments on the open one, when something fixable turns up |
| **Add-on images against Docker Scout** (`addon-image-scout.yml`) | this repository | when a pull request changes the pins, and every Wednesday | Scout's policy table for the same digests, then fails on a fixable CRITICAL or HIGH; needs the one Docker token below |
| Scout's own analysis of a Docker Hub repository | Docker | continuously, once the owner enables it | shows every tag's findings and policy results in the Scout dashboard and in Docker Hub |
| `docker scout` on your desktop | your machine | when you run it | the same Scout analysis on demand, for a published image or one you just built |

The first runs only when an image is built. The advisory database moves after
that, which is why the others exist: an add-on digest nobody touches is never
rebuilt. Trivy (the second row) and Scout (the third) read the same digests and
are deliberately both there: Trivy needs no credential and opens the issue;
Scout adds its policies (non-root user, attestations, outdated base image) and
needs the token.

## Scout in CI, and the one Docker token it needs

Scout only answers a signed-in Docker user. Both ways of running it in GitHub
Actions without one were tried on 2026-10-25 and both stopped:

- `docker/scout-action` v1.27.0: `could not authenticate: user githubactions not
  entitled to use Docker Scout` (run 40166549204);
- the Scout command line, installed as a pinned binary on a clean runner:
  `Log in with your Docker ID or email address to use docker scout` (run
  40166753167).

(An earlier version of this page said Scout needed no login. That was wrong: the
desktop test that seemed to show it ran on a machine where Docker Desktop is
signed in, which an empty Docker config folder does not undo.)

The OIDC connections the publish workflows use cannot stand in: they carry only
image pull and push, reading public repositories and Build Cloud connection
([rulesets and scopes](https://docs.docker.com/security/authentication/oidc-connections/rulesets-claims/)).
So the owner decided on 2026-10-25 (issue
[#1367](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1367)) to
store **one** Docker credential, in this repository only, used by one workflow
(`addon-image-scout.yml`), which Docker's own
[GitHub Action template](https://github.com/docker/scout-cli#github-action)
also does (a Docker user name and a personal access token).

**What the workflow does with it.** It reads the token in two places only (the
step that checks it is set, and the action's password input), holds
`contents: read` and nothing else, is skipped for a pull request from a fork
(GitHub gives those no secrets), and does not post pull request comments. A
test, `scripts/addon-image-scout-workflow.test.mjs`, pins each of those.

**What a missing token looks like.** On a pull request it is a warning and the
Scout steps are skipped. On the Wednesday run and a manual run it is an error
and the run is red, so a check that never ran cannot look green.

### Create the token (once)

1. Open <https://app.docker.com/> and sign in as the Docker user that holds the
   Team seat (the Docker ID shown as the creator of your connections,
   `saulpatinojr`).
2. Open your avatar menu, then **Account settings**, then **Personal access
   tokens**, then **Generate new token**
   ([Docker's steps](https://docs.docker.com/security/access-tokens/personal-access-tokens/)).
3. Description: `hcw-github-scout`. Expiration: one year, and put the date in
   your calendar (an expired token turns the Wednesday run red, which is how you
   would find out).
4. Permission: **Repo Public Read-only**, the lowest, which is enough for the
   three public add-on images. Docker says a token applies to every repository
   the account can reach and cannot be limited to one, which is why it is read
   only.
5. Click **Generate** and keep the page open: Docker shows the token once.

### Store it (once), in PowerShell

The Docker ID is not secret, so it is a variable. The second command asks for
the token and hides what you paste, so it never appears on a command line:

```powershell
gh variable set DOCKER_SCOUT_USER --repo saulpatinojr/HCW-HybridCloudWorks --body saulpatinojr
```

```powershell
gh secret set DOCKER_SCOUT_PAT --repo saulpatinojr/HCW-HybridCloudWorks
```

Expected: the second command prints a prompt, accepts the pasted token, and
ends with a line saying the secret was set. Then run the check once, from
**Actions**, **Add-on images against Docker Scout**, **Run workflow**, and read
the three **Scout** jobs: a green job with a policy table in its summary means
it works.

If a job says `not entitled to use Docker Scout` even with the token, that is
about the Docker *user*, not about how much the token may read, so do not widen
the token. Check, in this order: that `DOCKER_SCOUT_USER` is the Docker ID that
holds the Team seat; that the token was generated while signed in as that ID and
has not expired or been deleted in Docker; and that the same ID can run
`docker scout quickview` on your desktop. **Repo Read-only** would also reach the
account's private repositories, so it is only worth trying if Docker's message
names a repository-permission failure, and then say so on #1367.

### Rotate or remove it

Generate a new token the same way, run the second command again to replace the
secret, then delete the old token in Docker. To remove Scout from CI, delete the
secret and the variable (`gh secret delete DOCKER_SCOUT_PAT --repo
saulpatinojr/HCW-HybridCloudWorks`) and the workflow file; nothing else depends
on them.

## Turn Scout on (the owner's step)

In PowerShell on your desktop, signed in to Docker as an organisation admin:

```powershell
docker scout repo enable --org hybridcloudworks --all
```

Expected: it lists the repositories it enabled. Check it at
<https://scout.docker.com/settings/repos>, which shows the enabled
repositories against the plan's limit. New repositories are not enabled
automatically: run the command again after adding one. The command is
documented at
[docker scout repo enable](https://docs.docker.com/reference/cli/docker/scout/repo/enable/).

To do one repository by clicking: open <https://hub.docker.com/> and sign in,
then **My Hub**, **Repositories**, the repository, **Settings**, then under **Image security insight settings**
choose **Docker Scout image analysis** and **Save**
([Docker's steps](https://docs.docker.com/docker-hub/repos/manage/vulnerability-scanning/)).
Docker publishes no deeper link than those pages.

## Check an image on your desktop

Docker Desktop's command line already has Scout (`docker scout version` prints
it), and it works while Docker Desktop is signed in to your Docker account. If
one answers `Log in with your Docker ID`, sign in to Docker Desktop and run it
again.

**What "read-only" does and does not mean.** These commands change nothing in
the image or the registry. They do send data to Docker. For an image built on
your own machine (`local://`), Scout transmits only package URLs and layer
digests, and Docker says it does not keep them. For a published image, Docker
describes its analysis as collecting the image's metadata and package list
(SBOM) and storing them on its platform, in the US; its page does not say
whether a one-off `registry://` command from a desktop does the same
([Docker Scout data handling](https://docs.docker.com/scout/deep-dive/data-handling/)).
The three add-on images are public, so what could be stored is already public.

A published image, by tag:

```powershell
docker scout quickview registry://docker.io/hybridcloudworks/img-mo-lab-addon:v0.3.1
```

Only the vulnerabilities that have a fix, critical and high:

```powershell
docker scout cves --only-fixed --only-severity critical,high registry://docker.io/hybridcloudworks/img-mo-lab-addon:v0.3.1
```

What would fix the base image:

```powershell
docker scout recommendations registry://docker.io/hybridcloudworks/img-mo-lab-addon:v0.3.1
```

What changed between two versions (Docker marks `compare` experimental):

```powershell
docker scout compare --to registry://docker.io/hybridcloudworks/img-mo-lab-addon:v0.3.0 registry://docker.io/hybridcloudworks/img-mo-lab-addon:v0.3.1 --only-severity critical,high --ignore-unchanged
```

An image you just built on this desktop, before you push it (run it from the
add-on repository's folder; the tag is yours to choose):

```powershell
docker build -t addon-try -f infrastructure/docker/Dockerfile.lab . ; if ($LASTEXITCODE -eq 0) { docker scout quickview local://addon-try }
```

The `if` is there because PowerShell runs what follows a `;` even when the build
failed, and an `addon-try` left from an earlier build would then be inspected
instead of the one you meant.

That is the migration add-on's Dockerfile; in the network assessment and cloud
assessment repositories it is `infrastructure/docker/Dockerfile`. `local://`
means *the image in this desktop's own store, no registry lookup*;
`registry://` the opposite (`docker scout quickview --help` lists the others).

## Reading the result

- **Health score** (A to F) and **policies met**. The three published images
  read A (94%) with 6 of 7 policies on 2026-10-25.
- **"Copyleft licensed packages found"** is the one that fails, on every
  Debian-based image: it counts the licences of the base operating system's own
  packages (243 on the migration image, 273 on the other two). It is a licence
  flag, not a vulnerability. The owner decided on 2026-10-25 to leave it as it
  is ([#1367](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1367#issuecomment-6398552231)).
- **"No fixable critical or high vulnerabilities"** is the one that matters for
  safety. A finding with no fix available yet (the migration image has eight
  high ones in the Debian base) is shown but does not fail it: nothing can be
  done until Debian ships a fix, and a newer base digest arrives with the next
  release. Checked by hand: `docker scout cves --only-fixed … --exit-code`
  exits 0 on the three published images and 2 on `node:18-bullseye-slim`.
- **"Supply chain attestations"** and **"No outdated base images"** need the
  image's SBOM and provenance, which the publish workflows attach. Scout
  suggests building with maximum provenance for exact base-image detection; that
  is on #1367 and has not been changed.

## What is deliberately not set up

- **Scout environments** (Scout's record of which image runs where, the
  **Configure an environment** guide in the Scout dashboard). Recording an image
  into one is a write to the owner's Scout organisation, and the token above is
  read-only, so it is not set up. The weekly checks already name the digests the
  host runs.
- **A required status check.** Neither the Scout check nor the weekly scan is one
  of the ruleset's required checks; the weekly scan opens an issue and the Scout
  check shows red, and neither blocks a merge. Making one required is the owner's
  decision.

## Docker Hub housekeeping

Docker marks an image **Stale** after six months without a pull and deletes
nothing by itself; deletion is manual, in the repository's **Image Management**
tab (**Preview and delete**), or through an API, and an image with an immutable
tag cannot be deleted
([Image Management](https://docs.docker.com/docker-hub/repos/manage/hub-images/manage/)).
The proposed rule, not yet decided (#1367): keep every digest `group_vars/all.yml`
pins, the previous pin for rollback, and the newest release; delete the rest
only when stale, and only by hand. On the lab host, old lab images are removed
by each bootstrap run; old add-on images are not, and at 9% of the disk (read
2026-10-25) there is no need yet.

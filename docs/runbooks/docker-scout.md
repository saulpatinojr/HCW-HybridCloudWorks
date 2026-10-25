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

## Four checks, and which one is for what

| Check | Where it runs | When | What it does |
| --- | --- | --- | --- |
| Trivy before publishing | each add-on repository's `publish-images.yml` | on a release tag | stops the push when the image has a HIGH or CRITICAL vulnerability with a fix |
| **Lab supply chain** (`lab-supply-chain.yml`, the scan step) | this repository | every Tuesday | looks again at the digests the host actually runs, the two lab images **and the three add-on images**, with Trivy; opens one issue, or comments on the open one, when something fixable turns up |
| Scout's own analysis of a Docker Hub repository | Docker | continuously, once the owner enables it | shows every tag's findings and policy results in the Scout dashboard and in Docker Hub |
| `docker scout` on your desktop | your machine | when you run it | the same Scout analysis on demand, for a published image or one you just built |

The first runs only when an image is built. The advisory database moves after
that, which is why the second exists: an add-on digest nobody touches is never
rebuilt. There is no scan when a pull request changes a pin; the image was
scanned at publish, and the next Tuesday run looks again.

## Why Scout is not in CI

Scout only answers a signed-in Docker user. Both ways of running it in GitHub
Actions were tried on 2026-10-25 and both stopped:

- `docker/scout-action` v1.27.0: `could not authenticate: user githubactions not
  entitled to use Docker Scout` (run 40166549204);
- the Scout command line, installed as a pinned binary on a clean runner:
  `Log in with your Docker ID or email address to use docker scout` (run
  40166753167).

(An earlier version of this page said Scout needed no login. That was wrong: the
desktop test that seemed to show it ran on a machine where Docker Desktop is
signed in, which an empty Docker config folder does not undo.)

So Scout in CI needs a Docker access token for an entitled user stored as a
GitHub secret. The OIDC connections the publish workflows use cannot stand in:
they carry only image pull and push, reading public repositories and Build Cloud
connection
([rulesets and scopes](https://docs.docker.com/security/authentication/oidc-connections/rulesets-claims/)).
The repository avoids a second home for a credential, and Trivy already gives
the vulnerability gate, so this page recommends **not** storing a token for it.
If the owner wants Scout's policy table in CI after all, that is a decision for
issue [#1367](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1367):
create a read-only personal access token in Docker
([Access tokens](https://docs.docker.com/security/access-tokens/)), store it as
one repository secret, and run the action with it. Nothing here does that.

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

To do one repository by clicking: Docker Hub, **My Hub**, **Repositories**,
the repository, **Settings**, then under **Image security insight settings**
choose **Docker Scout image analysis** and **Save**
([Docker's steps](https://docs.docker.com/docker-hub/repos/manage/vulnerability-scanning/)).
Docker publishes no deeper link than those pages.

## Check an image on your desktop

Docker Desktop's command line already has Scout (`docker scout version` prints
it), and it works while Docker Desktop is signed in to your Docker account. The
commands only read. If one answers `Log in with your Docker ID`, sign in to
Docker Desktop and run it again.

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
docker build -t addon-try -f infrastructure/docker/Dockerfile.lab . ; docker scout quickview local://addon-try
```

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
  flag, not a vulnerability. Whether to loosen it is open on #1367.
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
  into one from CI needs the same stored Docker token, so it is not set up. The
  weekly scan already names the digests the host runs.
- **A required status check.** The weekly scan opens an issue; it blocks no merge.

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

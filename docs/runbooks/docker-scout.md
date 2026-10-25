# Docker Scout — checking the add-on images

> **Status: in use from 2026-10-25.** Written when the owner moved the add-on
> images to the `img-…` Docker Hub repositories and asked how to use what the
> Docker plan includes. Facts here were read on that day; each says where.

**Scope:** how the three tool add-on images (migration, network assessment,
cloud assessment) are checked for known vulnerabilities and policy problems,
where each check runs, and how to run the same check on your own desktop.

**Authority:** this page does not authorize a change. Turning Scout on for a
repository is the owner's step in Docker; nothing in the repository does it.

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
| **Add-on images against Docker Scout** | this repository, `.github/workflows/addon-image-scout.yml` | when a pull request changes the pins, and every Wednesday | looks again at the digests the host actually runs: policy table, then fails on a fixable CRITICAL or HIGH |
| Lab supply chain | this repository, `lab-supply-chain.yml` | every Tuesday | the same idea with Trivy, for the two lab images (`hcw-lab`, `hcw-lab-runner`); opens an issue when something is due |
| Scout's own analysis of a Docker Hub repository | Docker | continuously, once enabled | shows every tag's findings in the Scout dashboard and Docker Hub |

The first runs only when an image is built. The advisory database moves after
that, which is why the second and fourth exist.

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
it). These read only, and the images are public, so no sign-in is needed.

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

`local://` means *the image in this desktop's own store, no registry lookup*;
`registry://` the opposite (`docker scout quickview --help` lists the others).
That is the migration add-on's Dockerfile; in the network assessment and cloud
assessment repositories it is `infrastructure/docker/Dockerfile`.

## Reading the result

- **Health score** (A to F) and **policies met**. The three published images
  read A (94%) with 6 of 7 policies on 2026-10-25.
- **"Copyleft licensed packages found"** is the one that fails, on every
  Debian-based image: it counts the licences of the base operating system's own
  packages (243 on the migration image, 273 on the other two). It is a licence
  flag, not a vulnerability, so the workflow shows it and does not fail on it.
  Whether to loosen it is open on issue
  [#1367](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1367).
- **"No fixable critical or high vulnerabilities"** is the one the workflow
  fails on. A finding with no fix available yet (the migration image has eight
  high ones in the Debian base) is shown but does not fail it: nothing can be
  done until Debian ships a fix, and a newer base digest arrives with the next
  release.
- **"Supply chain attestations"** and **"No outdated base images"** need the
  image's SBOM and provenance, which the publish workflows attach. Scout
  suggests building with maximum provenance for exact base-image detection; that
  is on #1367 and has not been changed.

## What is deliberately not set up

- **Environments** (Scout's record of which image runs where, the **Configure an
  environment** guide in the Scout dashboard). Recording an image into one from
  CI needs a stored Docker access token, and the OIDC connections used for
  publishing carry only image pull and push, reading public repositories and
  Build Cloud connection, so they cannot do it
  ([rulesets and scopes](https://docs.docker.com/security/authentication/oidc-connections/rulesets-claims/)).
  A token in GitHub would be a second home for a credential, which this
  repository avoids. The weekly check already names the digests the host runs.
- **`docker/scout-action`.** The first version of the workflow used it and every
  run failed with "could not authenticate: user githubactions not entitled to use
  Docker Scout" (run 40166549204, 2026-10-25): the action signs in to Scout as a
  Docker user, which would mean a Docker token stored in GitHub. The workflow
  runs the Scout command line instead, as a pinned release binary whose checksum
  is held in the workflow, and that needs no login for public images.
- **Pull request comments**, for the same reason the job holds `contents: read`
  only: a comment would need `pull-requests: write`, and the job summary carries the same table.
- **Blocking merges.** The check is not one of the ruleset's required checks;
  making it required is the owner's call.

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

# lab_images

Holds every digest-pinned lab image on the host before a job needs it, and
removes the digests no pin names any more. It runs straight after
`labs_agent` in `site.yml`, because the plan runs on the Node.js that role
installs and reads the checkout it makes.

## Why

The first public "Validate on the lab" job on the live host, on 2026-09-28,
spent its opening seconds pulling the `hcw-lab-runner` image (about 320 MB):
the visitor waited for a first-time download and the job log filled with
pull lines. `docker run` pulls a missing image implicitly, and the runner's
timeout (`timeoutSeconds` plus a 15-second grace, `lib/docker-runner.js`)
covers that pull too. Every image is pinned by digest in the repository, so
the host can hold them before any job asks.

## What it does

1. **Reads the pins, never a copy of them.** `files/lab-images.mjs` runs on
   the host's `node` and, for each checkout in `lab_images_checkouts`,
   imports `vps-agent/lib/capabilities.js` and takes every value of
   `IMAGES`, so Node itself parses the file and whatever the module exports
   is what the host holds. It also reads the Coder workspace image of every
   template under `lab-host/coder/templates`, from the `image_digest` local
   in each `main.tf` and the local built from it: `image` in `hcw-lab`,
   `default_image` in the guided labs (`amo-guided-lab`, `na-guided-lab`).
   Two templates on one digest are one pull. A pin bump in any of these
   files reaches the host on the next `bootstrap.sh` run with no edit here.
   `scripts/lab-images.test.mjs` holds the helper to the files as they are
   in the repository, and holds every template's pinned image to the sandbox
   plan, so a change of shape that the helper cannot read, or a template it
   does not plan, fails CI rather than the host. Until #1268 it read
   `hcw-lab` alone, and the guided labs' first workspace pulled 2.75 GB while
   the visitor waited.
2. **Refuses a pin that is not a digest.** Every pin must be
   `name[:tag]@sha256:<64 hex>`; anything else fails the play at the plan
   step, naming the entry (`IMAGES.alpine in .../capabilities.js is ...`).
3. **Pulls by `repository@digest`**, with
   `community.docker.docker_image_pull` and `pull: not_present`: every
   capability image into the host daemon, which runs the jobs, and every
   template's workspace image into the `coder_sandbox` daemon, which runs
   the workspaces, while `lab_images_pull_workspace` is true (it defaults to
   `coder_enabled`). Since 2026-10-07 (LAB-5) the plan runs once per
   daemon, `--scope jobs` against the host's listing and `--scope
   workspaces` against the sandbox's, and each daemon's pins are its own
   images only. A digest already there is `ok`, with no registry call. The tag is
   dropped from the pull because Docker ignores the tag of a reference that
   carries a digest, and because the module splits `name:tag@digest` at the
   `@` and then looks for a repository literally named `name:tag`, so the
   tagged form would pull on every run. A pull that fails fails the play
   with the image as the item label.
4. **Removes what no pin names**, in the lab's own repositories only: the
   repositories the pins name (today `alpine`,
   `docker.io/hybridcloudworks/hcw-lab-runner` and
   `docker.io/hybridcloudworks/hcw-lab`) and anything else under
   `hybridcloudworks/hcw-lab*` on Docker Hub or the former
   `ghcr.io/hybridcloudworks/hcw-lab*`, which is how the images pulled from
   GHCR before 2026-10-08 leave the host. An image is removed when none of its
   references is a pin: each of its references in those repositories goes,
   tags before digests, with `docker image rm`. A reference in any other
   repository is never listed, so an image that also carries one keeps its
   data, and no image outside those repositories is touched. A workspace
   image left on the host daemon is removed there (it is not that daemon's
   pin), and a capability image would be removed from the sandbox daemon
   the same way (unless workspace cleanup is deferred; see item 6 below).
5. **Keeps an image a container still uses**, running or stopped (a job in
   flight on the old digest, a Coder workspace on an older template
   version), and prints which container holds it. The next run removes it.
6. **Defers workspace image cleanup when template publication is skipped.**
   When Coder template publication is skipped (e.g. the rotation credential is
   missing or refused, exit 3), the active template version in Coder still
   names the previous image digest. In this state, the role pulls the newly
   pinned workspace image but defers removal of superseded workspace images on
   the sandbox daemon (`lab_images_defer_workspace_cleanup` /
   `coder_template_publication_skipped`), degrading cleanly to "old image
   still runs" rather than breaking workspace starts (Issue #1134).

The removal is the Docker CLI rather than a module because community.docker
5.3.0's `docker_image_remove` and `docker_image` rebuild a digest reference
as `name:sha256:...`, which Docker 29.8 refuses with `invalid reference
format`, and removing by image id would also drop references in other
repositories. The plan lists only references Docker reported a moment
before, so each removal is a real change; one that has vanished since
(`No such image`) or that a container started on since (`is using its
referenced image`) is left for the next run instead of failing this one.

## Two checkouts

`lab_images_checkouts` defaults to the playbook's own checkout
(`/opt/hcw-src`) and the agent's (`labs_agent_home`, `/opt/hcw-labs-agent`).
They are the same commit on every plain run. While `-e
labs_agent_repo_ref=<sha>` holds the agent at another commit
(`lab-host/README.md`, "Re-running"), both commits' pins are pulled and
kept, so the held agent keeps its images; the next plain run returns the
agent to the playbook's commit and removes what only the hold needed.

## Does the runner use a present image without a registry call?

Yes. `buildDockerArgs` in `vps-agent/lib/docker-runner.js` passes no
`--pull`, so `docker run` takes Docker's default, `--pull=missing`, and a
digest reference already on the host runs without contacting the registry.
The runner names the image exactly as `IMAGES` writes it
(`name:tag@sha256:...`), and Docker resolves that by the digest, which is
the reference this role pulled. The container run for this role checked it
with the test host's network cut off (`CHANGELOG.md`).

## Check mode

Safe. The Docker listing and the plan are read-only and run in check mode;
`docker_image_pull` reports what it would pull without pulling, and the
removal, a command, is skipped. Check mode reads the playbook's checkout at
the commit the run would apply, so a bumped pin shows as a pull. It cannot
show the removal of the digest that pin replaces while the agent's checkout
is still at the old commit, because that checkout still pins it; the real
run moves the checkout first and then removes it.

## Variables

`lab_images_checkouts`, `lab_images_pull_workspace`,
`lab_images_defer_workspace_cleanup`,
`lab_images_sandbox_docker_host` and `lab_images_node`, in
`defaults/main.yml`; `meta/argument_specs.yml` is the contract. Nothing
here is a pin: the pins are `capabilities.js` and each template's `main.tf`
above.

/**
 * Capability allowlist — the ONLY commands this agent will ever run.
 *
 * Each capability maps a job `type` to a fixed Docker image + command
 * template. The job payload is NEVER interpolated into a shell string;
 * it is written into an isolated workspace directory (one file for a `text`
 * payload, an unpacked tree for a `tar` payload — lib/docker-runner.js) which
 * is bind-mounted read-only into the container. The container command is
 * passed to Docker as an argv array (no shell parsing of user input).
 *
 * To add a capability: add an entry here AND to LAB_JOB_TYPES in
 * functions/src/lib/labs.js (LAB_JOB_TYPES, the server-side enqueue allowlist)
 * AND to FALLBACK_JOB_TYPES in frontend/src/components/admin/labs/labsView.js
 * (the admin console's list when the snapshot has not arrived) AND to the
 * agent's `capabilities` array in its lab_agents registry document, which is
 * what the API actually authorizes claims against.
 *
 * ===========================================================================
 * IMAGES ARE PINNED BY DIGEST, NOT BY TAG (T-759)
 * ===========================================================================
 * Every image below carries `tag@sha256:...`. Docker resolves the digest and
 * ignores the tag, so the tag is there only to say which release the digest
 * corresponds to — it has no effect on what runs.
 *
 * This matters more here than in most places. `docker run` pulls implicitly,
 * and `--network none` applies to the *container*, not to the pull: the image
 * is fetched over the network before any sandbox flag takes effect. A tag is
 * mutable, so with `alpine:3.24.2` alone, whoever can repush that tag changes
 * what executes on the VPS with no commit, no review and no signal anywhere in
 * this repository. A digest is content-addressed — a repushed tag simply stops
 * matching, and the pull fails loudly instead of succeeding quietly.
 *
 * `capabilities.test.js` asserts every entry carries one, so a capability
 * added without a digest fails the gate rather than shipping.
 *
 * **Every image here has a floor** (#715). scripts/version-floors.test.mjs
 * reads this IMAGES map and holds each entry to scripts/version-floors.json:
 * `alpine` to the newest Alpine release line, at most two patch releases
 * behind (endoflife.date `alpine-linux`), and `hcwLabRunner` through
 * lab-image/Dockerfile, whose base image that check already reads. An image
 * that no kind governs, that this repository does not build and that the
 * floors file's `unsourced` section does not name fails that test, so a new
 * entry cannot go stale unwatched the way `alpine:3.20` (end of life
 * 2026-04-01) and `alpine/ansible:2.17.0` did. Because a digest does not float,
 * the tag must name the exact release the digest is (`3.24.2`, not `3.24`).
 *
 * **To update an image:** resolve the new digest from the registry's
 * `Docker-Content-Digest` header (NOT from a mirror or a search result), and
 * record both the tag and the digest here in one commit:
 *
 *   tok=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/alpine:pull" | jq -r .token)
 *   curl -sI -H "Authorization: Bearer $tok" \
 *     -H "Accept: application/vnd.oci.image.index.v1+json" \
 *     https://registry-1.docker.io/v2/library/alpine/manifests/3.24.2 | grep -i docker-content-digest
 *
 * and cross-check it with `docker buildx imagetools inspect alpine:3.24.2`,
 * whose `Digest:` line is the index digest and whose linux/amd64 manifest's
 * `org.opencontainers.image.version` annotation names the release.
 *
 * **The lab host follows with no second edit.** Every `bootstrap.sh` run
 * imports this map on the host (lab-host/ansible/roles/lab_images), pulls
 * each digest before a job needs it and removes the digest a bump replaced,
 * so no visitor's job waits on a first download. Keep IMAGES a plain export
 * of `name[:tag]@sha256:` strings: that role refuses anything else, and
 * scripts/lab-images.test.mjs holds it to this file.
 *
 * The alpine digest below was resolved that way on 2026-09-28: the registry
 * header, `docker buildx imagetools inspect` and the Docker Hub API
 * (`/v2/repositories/library/alpine/tags/3.24.2`) all reported the same
 * index digest, and `alpine:3.24` resolved to it too that day. Alpine 3.24.2
 * was the newest release on endoflife.date, 3.24 supported to 2028-06-01.
 *
 * `ansible-check` ran on `alpine/ansible:2.17.0` until 2026-09-28, a
 * third-party image on ansible-core 2.17 and Python 3.12. Under the sandbox
 * flags it never ran a job: its HOME is `/`, so ansible-core stopped at
 * `Unable to create local directories(/.ansible/tmp): [Errno 30] Read-only
 * file system` before reading the playbook. It now runs on hcwLabRunner,
 * whose ansible-core is versioned with the image.
 *
 * **hcwLabRunner** is this repository's own image, built from lab-image/ and
 * published by .github/workflows/publish-lab-image.yml, which prints the
 * pushed digest in its job summary (`docker buildx imagetools inspect` of the
 * pushed tag). The pin below is the publish from main for 7c0a95b2 (#742,
 * run 36320771780): the image now vendors every module version the Landing
 * Zone Builder emits, each AVM_<KEY>_VERSION pair in lab-image/versions.env,
 * so avm-res-network-virtualnetwork@0.22.2, the version every spoke calls,
 * sits beside the three pattern modules, with its new child
 * avm-utl-interfaces@0.6.0. The builder's full default build, both landing
 * zones included, validates offline in this image (at the job memory in
 * index.js). It is still the python:3.14.7-slim-trixie base with
 * ansible-core 2.21.4 (#714), and still carries #675's changes to
 * lab-image/: transitive AVM vendoring, the unpacked provider mirror, the
 * kubeconform schemas and the capability scripts three of the runner-image
 * capabilities call at /usr/local/bin (lab-image/bin/). The image and those
 * commands move together, so a change to lab-image/bin/ is live only once
 * the digest main publishes for it is pinned here; before that the jobs
 * fail with `executable file not found` rather than run something older.
 */

/** Digest-pinned image references. Tag is documentation; the digest decides. */
export const IMAGES = {
  alpine: 'alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6',
  hcwLabRunner:
    'docker.io/hybridcloudworks/hcw-lab-runner:45365f89a66fa2ee11eb0065dd74120fb45ea58a@sha256:a49cd4f226c10d723458a5ee69341bdcf7e9421ddbab169dd007c7ad16ef0bca',
};

/**
 * The writable scratch space a runner-image job gets. The root filesystem is
 * read-only (SANDBOX_FLAGS), so terraform's data dir, helm's homes and the
 * payload copy all live on this tmpfs. Explicit uid/gid/mode because Docker
 * mounts a tmpfs root-owned by default and the container runs as 65534:
 * measured on Docker 29.8 (#675), the bare `--tmpfs /tmp/run:rw,size=64m`
 * the first version of this file used gave `Permission denied` on the first
 * write, before any tool ran. 64 MB is enough because the image's provider
 * mirror is unpacked and vendored modules are called by relative path, so
 * `terraform init` symlinks providers and references modules in place rather
 * than copying either here (lab-image/Dockerfile, the `mirror` stage).
 */
export const RUN_TMPFS = ['--tmpfs', '/tmp/run:rw,size=64m,uid=65534,gid=65534,mode=0700'];

export const CAPABILITIES = {
  // Smoke test — proves the whole pipeline (claim -> docker -> result).
  'shell-echo': {
    image: IMAGES.alpine,
    // payloadFile is the path of the payload inside the container.
    buildCommand: (payloadFile) => ['cat', payloadFile],
    payloadFileName: 'payload.txt',
    payloadEncodings: ['text'],
    timeoutSeconds: 30,
  },

  // Validates Terraform HCL without touching any backend or provider creds.
  // hcw-terraform-validate (lab-image/bin/) copies /workspace to the tmpfs,
  // rewrites each `source = "Azure/<module>/azurerm"` whose version
  // constraint a vendored copy under /opt/avm satisfies to that copy's
  // relative path, leaves every other registry source untouched so `init`
  // fails loudly on it, then runs `init -backend=false` and `validate`.
  // The learner's files are never changed (ADR 0032, decision 5). A `text`
  // payload is one main.tf; a `tar` payload is a whole root.
  'terraform-validate': {
    image: IMAGES.hcwLabRunner,
    buildCommand: () => ['hcw-terraform-validate'],
    payloadFileName: 'main.tf',
    payloadEncodings: ['text', 'tar'],
    timeoutSeconds: 180,
    extraDockerArgs: RUN_TMPFS,
  },

  // Syntax-checks an Ansible playbook. No inventory, no remote hosts.
  // ansible-core 2.21 on the runner image (lab-image/versions.env), which
  // carries ansible-core alone and no collections: a task naming a module
  // outside ansible.builtin fails with `couldn't resolve module/action`.
  // ansible-core creates ANSIBLE_LOCAL_TEMP (/tmp/run/ansible in the image)
  // before it reads anything, so the job needs the tmpfs; ANSIBLE_HOME moves
  // ~/.ansible there too, because the image's HOME is on the read-only root
  // and ansible-core prints a warning into the job output for each directory
  // it cannot create there (measured on Docker 29.8 with the pinned image).
  'ansible-check': {
    image: IMAGES.hcwLabRunner,
    buildCommand: (payloadFile) => [
      'ansible-playbook',
      '--syntax-check',
      '-i',
      'localhost,',
      payloadFile,
    ],
    payloadFileName: 'playbook.yml',
    payloadEncodings: ['text'],
    timeoutSeconds: 60,
    extraDockerArgs: [...RUN_TMPFS, '--env', 'ANSIBLE_HOME=/tmp/run/ansible-home'],
  },

  // Renders a Helm chart with `helm template`: no repository, no cluster.
  // The payload is a tar of one chart directory (Chart.yaml at the top or
  // one level down); dependencies must already be under charts/, since
  // there is no network to fetch them.
  'helm-template': {
    image: IMAGES.hcwLabRunner,
    buildCommand: () => ['hcw-helm-template'],
    payloadEncodings: ['tar'],
    timeoutSeconds: 60,
    extraDockerArgs: RUN_TMPFS,
  },

  // Validates Kubernetes manifests against the JSON schemas bundled in the
  // image (one pinned release of yannh/kubernetes-json-schema), strict, with
  // no API server: `kubectl --dry-run` in either mode reaches a cluster and
  // is deliberately not a capability. A `text` payload is one manifest
  // file; a `tar` payload is a directory tree kubeconform walks.
  kubeconform: {
    image: IMAGES.hcwLabRunner,
    buildCommand: () => ['hcw-kubeconform'],
    payloadFileName: 'manifests.yaml',
    payloadEncodings: ['text', 'tar'],
    timeoutSeconds: 60,
  },
};

# hcw-lab image

One Dockerfile, two targets, published to Docker Hub as
`docker.io/hybridcloudworks/hcw-lab-runner` and
`docker.io/hybridcloudworks/hcw-lab` by
[`publish-lab-image.yml`](../.github/workflows/publish-lab-image.yml) on every
push to `main` that touches this directory (issue #658, Phase 1 in #674,
Phase 2 in #675). The workflow signs in through a Docker OIDC connection, so
no Docker token is stored anywhere. Docker Hub is the only registry since
2026-10-08. Before that the images went to GHCR first and were copied to
Docker Hub by digest (since 2026-09-29, #779); the GHCR copies stay public
but are no longer updated.
[Docker Hub publishing](../docs/runbooks/docker-hub-publishing.md) has the
setup and the checks.

| Target   | Image                                     | Carries                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runner` | `docker.io/hybridcloudworks/hcw-lab-runner` | terraform, kubeconform, helm, ansible-core; a Terraform provider filesystem mirror at `/opt/terraform/mirror`; every Azure Verified Module the Landing Zone Builder emits, at the version it emits, and every registry module those call, at `/opt/avm/<name>@<version>`; one release of the Kubernetes JSON schemas at `/opt/kubeconform/schemas`; the three capability commands in [`bin/`](bin/). Runs as uid 65534 (`nobody`) with `/workspace` mounted read-only. This is what `vps-agent` runs jobs in. |
| `full`   | `docker.io/hybridcloudworks/hcw-lab`        | Everything in `runner`, plus Azure CLI, kubectl, git, curl, jq and the three packages code-server needs (`ca-certificates`, `libatomic1`, `procps`); uid 65534's shell is `bash` and its home `/tmp/home`, because Coder runs everything through the passwd shell (#693). `CMD` is `bash`. This is what a lab page tells a learner to pull, and the base of the Coder template.                                                            |

Both targets are built on the official `python:3.14.7-slim-trixie` image,
pinned by index digest: CPython 3.14.7 on Debian 13 (trixie). ansible-core,
`hcw-terraform-validate` and the build-time vendoring all run on that
Python; no Debian `python3` package is installed, and the image carries no
`pip` command. [`versions.env`](versions.env) says why every stage, the
build-only ones included, uses the one base.

Every version and checksum is in [`versions.env`](versions.env); the
Dockerfile repeats none of them except the base image reference, which a
`FROM` line cannot read from a file. The workflow fails the build if any
`FROM` that is not an earlier stage differs from `BASE_IMAGE@BASE_DIGEST`
there, and checks the sandbox template's `FROM` against
`SANDBOX_BASE_IMAGE@SANDBOX_BASE_DIGEST` the same way.

## Sizes

Measured on 2026-09-27 with Docker 29.8.0 (`docker image ls`, which since
Docker 29 reports both the unpacked size on disk and the compressed size a
pull transfers), on the Python 3.14.7 / Debian 13 base:

| Target   | On disk | Compressed (what a pull downloads) |
| -------- | ------- | ---------------------------------- |
| `runner` | 1.71 GB | 319 MB                             |
| `full`   | 2.73 GB | 497 MB                             |

Vendoring the fourth builder module that day (avm-res-network-virtualnetwork
0.22.2 and its one new child, avm-utl-interfaces 0.6.0) grew `/opt/avm` from
5.7 MB to 7.5 MB and each image by 2.1 MB (`docker image inspect`: the
runner 1,708,013,228 to 1,710,127,612 bytes), which the table's precision
does not show. The 2026-09-25 measurement was the same two rows.

On the Debian 12 base with its Python 3.11 the same day, the two measured
1.70 GB / 319 MB and 2.69 GB / 491 MB. The runner stays level because the
python image (135 MB) replaces both bookworm-slim and the apt layer that
added Debian's python3 and ansible-core's dependencies (150 MB together);
what grows is the ansible venv (52 MB against 22 MB), which now carries its
own dependency wheels, cryptography's statically linked OpenSSL among them,
instead of reusing Debian's packages. The wheels are bind-mounted into the
one `RUN` that installs them, so they add no layer of their own.

Phase 1 measured 880 MB / 311 MB and 1.88 GB / 484 MB. The on-disk growth is
the provider mirror, now unpacked (931 MB of binaries where the zips were
191 MB) so that `terraform init` symlinks providers instead of extracting
them; see "What works offline". The pull size barely moved, because a layer
is compressed in transit whichever form the binaries take on disk. The
vendored module tree is 7.5 MB and the Kubernetes schemas 62 MB on disk.

## Run the toolchain locally

The `full` image is the follow-along toolchain for the lab pages, and the
one the site's "Run it locally" commands pull. It is on Docker Hub, where
`hybridcloudworks/hcw-lab` is short for `docker.io/hybridcloudworks/hcw-lab`.
Both repositories are public, so the pull is anonymous. Pull it, then run it
with the current directory mounted at `/workspace`; both commands drop into
`bash` there as `nobody`.

PowerShell:

```powershell
$d = docker buildx imagetools inspect docker.io/hybridcloudworks/hcw-lab:latest --format '{{.Manifest.Digest}}'; $d; docker pull "hybridcloudworks/hcw-lab@$d"
```

```powershell
docker run --rm -it -v "${PWD}:/workspace" "hybridcloudworks/hcw-lab@$d"
```

bash:

```bash
d=$(docker buildx imagetools inspect docker.io/hybridcloudworks/hcw-lab:latest --format '{{.Manifest.Digest}}'); echo "$d"; docker pull "hybridcloudworks/hcw-lab@$d"
```

```bash
docker run --rm -it -v "$PWD:/workspace" "hybridcloudworks/hcw-lab@$d"
```

A successful run prints a `nobody@<container id>:/workspace$` prompt, and
`terraform version` there reports the version in `versions.env`. Add `:ro`
to the mount to run the way the job sandbox does. Pinning the digest rather than
the mutable tag matches how [`vps-agent/lib/capabilities.js`](../vps-agent/lib/capabilities.js)
runs jobs and ensures immutable provenance: the publish workflow writes each pushed
image's digest to its job summary, and that is the first-party place to copy it from.
The `docker buildx imagetools inspect` commands above read the current digest
Docker Hub serves for `latest` and pull exactly it. Success ends with
`Status: Downloaded newer image for hybridcloudworks/hcw-lab@sha256:…`
(or `Image is up to date`) and the same `sha256:` value on the `Digest:` line.

The provenance attestation verifies against this repository. The first line
reads it from GitHub's attestation API, which keys on the digest. The second
reads the bundle stored beside the image on Docker Hub:

```powershell
gh attestation verify oci://docker.io/hybridcloudworks/hcw-lab:latest --repo saulpatinojr/HCW-HybridCloudWorks
```

```powershell
gh attestation verify oci://docker.io/hybridcloudworks/hcw-lab:latest --repo saulpatinojr/HCW-HybridCloudWorks --bundle-from-oci
```

Each prints `✓ Verification succeeded!` and names
`.github/workflows/publish-lab-image.yml@refs/heads/main` as the build
workflow. An image published before the repository moved to
`saulpatinojr` on 2026-10-07 was signed under the old owner, so verify one
published since.

## What works offline

The runner is built so that a lab job needs no network at all, because
`vps-agent` runs every job under `--network none` on a read-only root with
one 64 MB tmpfs at `/tmp/run`. Precisely:

- **Providers: yes, and symlinked.** `TF_CLI_CONFIG_FILE` points at a
  `provider_installation { filesystem_mirror { ... } }` block with no
  `direct` fallback, so Terraform installs from `/opt/terraform/mirror` and
  nowhere else. The mirror holds azurerm 5.10.0 and 4.81.0, azapi 2.13.0, alz
  0.22.0, random 3.9.1, modtm 0.4.0 and time 0.14.2, each zip verified after
  mirroring against the SHA256 the registry publishes for it and then
  unpacked into the directory layout. Unpacked matters: from a packed mirror
  `terraform init` extracts the provider into `.terraform/providers` (225 MB
  for azurerm, more than the job's tmpfs), from an unpacked one it creates a
  symlink and copies nothing (a 40 KB `.terraform`, measured). A provider
  that is not in the mirror fails `init` immediately with `provider
  registry.terraform.io/hashicorp/azuread was not found in any of the search
  locations: /opt/terraform/mirror` instead of hanging on a registry that is
  unreachable. azurerm is mirrored twice because the vendored AVM modules
  still constrain to `~> 4.0` / `~> 4.35` while new code targets 5.x.
- **Every module the Landing Zone Builder emits, and everything those call:
  yes** (ADR 0032 decision 5). The builder modules are the four in
  `AVM_MODULES` in
  [`avmVersions.js`](../frontend/src/lib/landingZone/avmVersions.js), each at
  the version the builder pins: `/opt/avm/avm-ptn-alz@0.21.0`,
  `/opt/avm/avm-ptn-alz-management@0.9.0`,
  `/opt/avm/avm-ptn-alz-connectivity-hub-and-spoke-vnet@0.17.5` and
  `/opt/avm/avm-res-network-virtualnetwork@0.22.2`, the module every spoke is
  built from. Each is the release source tarball of its
  `Azure/terraform-azurerm-<name>` repository, verified by SHA256.

  **How the list is derived.** It is written once, as one
  `AVM_<KEY>_VERSION` / `AVM_<KEY>_SHA256` pair per builder module in
  [`versions.env`](versions.env) (<KEY> is the name upper-cased with `-` as
  `_`), and nothing else names it: the Dockerfile's fetch stage vendors every
  pair it finds, `vendor-avm.sh` resolves whatever directories that leaves,
  and `smoke.sh` reads the same lines. The pairs are held equal to
  `avmVersions.js` in both directions by
  [`scripts/lab-image-avm-vendoring.test.mjs`](../scripts/lab-image-avm-vendoring.test.mjs),
  which runs in the `scripts (operations)` CI job on any change to either,
  and the weekly `update-avm-versions.yml` moves a pair in the same pull
  request as the builder's pin. Until 2026-09-27 the image carried only the
  three pattern modules, so the spokes' 0.22.2 was left for the registry and
  the full default build could not init offline (#737); nothing compared the
  two lists then.

  **The children.** Terraform has a provider mirror but no module mirror,
  and measured in #686 `avm-ptn-alz` calls one registry module and the
  connectivity module thirteen, some from inside its own nested modules.
  [`vendor-avm.sh`](vendor-avm.sh) runs `terraform get` on each builder
  module at build time, copies each distinct child once to
  `/opt/avm/<name>@<version>` (seventeen `name@version` pairs across
  fourteen modules), and rewrites every `module` block inside the vendored
  copies from `source = "Azure/<name>/azurerm"` plus a `version` to the
  child's **relative** path, `../<name>@<version>`, with the `version` line
  commented out. Relative because Terraform uses `./` and `../` paths in
  place and treats an absolute path as a `file://` source it copies onto the
  tmpfs. Two blocks in `versions.env` record the result. `AVM_CHILD_MODULES`
  pins each child by a tree hash. `AVM_CHILD_CALLS` records which builder
  module, at which version, reaches which child, so the static test can
  check with no network that the children of the version `avmVersions.js`
  pins are vendored; a pin bump leaves the new version unrecorded and the
  test red until the blocks are re-printed. The build fails on a hash
  mismatch, an unpinned child, an unused pin, or any difference between
  `AVM_CHILD_CALLS` and what `terraform get` resolved, and then proves with a
  second `terraform get` that nothing in the rewritten tree reaches the
  registry. `smoke.sh` checks every recorded child is on disk and inits and
  validates each builder module from a generated root with no network.

  **Two versions of one module coexist**, as two directories:
  `avm-res-network-virtualnetwork@0.15.0` is the connectivity module's own
  child (its hub network) and `@0.22.2` is the builder's spokes', and
  `avm-utl-interfaces` is vendored at 0.2.0, 0.5.0 and 0.6.0. A child at
  exactly a builder module's `name@version` is not copied twice: its calls
  resolve to the builder module's directory.

  **The path layout is the contract** `hcw-terraform-validate` and the
  builder's "Validate on the lab" prediction
  ([`labImage.js`](../frontend/src/lib/landingZone/labImage.js), #672) both
  read, and it has not changed: one `/opt/avm/<name>@<version>` directory
  per vendored module, `<name>` being the registry module name. `labImage.js`
  takes its builder modules from `AVM_MODULES` directly and keeps one copy
  of the child list, which its test holds to `AVM_CHILD_MODULES`.

  `avm-ptn-alz-application-landing-zone-identity-and-access`, the
  application landing zone module #658 names, is neither emitted nor
  vendored: on 2026-09-25 its repository had no release and no tag.
- **A learner's or the builder's root: yes, through the rewrite.** The
  `terraform-validate` job runs [`bin/hcw-terraform-validate`](bin/hcw-terraform-validate),
  which copies the payload to `/tmp/run/src` and rewrites each `module`
  block whose `source` is an Azure Verified Module and whose `version`
  constraint a vendored version satisfies (Terraform's own operators; the
  highest satisfying version wins) to that copy's relative path, then runs
  `init -backend=false` and `validate`. A registry module the image does not
  vendor, or a constraint no vendored version satisfies, is left exactly as
  written and `init` fails loudly on it. The learner's files are never
  changed (ADR 0032, decision 5): the zip and the payload keep their
  registry sources and init anywhere with network.
  [`smoke/terraform-validate-payload`](smoke/terraform-validate-payload/main.tf)
  is a root shaped like the builder's output, calling each builder module
  once by registry source, and the smoke test validates it offline with one
  rewrite per builder module and none left. `sandbox-check.mjs` validates
  the builder's real full default build (every component, both landing
  zones; `emitFiles(DEFAULT_STATE)`, generated at run time) the same way,
  under the job sandbox and at the agent's own limits. Those limits were
  set by this build: at 256m of job memory it is OOM-killed during
  `terraform validate`, after an offline init that succeeds, because its
  sixteen provider configurations (`azurerm` and `azapi` six times each)
  each start a plugin process. 320m passes, erratically, in 20 to 86 s and
  512m in 15 to 19 s (measured 2026-09-27), so the agent's default and the
  host's `labs_agent_job_memory` are 512m (owner decision that day; the
  reason is beside the default in `vps-agent/index.js`).
- **Helm and kubeconform: yes.** [`bin/hcw-helm-template`](bin/hcw-helm-template)
  renders one chart (its `Chart.yaml` at `/workspace` or one level down;
  dependencies must already be under `charts/`).
  [`bin/hcw-kubeconform`](bin/hcw-kubeconform) validates manifests with
  `-strict` against `/opt/kubeconform/schemas/v1.37.1-standalone-strict`,
  one directory of `yannh/kubernetes-json-schema` at a pinned commit and tree
  hash, in the layout kubeconform's own location template expects. A kind
  with no schema (a CRD) is an error, not a skip.

Three consequences of the sandbox:

- `terraform init` writes `.terraform.lock.hcl` beside the configuration,
  and a read-only `/workspace` refuses it, so every command copies its root
  to `/tmp/run` first. `TF_DATA_DIR` is `/tmp/run/.terraform`; give each root
  its own when a session inits more than one, as `smoke.sh` does.
- `TMPDIR=/tmp/run`. A Terraform provider is a go-plugin subprocess that
  opens a Unix socket in `TMPDIR` before it prints anything; with `TMPDIR` on
  the read-only root every provider died silently and `validate` reported
  "Failed to read any lines from plugin's stdout" for all six, after `init`
  had succeeded (measured in #675). Everything else that writes to a home
  directory (`az`, `helm`, `ansible`) is pointed at `/tmp/home` or
  `/tmp/run` through `HOME`, `HELM_*_HOME` and `ANSIBLE_LOCAL_TEMP`. In the
  job sandbox `/tmp/home` is on the read-only root too, so the
  `ansible-check` capability also sets `ANSIBLE_HOME=/tmp/run/ansible-home`:
  without it ansible-core prints a warning into the job output for each
  directory under `~/.ansible` it cannot create.
- The tmpfs the agent mounts is `uid=65534,gid=65534,mode=0700`
  (`RUN_TMPFS` in `capabilities.js`): Docker mounts a tmpfs root-owned by
  default, and the bare `--tmpfs /tmp/run:rw,size=64m` Phase 1 used gave
  `Permission denied` on the first write.

To use the registry instead of the mirror for one session (the `full` image
online, a provider the mirror does not carry), disable the config file:

bash, inside the container:

```bash
TF_CLI_CONFIG_FILE=/dev/null terraform init
```

## Smoke test

[`smoke.sh`](smoke.sh) runs inside the image with this directory mounted at
`/workspace` read-only and no network. It refuses to pass if the network is
reachable or the mount is writable, because an offline init that had network
would prove nothing; then it checks each tool's version against
`versions.env`, that every mirrored provider is present in the unpacked
layout, that every builder module and every child `AVM_CHILD_CALLS` records
for it is on disk, that every vendored child hashes to its pin, that
`terraform init -backend=false` and `terraform validate` succeed with no
network for [`smoke/providers-only`](smoke/providers-only/main.tf) and for a
generated root per builder module (symlinking every provider and
downloading no module), that the three capability commands succeed on their
fixtures under [`smoke/`](smoke/) and that kubeconform rejects an unknown
field, and, for the `full` target, the extra tools and uid 65534's shell.
The workflow runs it on every pull request.

[`sandbox-check.mjs`](sandbox-check.mjs) is the second half: it runs every
capability the way the agent does, through
`vps-agent/lib/docker-runner.js` itself (`prepareJobDir`, `buildDockerArgs`,
so the exact sandbox flags, the tmpfs, the label and a `tar` payload), and
expects the exit codes the job would report. The runner-image capabilities
run against a locally built image; `shell-echo` runs on the `alpine` digest
`capabilities.js` pins, pulled first as the host would, and must print its
payload and nothing else. A capability with no case fails the script. The
three `ansible-check` fixtures are under
[`smoke/ansible-check-payload/`](smoke/ansible-check-payload/): a valid
playbook, which must print its `playbook:` line and nothing else, and an
unknown play keyword and a collection module, both refused with exit 4
(the runner carries ansible-core and no collections). The smoke test runs
inside a container that is not `--read-only`; this one is, and it is what
caught both the tmpfs ownership and the `TMPDIR` failures.
One of its jobs is the Landing Zone Builder's full default build, generated
from `frontend/src/lib/landingZone` when the script runs, so it needs that
directory beside this one (a full checkout, as CI has) and fails on any
module block the image would leave for the registry. Every case runs at the
agent's limits, which the script reads from `vps-agent/index.js` rather than
restating (512m of memory, for the reason under "What works offline"). The
workflow runs it after the smoke tests, and runs on pull requests that
change the builder as well as this directory.

[`scripts/lab-image-avm-vendoring.test.mjs`](../scripts/lab-image-avm-vendoring.test.mjs)
is the fast third check, with no Docker and no network, in the required
`scripts (operations)` CI job: `versions.env` must vendor exactly the
modules and versions `avmVersions.js` pins, record what each of those
versions calls, and pin every child it records; and the smoke payload must
call each builder module once with a constraint that resolves to the
builder's version.

Locally, from the repository root. PowerShell:

```powershell
docker build --target runner -t hcw-lab-runner:dev lab-image
```

```powershell
docker run --rm --network none -v "${PWD}\lab-image:/workspace:ro" hcw-lab-runner:dev bash /workspace/smoke.sh runner
```

```powershell
node lab-image/sandbox-check.mjs hcw-lab-runner:dev
```

```powershell
docker build --target full -t hcw-lab:dev lab-image
```

```powershell
docker run --rm --network none -v "${PWD}\lab-image:/workspace:ro" hcw-lab:dev bash /workspace/smoke.sh full
```

bash (Git Bash needs `MSYS_NO_PATHCONV=1` so `/workspace` is not rewritten
to a Windows path):

```bash
docker build --target runner -t hcw-lab-runner:dev lab-image
```

```bash
MSYS_NO_PATHCONV=1 docker run --rm --network none -v "$(pwd -W 2>/dev/null || pwd)/lab-image:/workspace:ro" hcw-lab-runner:dev bash /workspace/smoke.sh runner
```

```bash
node lab-image/sandbox-check.mjs hcw-lab-runner:dev
```

A passing run ends with `smoke: passed (runner)` or `smoke: passed (full)`
and exits 0; any failing check prints `FAIL:` with the tool's output beneath
it and the script exits 1 after running every remaining check.
`sandbox-check.mjs` ends with a `sandbox-check: passed` line naming how many
jobs ran and the image the runner-image ones ran on, and exits 0, or prints
the job's output and exits 1.

## Updating a version

The weekly `lab-supply-chain.yml` run does this for the tools (Terraform,
kubeconform, Helm, kubectl), the Azure CLI and the Terraform providers in the
mirror: `node scripts/lab-pins-upstream.mjs --bump image-tools` reads each sum
from the publisher and the run keeps one pull request open on
`chore/lab-pins-image-tools`. A pin it could not verify becomes a note in the
weekly issue, and the rest of this section is the hand procedure for it.

Edit the `_VERSION` line and the `_SHA256` beside it in `versions.env`, open a
pull request, and the workflow rebuilds both targets and runs the smoke test
against them; a wrong sum fails the build at the download, a wrong version
fails the smoke test's version comparison. On merge the same workflow pushes
and attests. Where each sum comes from:

- terraform: `terraform_<version>_SHA256SUMS` on releases.hashicorp.com,
  the `linux_amd64.zip` line.
- kubeconform: the `CHECKSUMS` asset on the GitHub release.
- helm: `https://get.helm.sh/helm-v<version>-linux-amd64.tar.gz.sha256sum`.
- kubectl: `https://dl.k8s.io/release/v<version>/bin/linux/amd64/kubectl.sha256`.
- ansible-core: the wheel's `sha256` digest in PyPI's JSON API
  (`https://pypi.org/pypi/ansible-core/<version>/json`). Check the new
  line's controller Python range in the
  [ansible-core support matrix](https://docs.ansible.com/projects/ansible/latest/reference_appendices/release_and_maintenance.html)
  covers `BASE_PYTHON_VERSION` (2.21 is 3.12 to 3.14).
- ansible-core's dependencies (`ANSIBLE_CORE_DEPS`): one
  `name==version --hash=sha256:<sum>` line each, the sum of the wheel pip
  selects for CPython 3.14 on linux x86_64 from the same PyPI JSON API
  (`https://pypi.org/pypi/<name>/<version>/json`). The build runs pip in
  hash-checking mode, so a dependency a new ansible-core adds fails the
  fetch stage with `In --require-hashes mode, all requirements must have
  their versions pinned with ==. These do not:` and its name, and a wrong
  sum fails with `THESE PACKAGES DO NOT MATCH THE HASHES FROM THE
  REQUIREMENTS FILE` and the `Expected` and `Got` sums (both measured on
  2026-09-25).
- The three `ANSIBLE_CORE_*` lines are the lab host's too:
  `lab-host/bootstrap.sh` writes the same requirements file from them and
  installs it with `uv pip install --require-hashes`, so a move here reaches
  the host on its next run after the merge (LAB-13, #959). A newer release in
  the same line is automated: the weekly
  `node scripts/lab-pins-upstream.mjs --bump image-base` moves
  `ANSIBLE_CORE_VERSION` and `ANSIBLE_CORE_SHA256` from PyPI's JSON API,
  reads every `ANSIBLE_CORE_DEPS` hash back from PyPI, and moves a
  dependency's line only when the new release pins it exactly. A new line,
  a changed requirement or Requires-Python, or a hash PyPI does not serve is
  a note in the weekly issue instead, and a hand bump by this section. The
  `ansible-lint (lab-host)` job in `.github/workflows/ci.yml` pins its own
  ansible-core and moves by hand.
- Azure CLI: `AZURE_CLI_VERSION` is the upstream release, the newest package
  `Version` in
  `https://packages.microsoft.com/repos/azure-cli/dists/bookworm/main/binary-amd64/Packages`
  without its `-1~bookworm` suffix (no sum; apt verifies the package against
  the signed repository, and the signing key's own sum is
  `MICROSOFT_APT_KEY_SHA256`). `AZURE_CLI_SUITE` is `bookworm` because
  packages.microsoft.com has no `trixie` suite and Microsoft's
  [install page](https://learn.microsoft.com/cli/azure/install-azure-cli-linux?pivots=apt)
  says to use the latest Debian suite when a distribution has no package;
  move it to `trixie` once
  <https://packages.microsoft.com/repos/azure-cli/dists/> lists one. The
  sandbox template installs the same release from `dists/resolute`, its
  base's own suite, so check the version is published there too.
- Providers: `shasum` from
  `https://registry.terraform.io/v1/providers/<namespace>/<name>/<version>/download/linux/amd64`.
- Builder modules (the `AVM_<KEY>_VERSION` / `AVM_<KEY>_SHA256` pairs):
  `sha256sum` of the downloaded
  `https://github.com/Azure/terraform-azurerm-<name>/archive/refs/tags/v<version>.tar.gz`.
  These lines are normally moved for you: `.github/workflows/update-avm-versions.yml`
  (#671) checks the builder's pins in `frontend/src/lib/landingZone/avmVersions.js`
  against the Terraform Registry every Tuesday and, when a module has a newer
  release, opens one pull request that bumps the pin, these two lines and the
  HCL snapshots together, with the sum computed from the same tarball. A
  module added to `avmVersions.js` needs its pair added here by hand, once;
  the static test names the missing line.

  The same run regenerates the child modules (#1306): `AVM_CHILD_CALLS` is
  keyed by each builder module's version, so the new version would have no
  record, and a bump can change what the module calls, so the build would
  fail until `AVM_CHILD_MODULES` matched as well. The updater builds the
  vendor stage in print mode (the command below), splices the two blocks it
  prints over the old two, rewrites `LAB_IMAGE_CHILD_AVM` in
  `frontend/src/lib/landingZone/labImage.js` when the child list changed,
  moves the exact pin on the module's block in
  `smoke/terraform-validate-payload/main.tf` where it has one, and runs
  `scripts/lab-image-avm-vendoring.test.mjs` on the result before the pull
  request opens; a vendor stage that fails fails the run with its log, and
  no pull request opens with the old record. A hand bump, or a module added
  to `avmVersions.js`, still does the same by hand: print both blocks and
  paste them over the old two. bash, from the repository root:

  ```bash
  docker build --target vendor --build-arg AVM_PRINT_PINS=1 --progress=plain lab-image 2>&1 | sed -n "/^#[0-9]* [0-9.]* AVM_CHILD_[A-Z]*='/,/^#[0-9]* [0-9.]* '$/p" | sed -E 's/^#[0-9]+ [0-9.]+ //'
  ```

  It prints `AVM_CHILD_MODULES='`, one `<name>@<version> <tree hash>` line
  per child and a closing `'`, then `AVM_CHILD_CALLS='`, one
  `<builder>@<version> <child>@<version>` line per pair (a builder module
  that calls nothing stands alone on its line) and a closing `'`. The hash is
  what `find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum`
  prints inside the vendored directory. If the child list changed, update
  `LAB_IMAGE_CHILD_AVM` in `frontend/src/lib/landingZone/labImage.js` to
  match; its test fails until you do.
- Kubernetes schemas: `KUBERNETES_JSON_SCHEMA_COMMIT` is the commit of
  `yannh/kubernetes-json-schema` to take the directory from,
  `KUBERNETES_JSON_SCHEMA_DIR` the directory (bump it with
  `KUBECTL_VERSION`), and the SHA256 the same tree hash over that directory.
- Base image: the image index digest from the registry's
  `Docker-Content-Digest` header, by the method documented at the top of
  [`vps-agent/lib/capabilities.js`](../vps-agent/lib/capabilities.js)
  (repository `library/python`, tag `3.14-slim-trixie`), cross-checked with
  `docker buildx imagetools inspect python:3.14-slim-trixie`, whose
  `org.opencontainers.image.version` annotation names the patch release.
  Update `BASE_IMAGE`, `BASE_DIGEST`, `BASE_PYTHON_VERSION` and every
  external `FROM` line in the Dockerfile together; the sandbox template's
  base is `SANDBOX_BASE_IMAGE` / `SANDBOX_BASE_DIGEST` and its one `FROM`
  line, by the same method. This is automated within the release line
  (#949): every Tuesday `.github/workflows/lab-supply-chain.yml` runs
  `node scripts/lab-pins-upstream.mjs --bump image-base`, which reads the
  line tag's digest twice (the registry, its bytes hashed, and the Docker
  Hub API), takes the CPython release from the image config, requires the
  patch tag to resolve to the same digest, and opens or updates the
  `chore/lab-pins-image-base` pull request with all four edits, the base tag
  and CPython release the Docker guide page names
  (`frontend/src/pages/docker/BuildingImagesPage.jsx`, which
  `DockerGuides.test.jsx` holds to this file), and that evidence. A new minor line (3.15) stays a hand bump, governed by
  `scripts/version-floors.json`. Merging it publishes from `main`, and the
  publish opens the `chore/lab-pins-image-digests` pull request for the
  consumers.

The provider mirror and the vendored tree are rebuilt from scratch on every
build (neither is cached between versions), so a provider bump is a version
and a sum and nothing else.

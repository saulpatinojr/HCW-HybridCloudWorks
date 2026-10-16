---
title: Follow along in one container
subtitle: Pull the hcw-lab image, initialise the part 1 landing zone with the network switched off, and read why the lab runner could not work any other way.
date: 2026-09-27
track: how-to
part: 2 of 3
tags: [terraform, docker, iac, landing-zone]
reading: 9
---

With the network on, `terraform init` on the landing zone from
[part 1](https://hybridcloudworks.com/azure/blog/build-a-landing-zone-you-can-read) downloads 31 MB of modules before it will
validate a line. Inside the `hcw-lab` image with the network off, the same
folder initialises and validates, and the `.terraform` directory it leaves
behind is **108 KB**.

This part is about that difference: what the image carries, why the site's lab
runner needs it to, and how to follow the rest of the series inside it with
nothing installed but Docker.

The build is the one from part 1:

```landing-zone
lz=mg,policy,mgmt,hub&corp=0&online=0
```

## What you'll have at the end

| Piece | Result |
| --- | --- |
| The `hcw-lab` image | terraform 1.16.4, Azure CLI 2.90.0, kubectl 1.37.1, helm 4.3.0, kubeconform 0.8.0 and ansible-core 2.21.4, on Python 3.14.7 and Debian 13 (trixie), in one pull |
| A provider mirror | Seven provider releases at `/opt/terraform/mirror`, installed by symlink |
| Vendored modules | Every module the Landing Zone Builder emits, at the version it emits, and every registry module those call, at `/opt/avm` |
| An offline init | The part 1 folder initialised and validated under `--network none`, your files untouched |

## What it costs

**Nothing but disk.** Measured with Docker 29.8.0 on 2026-09-27, the image is a
467 MB download and 2.7 GB once unpacked. It is public on Docker Hub, so
there is no sign-in, and nothing in this part reaches Azure.

---

## Why one container

### An image, not an install list

The alternative is a prerequisites section: install Terraform, the Azure CLI,
kubectl, helm and Ansible, at whatever versions your package manager offers
today. Every one of them would then differ from the version this series was
checked against, and a lab that fails on a version you did not choose is a lab
about your package manager.

The image pins every tool in one file,
[`lab-image/versions.env`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-image/versions.env),
and checks every download against the SHA256 beside it before using it. A wrong
sum fails the build, not your afternoon.

### A provider mirror, because the lab runner has no network

One Dockerfile builds two images. `hcw-lab` is the one you pull.
`hcw-lab-runner` is what the site's lab runner, `vps-agent`, runs jobs in: the
same toolchain without the Azure CLI, kubectl, git, curl and jq. A lab job is
built to run code a learner wrote, on a host reachable from the internet, so
every job starts with these flags and one 64 MB tmpfs at `/tmp/run`:

```text
--network none --read-only --security-opt no-new-privileges --cap-drop ALL --user 65534:65534
```

A normal `terraform init` asks `registry.terraform.io` for every provider.
Under `--network none` there is no registry to ask, so the image points
`TF_CLI_CONFIG_FILE` at this file, and nothing else:

```hcl
provider_installation {
  filesystem_mirror {
    path    = "/opt/terraform/mirror"
    include = ["registry.terraform.io/*/*"]
  }
}
```

There is no `direct {}` block, deliberately. A provider the mirror does not
carry fails `init` at once with a message naming the mirror, instead of
hanging on a registry that cannot answer.

The mirror holds azurerm 5.7.0 and 4.81.0, azapi 2.12.0, alz 0.22.0, random
3.9.1, modtm 0.4.0 and time 0.14.2. azurerm is there twice because the
vendored modules still constrain it to `~> 4.0` and `~> 4.35` while new code
targets 5.x. The part 1 build resolves to 4.81.0.

### Unpacked, because azurerm alone is bigger than the tmpfs

`terraform providers mirror` writes zips. From a mirror of zips, `init`
extracts each provider into `.terraform/providers`, and azurerm alone is
225 MB: more than three times the job's 64 MB. So the image unpacks every zip
at build time, and `init` creates a symlink instead of a copy:

```text
lrwxrwxrwx 1 nobody nogroup 72 Sep 27 11:20 linux_amd64 -> /opt/terraform/mirror/registry.terraform.io/azure/alz/0.22.0/linux_amd64
```

### No module mirror, so the image rewrites a copy

Terraform has a provider mirror. It has no module mirror, and the three pattern
modules the part 1 build calls reach sixteen more module releases between
them. So the image vendors every one under `/opt/avm/<name>@<version>`, and one
command does what `init` cannot. `hcw-terraform-validate` copies your folder to
`/tmp/run/src`, rewrites each `module` block whose version constraint a
vendored copy satisfies to that copy's relative path, and only then runs
`terraform init -backend=false` and `terraform validate`.

The rejected alternative is rewriting the zip itself. The zip would then work
only inside this image. Left as the builder wrote it, with registry sources and
pinned versions, it initialises anywhere with a network, and the rewrite lives
on a copy that disappears with the container. **Your files are never
changed.**

---

## Prerequisites

- Docker. Checked with Docker 29.8.0.
- The folder from part 1: `landing-zone.zip`, unzipped to `landing-zone`, nine
  files.
- No registry login, no Azure subscription, no `az login`.

---

## The steps

### 1. Pull the image

PowerShell:

```powershell
$d = docker buildx imagetools inspect docker.io/hybridcloudworks/hcw-lab:latest --format '{{.Manifest.Digest}}'; $d; docker pull "hybridcloudworks/hcw-lab@$d"
```

bash:

```bash
d=$(docker buildx imagetools inspect docker.io/hybridcloudworks/hcw-lab:latest --format '{{.Manifest.Digest}}'); echo "$d"; docker pull "hybridcloudworks/hcw-lab@$d"
```

**Verify:** `docker image ls hybridcloudworks/hcw-lab` lists the image
at about 2.7 GB. Pinning the immutable digest (`hybridcloudworks/hcw-lab@$d`)
ensures you run the exact reproducible build verified by SLSA build provenance.

### 2. Start it in the folder, with the network off

Change into the `landing-zone` folder first, then:

PowerShell:

```powershell
docker run --rm -it --network none -v "${PWD}:/workspace:ro" "hybridcloudworks/hcw-lab@$d"
```

bash:

```bash
docker run --rm -it --network none -v "$PWD:/workspace:ro" "hybridcloudworks/hcw-lab@$d"
```

Two flags do the work. `--network none` makes the offline claim testable: an
init that had a network would prove nothing. `:ro` mounts your folder
read-only, the way the lab runner mounts a job's payload. On Windows, use the
PowerShell line; Git Bash rewrites `/workspace` into a Windows path unless told
not to.

**Verify:** a `nobody@<container id>:/workspace$` prompt, and `ls` there shows
your nine files.

### 3. Check the toolchain

Inside the container (bash):

```bash
terraform version
```

```text
Terraform v1.16.4
on linux_amd64
```

```bash
echo $TF_CLI_CONFIG_FILE
```

It prints `/etc/terraform/terraformrc`, the mirror configuration above.

### 4. Try a plain init, and watch it fail

```bash
terraform init -backend=false
```

Trimmed:

```text
Initializing modules...

Error: Error accessing remote module registry

  on alz.tf line 9:
   9: module "alz" {

Failed to retrieve available versions for module "alz" (alz.tf:9) from
registry.terraform.io: failed to request discovery document: GET
https://registry.terraform.io/.well-known/terraform.json giving up after 4
attempt(s): … connect: network is unreachable.
```

The same error follows for `connectivity` and `management`. Look at where it
stopped: at modules, before providers. The mirror would have answered for every
provider. There is nothing to answer for modules, which is the gap the next
step closes.

### 5. Run the lab runner's own check

```bash
hcw-terraform-validate
```

Trimmed to the rewrites, the providers and the verdict:

```text
== module sources (3 registry module block(s) in the payload)
  rewrote module "alz" (Azure/avm-ptn-alz/azurerm 0.21.0) -> ../../../opt/avm/avm-ptn-alz@0.21.0
  rewrote module "connectivity" (Azure/avm-ptn-alz-connectivity-hub-and-spoke-vnet/azurerm 0.17.5) -> ../../../opt/avm/avm-ptn-alz-connectivity-hub-and-spoke-vnet@0.17.5
  rewrote module "management" (Azure/avm-ptn-alz-management/azurerm 0.9.0) -> ../../../opt/avm/avm-ptn-alz-management@0.9.0

== terraform init -backend=false
- connectivity in ../../../opt/avm/avm-ptn-alz-connectivity-hub-and-spoke-vnet@0.17.5
- management in ../../../opt/avm/avm-ptn-alz-management@0.9.0
- alz in ../../../opt/avm/avm-ptn-alz@0.21.0
…
- Installed azure/azapi v2.12.0 (unauthenticated)
- Installed hashicorp/azurerm v4.81.0 (unauthenticated)
- Installed azure/modtm v0.4.0 (unauthenticated)
- Installed hashicorp/random v3.9.1 (unauthenticated)
- Installed hashicorp/time v0.14.2 (unauthenticated)
- Installed azure/alz v0.22.0 (unauthenticated)
Terraform has been successfully initialized!

== terraform validate
Success! The configuration is valid.
```

All 56 module lines read `in ../../../opt/avm/…`, from the three calls in your
files down to the record-type submodules of the private DNS zone module. Not
one reads `Downloading`.

`(unauthenticated)` on every provider is not a failure. A filesystem mirror
carries no signatures for Terraform to check, so the image checked each
provider zip against the SHA256 the registry publishes for it, at build time.
The same six providers installed from the registry in part 3 read
`signed by HashiCorp` or `signed by a HashiCorp partner`.

**Verify:** the last line is `Success! The configuration is valid.`, and
`echo $?` straight after prints `0`.

### 6. Look at what it left behind

```bash
du -sh /tmp/run/src/.terraform
```

```text
108K	/tmp/run/src/.terraform
```

With the network on, a plain `terraform init` of the same folder in the same
image leaves 31 MB, nearly all of it downloaded modules. Here nothing was
downloaded: the modules are used where they sit and the providers are symlinks.

Type `exit` to leave. `--rm` deletes the container, and `/tmp/run` with it.

### 7. Run it exactly the way a lab job does

Step 2 turned the network off. A lab job also runs on a read-only root, as uid
65534, with every capability dropped and one 64 MB tmpfs it owns. To see the
check pass under all of it, from the same folder:

PowerShell:

```powershell
docker run --rm --network none --read-only --security-opt no-new-privileges --cap-drop ALL --user 65534:65534 --tmpfs "/tmp/run:rw,size=64m,uid=65534,gid=65534,mode=0700" -v "${PWD}:/workspace:ro" "hybridcloudworks/hcw-lab@$d" hcw-terraform-validate
```

bash:

```bash
docker run --rm --network none --read-only --security-opt no-new-privileges --cap-drop ALL --user 65534:65534 --tmpfs "/tmp/run:rw,size=64m,uid=65534,gid=65534,mode=0700" -v "$PWD:/workspace:ro" "hybridcloudworks/hcw-lab@$d" hcw-terraform-validate
```

The tmpfs option is quoted so it reaches Docker as one argument in either
shell. Its `uid`, `gid` and `mode` are not decoration: Docker mounts a tmpfs
owned by root by default, and the bare `--tmpfs /tmp/run:rw,size=64m` the
runner first used gave `Permission denied` on the first write.

**Verify:** the same `Success! The configuration is valid.` The runner itself
uses the `hcw-lab-runner` image and adds memory, CPU and process limits on top;
the flags above are the rest of its sandbox.

The builder's full default build, every platform component with one corp and
one online landing zone, ends on the same line. Its report has six rewrites
instead of three; the extra three are the spokes, each like this one:

```text
  rewrote module "spoke_corp_1" (Azure/avm-res-network-virtualnetwork/azurerm 0.22.2) -> ../../../opt/avm/avm-res-network-virtualnetwork@0.22.2
```

Its init prints 71 module lines, and none of them reads `Downloading`.

---

## How to know it worked

Four results, and the two in the middle are the evidence:

- `terraform version` prints `Terraform v1.16.4`, the version in
  `versions.env`.
- A plain `terraform init -backend=false` fails at
  `Error accessing remote module registry`.
- `hcw-terraform-validate`, in the same container, ends
  `Success! The configuration is valid.`
- Your folder is unchanged: nine files and no `.terraform.lock.hcl`, because
  the mount was read-only.

Neither of the middle two proves anything alone. A plain init that succeeded
would mean the network was on, and then a passing validate says nothing about
offline. The failure is what makes the success mean something.

---

## When it doesn't work

**`Failed to update dependency lock file` … `read-only file system`, straight
after `Terraform has created a lock file .terraform.lock.hcl`.** You ran a plain
`terraform init` with the network on and the folder mounted `:ro`. Terraform
downloads everything, announces the lock file, and only then fails to write it
beside your configuration, so the line that reads like success comes first. Use
`hcw-terraform-validate`, which works on a copy, or mount without `:ro`.

**`left    module "spoke_corp_1" (Azure/avm-res-network-virtualnetwork/azurerm 0.22.2): no vendored version satisfies it (have: 0.15.0)`**,
then `Error accessing remote module registry` … `network is unreachable`. Your
copy of the image is older than your files. Every spoke calls the virtual
network module at 0.22.2; an `hcw-lab` published before 2026-09-27 vendors
only 0.15.0, as a child of the connectivity module, and every image since
carries both. The error at the bottom names the network; the cause is at
the top, in the rewrite report, one `left` line per module block the image
cannot serve. Pull again (step 1). The builder and the image take a new module
release together, and a check in the repository fails when they disagree, but
the copy on your machine moves only when you pull it. If you changed a version
in the files yourself, turn the network on instead: without `--network none`,
on a writable mount, a plain `terraform init -backend=false` downloads the
modules and still takes every provider from the mirror.

**`provider registry.terraform.io/hashicorp/azuread was not found in any of the search locations`**,
followed by `- /opt/terraform/mirror`. You asked for a provider the mirror does
not carry. With no `direct` fallback it fails at once instead of timing out.
With the network on, `TF_CLI_CONFIG_FILE=/dev/null terraform init` uses the
registry for that one command.

**`Warning: Incomplete lock file information for providers`.** Also with the
network on. The lock file holds checksums for `linux_amd64` only, because the
providers came from a mirror built for that platform. It is harmless inside the
container. Do not commit that lock file to a repository someone will
initialise on another platform: Terraform's own warning says it "will fail to
install these providers".

---

## What's next

[Part 3](https://hybridcloudworks.com/terraform/blog/let-an-agent-explain-it) opens the same folder in a Docker
sandbox with an agent in it, lets the agent run `init` with a network, and
reads the file that tells it never to run `apply`.

## Try next: Explain this component

Go back to the builder with this build — the card's link carries it — press
**Read about** on **Management**, then **Explain this component**. You have just
watched `init` resolve `avm-ptn-alz-management` 0.9.0 from `/opt/avm`. The two
paragraphs that come back, labelled as generated by AI, are about what that
module creates in this build; check them against `management.tf`.

The labs that run in this image are at
<https://hybridcloudworks.com/education/labs>. A browser workspace running the
same image is coming; until it is, the `docker run` line in step 2 is the lab.

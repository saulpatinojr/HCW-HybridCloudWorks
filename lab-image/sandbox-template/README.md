# hcw-lz-sandbox: run an agent against your landing zone

The Docker Sandboxes recipe behind "Run an agent against your landing zone"
on <https://hybridcloudworks.com/education/labs> (issue #676, Phase 3 of
#658). Three files:

| File         | What it is                                                                                                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile` | `docker/sandbox-templates:claude-code` (Docker's Claude Code template, pinned by digest) plus terraform and the Azure CLI at the versions in [`../versions.env`](../versions.env), with the CLI's outdated Python packages replaced as the lab image replaces them (`AZURE_CLI_PYTHON_OVERRIDES` there), and `AGENTS.md` installed as the agent's briefing. linux/amd64 only. |
| `AGENTS.md`  | Tells the agent the folder is a landing zone generated for learning: run `terraform init -backend=false`, `fmt -check` and `validate`, explain the files, and never `plan`, `apply` or reach a tenant. Installed as `/home/agent/.claude/CLAUDE.md` too. |
| `README.md`  | This file: every command, PowerShell first, then bash.                                                                                                                                                                                                 |

Everything below was read from the Docker documentation on 2026-09-25 and
the issue carries `live-check` because the `sbx` CLI moves quickly; the pages
are cited at the top of the Dockerfile. Local sandboxes are free
(<https://docs.docker.com/ai/sandboxes/>). Nothing here talks to this site.

## What you need

- The `sbx` CLI, signed in (<https://docs.docker.com/ai/sandboxes/install/>).
  On Windows that is `winget install -h Docker.sbx` with the Hypervisor
  Platform feature enabled; then `sbx login`.
- Docker Desktop, to build the template
  (<https://docs.docker.com/ai/sandboxes/customize/kits-v2/#build-a-custom-template>).
- An Anthropic API key stored with `sbx secret set anthropic`, or a Claude
  subscription and `/login` inside Claude Code
  (<https://docs.docker.com/ai/sandboxes/agents/claude-code/#authentication>).
- A landing zone from <https://hybridcloudworks.com/tools/landing-zone>,
  downloaded as `landing-zone.zip` and unzipped.

## Build and load the template once

From a checkout of this repository on `main` (the recipe landed with #676;
`Test-Path lab-image/sandbox-template/Dockerfile` should print `True`). The
build context is `lab-image`, not this directory, so the Dockerfile reads
`versions.env` from its one home. `--platform linux/amd64` because the
checksums in `versions.env` are amd64.

PowerShell:

```powershell
docker build --platform linux/amd64 -f lab-image/sandbox-template/Dockerfile -t hcw-lz-sandbox:v1 lab-image
```

bash:

```bash
docker build --platform linux/amd64 -f lab-image/sandbox-template/Dockerfile -t hcw-lz-sandbox:v1 lab-image
```

A successful build ends with `naming to docker.io/library/hcw-lz-sandbox:v1`
and `docker image ls hcw-lz-sandbox` shows one row (3.38 GB on disk when
measured on 2026-09-25 with Docker 29.8.0; the base image is 2.4 GB of it).
A build that stops with `Azure CLI <version> already ships <package> ...` is
the recipe refusing to downgrade a package inside the CLI: a newer CLI now
carries that version itself, and the fix is to remove that package's line
from `AZURE_CLI_PYTHON_OVERRIDES` in [`../versions.env`](../versions.env).

Nobody publishes this image, so the repository builds it the same way to
keep the recipe honest: the publish workflow
([`publish-lab-image.yml`](../../.github/workflows/publish-lab-image.yml))
builds and smoke-tests it on every pull request that touches `lab-image/`,
and the weekly supply-chain run
([`lab-supply-chain.yml`](../../.github/workflows/lab-supply-chain.yml))
builds it from `main` and scans it with Trivy beside the published lab
images (#1473).

The sandbox runtime keeps its own image store, so a locally built image is
handed to it as a tar
(<https://docs.docker.com/ai/sandboxes/usage/#load-a-template>). Pushing to
a registry and passing the full `docker.io/...` reference to `--template`
works too, and is the only route for cloud sandboxes.

PowerShell:

```powershell
docker image save hcw-lz-sandbox:v1 -o hcw-lz-sandbox.tar
```

```powershell
sbx template load hcw-lz-sandbox.tar
```

bash:

```bash
docker image save hcw-lz-sandbox:v1 -o hcw-lz-sandbox.tar
```

```bash
sbx template load hcw-lz-sandbox.tar
```

`sbx template ls` then lists `hcw-lz-sandbox:v1`.

## Let terraform reach the registry

A local sandbox's outbound traffic is deny-by-default
(<https://docs.docker.com/ai/sandboxes/security/>); the built-in `claude`
kit allows Anthropic's endpoints and nothing else. `terraform init` fetches
providers from `registry.terraform.io` and `releases.hashicorp.com`, and the
Azure Verified Modules the builder declares from `github.com` through
`codeload.github.com`. Allow those four for this sandbox only
(<https://docs.docker.com/reference/cli/sbx/policy/allow/network/>); the
rule is created before the sandbox and applies when it is.

PowerShell:

```powershell
sbx policy allow network --sandbox hcw-lz "registry.terraform.io:443,releases.hashicorp.com:443,github.com:443,codeload.github.com:443"
```

bash:

```bash
sbx policy allow network --sandbox hcw-lz "registry.terraform.io:443,releases.hashicorp.com:443,github.com:443,codeload.github.com:443"
```

`sbx policy ls hcw-lz` shows the four hosts.

## Create the sandbox and open the agent

Change into the unzipped `landing-zone` folder first. `sbx run` creates the
sandbox on the first run and reattaches on the next; the folder is mounted
inside at the same absolute path it has on your machine
(<https://docs.docker.com/ai/sandboxes/architecture/>). Both lines are the
same text — `sbx` takes the same arguments at either prompt and `.` is the
current directory in both.

PowerShell:

```powershell
sbx run --name hcw-lz --template hcw-lz-sandbox:v1 claude .
```

bash:

```bash
sbx run --name hcw-lz --template hcw-lz-sandbox:v1 claude .
```

Claude Code opens in the folder. Paste this first:

> Explain what this landing zone deploys, then run terraform init
> -backend=false, terraform fmt -check and terraform validate and tell me what
> each printed.

A successful run ends with the agent reporting `Success! The configuration
is valid.` from `terraform validate`, no file listed by `terraform fmt
-check`, and a walk through `terraform.tf`, `providers.tf`, `variables.tf`
and each component file. Detach with `Ctrl+\`; remove the sandbox with
`sbx rm hcw-lz` when you are done.

## Cloud sandboxes

`sbx --cloud` runs the same agent on Docker-managed compute. It needs an
active Docker Agentic Platform subscription on your own account and `sbx`
0.45.0 or later, cannot mount a folder from your machine (transfer the
files in or clone a repository inside), keeps a separate secret store
(`sbx --cloud secret set anthropic`), and expires after one hour by default
(<https://docs.docker.com/ai/sandboxes/cloud/>). A cloud sandbox takes a
template from the cloud registry (`sbx template load ... --cloud --cpus 2
--memory-mib 2048`, then `sbx --cloud create -t hcw-lz-sandbox`); that path
was not exercised for this recipe and is documented here only so the local
and cloud differences are not a surprise.

## What was and was not verified on 2026-09-25

- Verified: the Dockerfile builds; inside the image `terraform version`
  prints the pinned version, `az version` prints the pinned version (the
  `-1~resolute` build, from the base image's own Ubuntu 26.04 suite, not the
  Debian build the lab image installs), the
  user is `agent` (uid 1000) with `/home/agent/.claude/CLAUDE.md` present,
  and `terraform init -backend=false`, `terraform fmt -check` and
  `terraform validate` succeed against a Landing Zone Builder emission with
  every component selected (run as a plain `docker run` with the folder
  mounted, since the `sbx` CLI was not installed on the build machine).
- Not verified: `sbx template load`, `sbx policy allow network` and
  `sbx run --template` themselves, which need the `sbx` CLI and a
  hypervisor. The command shapes are the documentation's, cited above.

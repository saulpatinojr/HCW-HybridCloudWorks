# hcw-lab: the Coder workspace template for the browser labs (#659, Phase 1
# in #679). Coder's Docker starter template
# (github.com/coder/coder, examples/templates/docker/main.tf) adapted to the
# boundary ADR 0032 draws around a workspace:
#
#   - the workspace container never gets the Docker socket, `privileged`, or
#     a host path; its one mount is a per-workspace named volume;
#   - it runs as uid 65534 (`nobody`), which is what the hcw-lab image's
#     `full` target already drops to (lab-image/Dockerfile, `USER 65534:65534`);
#     the image gives that uid `/bin/bash` and home `/tmp/home` in its own
#     /etc/passwd, which the Coder agent needs because it runs every script
#     through the passwd shell (#693), so the template writes no passwd;
#   - it joins its own bridge network, created and destroyed with the
#     container, with no route to the Compose network Coder and PostgreSQL
#     share;
#   - 2 GiB of memory and one CPU, hard limits;
#   - the cloud CLIs keep their sign-ins on a tmpfs, never on the volume, so
#     a sign-in lasts until the workspace stops (#954);
#   - a learner runs one workspace at a time: a start is refused while
#     another of theirs is starting or running (#954).
#
# template.test.mjs beside this file reads it as text and fails when any of
# those stops being true. The Coder server that runs this template holds no
# socket: it reaches Docker through coder-docker-proxy, and the daemon behind
# that proxy is the rootless one the coder_sandbox role runs as the
# unprivileged user hcw-coder-docker (lab-host/coder/docker-compose.yml;
# LAB-5, 2026-10-07). Every workspace runs on that daemon, so even a
# container this template did not describe would be that user's, not root's.
#
# Published from the host by /usr/local/sbin/hcw-coder-template-push, which
# pushes this directory's *.tf, lock file and README and then sets the
# one-hour default autostop (`coder templates push` has no TTL flag): the one
# line in lab-host/README.md, "Publishing the template", run again whenever
# this file changes on main.

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    coder = {
      source  = "coder/coder"
      version = "2.18.0"
    }
    docker = {
      source  = "kreuzwerker/docker"
      version = "4.6.0"
    }
    http = {
      source  = "hashicorp/http"
      version = "3.6.2"
    }
  }
}

# The daemon, through the allowlisting socket proxy on the Compose network
# (lab-host/coder/docker-compose.yml, `coder-docker-proxy`; LAB-5,
# 2026-10-06). Before that the coder container held the socket and the
# provider's default host was that socket. Since 2026-10-07 the daemon behind
# the proxy is the coder_sandbox role's rootless one, not the host's. Named
# here as well as in the container's DOCKER_HOST, so the template reads true
# on its own.
provider "docker" {
  host = "tcp://coder-docker-proxy:2375"
}

locals {
  # docker.io/hybridcloudworks/hcw-lab, the `full` target of lab-image/Dockerfile,
  # published by .github/workflows/publish-lab-image.yml. Pulled by digest;
  # the tag is the commit the workflow built it from and is documentation
  # only (ADR 0032, decision 5: every learner-facing image is digest-pinned
  # where consumed).
  image_tag    = "f1d49fc8d81f43570563a125f8df280203674aa1"
  image_digest = "sha256:867e96e096b989cdfd6811e0300ecad899b62e89644e62483f57b93c87b91d77"
  image        = "docker.io/hybridcloudworks/hcw-lab@${local.image_digest}"

  # The image sets HOME=/tmp/home and owns it as 65534, so a named volume
  # mounted there inherits that ownership on first use (Docker copies the
  # image directory's contents and mode into an empty volume). /workspace is
  # the read-only mount point the job runner uses and is root-owned in the
  # image, which is why the persistent directory is not there.
  home       = "/tmp/home"
  lab_root   = "/tmp/home/lab"
  repo_url   = "https://github.com/saulpatinojr/HCW-HybridCloudWorks.git"
  repo_ref   = "main"
  uid        = "65534"
  memory_mib = 2048
  # CFS quota/period: 100000/100000 microseconds is one full CPU.
  cpu_period = 100000
  cpu_quota  = 100000

  # The lab catalogue (frontend/src/data/labs/catalogue.js, #681; providers,
  # objectives and steps since ADR 0033) keys on these ids. The site's pane
  # for a lab (/<provider>/education/labs/<id>, or /education/labs/<id> from
  # the index) loads the lab launcher with ?lab=<id>, which creates the
  # workspace from this template with param.lab=<id>. Adding a lab is one
  # row in the catalogue, one entry here (map, option and regex) and one in
  # the launcher's LAB_WORKSPACES; the catalogue's test holds all three to
  # the same ids. `source` is the path in this repository the startup script
  # checks out sparsely into the lab folder; empty means the folder starts
  # empty with a README that says what to put in it.
  labs = {
    "landing-zone-builder-output" = {
      title  = "Landing Zone Builder output"
      source = ""
      readme = <<-EOT
        # Landing Zone Builder output

        This folder is yours. Download the Terraform the Landing Zone Builder
        produced for you on hybridcloudworks.com, upload the zip here with
        File > Upload in the file explorer (or drag it in), unzip it in the
        terminal, and run:

            az login --use-device-code
            terraform init
            terraform validate

        `terraform init` needs the network, which this workspace has. The
        provider mirror at /opt/terraform/mirror is what the offline job
        runner uses; here TF_CLI_CONFIG_FILE is unset so `init` reaches the
        registry for anything the mirror does not hold.
      EOT
    }
    "terraform-validate-walkthrough" = {
      title  = "Terraform validate walkthrough"
      source = "lab-image/smoke/providers-only"
      readme = ""
    }
    "ansible-syntax-check-walkthrough" = {
      title  = "Ansible syntax-check walkthrough"
      source = "lab-host/ansible"
      readme = ""
    }
    "wsl-containers-walkthrough" = {
      title  = "WSL Containers walkthrough"
      source = ""
      readme = ""
    }
    "defender-wsl-plugin-walkthrough" = {
      title  = "Defender for Endpoint WSL2 plug-in walkthrough"
      source = ""
      readme = ""
    }
    "aws-transit-gateway-walkthrough" = {
      title  = "AWS Transit Gateway walkthrough"
      source = "lab-image/smoke/providers-only"
      readme = ""
    }
    "gcp-shared-vpc-walkthrough" = {
      title  = "Google Cloud Shared VPC walkthrough"
      source = "lab-image/smoke/providers-only"
      readme = ""
    }
    "vmware-hcx-migration-walkthrough" = {
      title  = "VMware HCX migration walkthrough"
      source = "lab-image/smoke/providers-only"
      readme = ""
    }
    "docker-sandbox-agent-walkthrough" = {
      title  = "Docker sandbox agent walkthrough"
      source = "lab-image/smoke/providers-only"
      readme = ""
    }
  }

  lab        = local.labs[data.coder_parameter.lab.value]
  lab_folder = local.lab.source == "" ? "${local.lab_root}/${data.coder_parameter.lab.value}" : "${local.lab_root}/${local.lab.source}"
}

data "coder_provisioner" "me" {}
data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

# Sign-ins in memory, and one running workspace per learner (owner decision
# 2026-10-16, #954). The same block, the agent's env and the container's
# tmpfs and precondition are in every template under lab-host/coder/templates;
# hcw-lab/template.test.mjs holds each of them to it.
locals {
  # The Azure, AWS and Google Cloud CLIs keep their sign-ins and settings
  # here, a tmpfs the container gets (docker_container.workspace, tmpfs), not
  # the home volume: memory only, gone when the workspace stops. Owned by the
  # learner's uid with mode 0700; noexec, nosuid and nodev, because nothing
  # in it is meant to run. az and gcloud create their directories, and the
  # start script makes the AWS CLI's (local.aws_home_link), so the tmpfs
  # starts empty.
  cloud_creds_dir = "/tmp/cloud-creds"
  cloud_creds_env = {
    AZURE_CONFIG_DIR            = "${local.cloud_creds_dir}/azure"
    AWS_CONFIG_FILE             = "${local.cloud_creds_dir}/aws/config"
    AWS_SHARED_CREDENTIALS_FILE = "${local.cloud_creds_dir}/aws/credentials"
    CLOUDSDK_CONFIG             = "${local.cloud_creds_dir}/gcloud"
  }
  # The AWS CLI keeps SSO tokens and assumed-role credentials in caches
  # under ~/.aws (sso/cache, cli/cache) that no setting moves, and newer
  # versions add more there. So the whole of ~/.aws is a link into the
  # tmpfs, made at every start, before anything else. A directory an
  # earlier start or the learner left at ~/.aws is removed first, with
  # whatever it held, so no sign-in outlives the workspace on the volume.
  aws_home_link = <<-EOT
    mkdir -p '${local.cloud_creds_dir}/aws'
    if [ ! -L "$HOME/.aws" ]; then rm -rf "$HOME/.aws"; fi
    ln -sfn '${local.cloud_creds_dir}/aws' "$HOME/.aws"
  EOT

  # How many of a learner's workspaces may be starting or running at once.
  # Stopped ones do not count: the launcher makes one workspace per lab.
  max_running_workspaces = 1
  # Coder's API as this template reaches it. The provisioner runs Terraform
  # inside the coder container (lab-host/coder/docker-compose.yml), where
  # Coder listens on 7080 (CODER_HTTP_ADDRESS), so the call never leaves the
  # container and the owner's token never crosses a network.
  coder_api_url = "http://127.0.0.1:7080"
  # The latest builds that leave a workspace's container running, or may: a
  # start that is queued, under way, done or being cancelled, and a stop
  # that failed. A failed start does not count, so a start this check
  # refused never holds the limit itself.
  blocking_builds = {
    start = ["pending", "starting", "running", "canceling"]
    stop  = ["failed"]
  }
  # The owner's other workspaces with such a latest build. This workspace's
  # own build is left out by id.
  other_running_workspaces = flatten([
    for listing in data.http.owner_workspaces : [
      for w in jsondecode(listing.response_body).workspaces : w.name
      if w.id != data.coder_workspace.me.id && contains(lookup(local.blocking_builds, w.latest_build.transition, []), w.latest_build.status)
    ]
  ])
}

# The owner's workspaces, read with the owner's own session token, which
# Coder mints for a start build and revokes on stop (provisionerdserver,
# regenerateSessionToken). Only on a start: a stop or delete build never
# calls it, and neither does a template import or dry run, which has no
# owner and no token (coder provider 2.18.0 reads an unset
# CODER_WORKSPACE_OWNER_SESSION_TOKEN as ""). The token is sensitive, so
# only whether it is set reaches count.
data "http" "owner_workspaces" {
  count = data.coder_workspace.me.start_count > 0 && nonsensitive(data.coder_workspace_owner.me.session_token != "") ? 1 : 0

  url = "${local.coder_api_url}/api/v2/workspaces?q=owner:me"
  request_headers = {
    Accept              = "application/json"
    Coder-Session-Token = data.coder_workspace_owner.me.session_token
  }
  request_timeout_ms = 10000

  retry {
    attempts     = 2
    min_delay_ms = 1000
  }

  # Fail closed: a start that cannot count the owner's workspaces does not
  # go ahead.
  lifecycle {
    postcondition {
      condition     = self.status_code == 200
      error_message = "Your lab workspace could not check your other lab workspaces (answer ${self.status_code}). Try again in a minute."
    }
  }
}

# One parameter: which lab folder to open. A dropdown of the catalogue ids;
# Coder rejects any value that is not one of the options, and the regex says
# the same thing a second way so a value that bypasses the form (the deep
# link's param.lab) is checked too.
data "coder_parameter" "lab" {
  name         = "lab"
  display_name = "Lab"
  description  = "Which lab folder to open in VS Code. Set by the lab's page on hybridcloudworks.com (a provider's Learn section, /<provider>/education/labs/<id>, or /education/labs/<id>)."
  type         = "string"
  form_type    = "dropdown"
  mutable      = false
  default      = "terraform-validate-walkthrough"
  order        = 1

  option {
    name  = "Landing Zone Builder output"
    value = "landing-zone-builder-output"
  }
  option {
    name  = "Terraform validate walkthrough"
    value = "terraform-validate-walkthrough"
  }
  option {
    name  = "Ansible syntax-check walkthrough"
    value = "ansible-syntax-check-walkthrough"
  }
  option {
    name  = "WSL Containers walkthrough"
    value = "wsl-containers-walkthrough"
  }
  option {
    name  = "Defender for Endpoint WSL2 plug-in walkthrough"
    value = "defender-wsl-plugin-walkthrough"
  }
  option {
    name  = "AWS Transit Gateway walkthrough"
    value = "aws-transit-gateway-walkthrough"
  }
  option {
    name  = "Google Cloud Shared VPC walkthrough"
    value = "gcp-shared-vpc-walkthrough"
  }
  option {
    name  = "VMware HCX migration walkthrough"
    value = "vmware-hcx-migration-walkthrough"
  }
  option {
    name  = "Docker sandbox agent walkthrough"
    value = "docker-sandbox-agent-walkthrough"
  }

  validation {
    regex = "^(landing-zone-builder-output|terraform-validate-walkthrough|ansible-syntax-check-walkthrough|wsl-containers-walkthrough|defender-wsl-plugin-walkthrough|aws-transit-gateway-walkthrough|gcp-shared-vpc-walkthrough|vmware-hcx-migration-walkthrough|docker-sandbox-agent-walkthrough)$"
    error = "lab must be one of the catalogue ids: landing-zone-builder-output, terraform-validate-walkthrough, ansible-syntax-check-walkthrough, wsl-containers-walkthrough, defender-wsl-plugin-walkthrough, aws-transit-gateway-walkthrough, gcp-shared-vpc-walkthrough, vmware-hcx-migration-walkthrough, docker-sandbox-agent-walkthrough."
  }
}

resource "coder_agent" "main" {
  arch                    = data.coder_provisioner.me.arch
  os                      = "linux"
  startup_script_behavior = "blocking"

  # Dispatches to the per-lab bootloader script (/usr/local/libexec/hcw-boot/hcw-boot)
  # baked into the digest-pinned hcw-lab image for the selected LAB_ID.
  startup_script = <<-EOT
    set -euo pipefail
    export HOME=${local.home}
    ${local.aws_home_link}
    export HCW_REPO_URL='${local.repo_url}'
    export HCW_REPO_REF='${local.image_tag}'
    LAB_ID='${data.coder_parameter.lab.value}'
    LAB_ROOT='${local.lab_root}'
    mkdir -p "$LAB_ROOT"

    /usr/local/libexec/hcw-boot/hcw-boot "$LAB_ID" "$LAB_ROOT"
  EOT

  # The agent hands these to every terminal, script and app it starts, so
  # the cloud CLIs find their configuration on the tmpfs (local.cloud_creds_env).
  env = merge(local.cloud_creds_env, {
    HOME                = local.home
    GIT_AUTHOR_NAME     = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_AUTHOR_EMAIL    = data.coder_workspace_owner.me.email
    GIT_COMMITTER_NAME  = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_COMMITTER_EMAIL = data.coder_workspace_owner.me.email
  })

  # Browser only: the site links learners to code-server, and the desktop
  # VS Code, SSH and port-forward helpers would advertise paths this lab does
  # not support.
  display_apps {
    vscode                 = false
    vscode_insiders        = false
    web_terminal           = true
    ssh_helper             = false
    port_forwarding_helper = false
  }

  metadata {
    display_name = "CPU"
    key          = "0_cpu_usage"
    script       = "coder stat cpu"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "Memory"
    key          = "1_ram_usage"
    script       = "coder stat mem"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "Home disk"
    key          = "2_home_disk"
    script       = "coder stat disk --path ${local.home}"
    interval     = 60
    timeout      = 1
  }
}

# VS Code in the browser. https://registry.coder.com/modules/coder/code-server,
# pinned to a module version and a code-server release. install_prefix is on
# the persistent volume with use_cached, so a restart does not re-download
# code-server. subdomain = true serves it at
# code-server--<workspace>--<owner>.coder.lab.hybridcloudworks.com (Coder
# v2.37.3 leaves the agent out of a named app's name), the name the wildcard
# certificate exists for and the one the lab launcher opens in the site's pane.
module "code-server" {
  count           = data.coder_workspace.me.start_count
  source          = "registry.coder.com/coder/code-server/coder"
  version         = "1.6.0"
  agent_id        = coder_agent.main.id
  folder          = local.lab_folder
  install_prefix  = "${local.home}/.code-server"
  install_version = "4.140.0"
  use_cached      = true
  subdomain       = true
  order           = 1

  # No release notices. code-server tells its users when a newer release is
  # out; here the release is this pin, and the notice's link opens a window
  # that the site's sandboxed pane cannot navigate, which a learner saw as a
  # blank window beside the lab (#911). The module passes this string to the
  # code-server command line as it is (module 1.6.0, `additional_args`).
  additional_args = "--disable-update-check"

  # The editor's User settings. The module (1.6.0, `settings`) merges them
  # into ~/.local/share/code-server/User/settings.json before code-server
  # starts, on every start, with jq or python3 (the image has python3). Each
  # is checked against VS Code 1.140.0, the release code-server 4.140.0
  # carries; template.test.mjs pins them and both versions.
  settings = {
    # Workspace Trust off. With it on, the lab folder opened in Restricted
    # Mode (2026-09-28), and the learner had to trust it before extensions
    # and tasks ran. The folder is this repository's, checked out by the
    # startup script, in a workspace that is disposable and isolated (uid
    # 65534, no socket, no host path, no capabilities), so trust guards
    # nothing here. Application scope, so it is read from User settings.
    "security.workspace.trust.enabled" = false
    # The built-in AI features off and hidden, the Chat panel with them. It
    # opened on the right ("Build with Agent") and asked for a sign-in the
    # site does not offer. VS Code 1.139.1 describes it as "Disable and hide
    # built-in AI features provided by GitHub Copilot, including chat and
    # inline suggestions".
    "chat.disableAIFeatures" = true
    # The lab folder's README first, where the folder has one (the Landing
    # Zone Builder lab's startup script writes one); VS Code falls back to
    # its Welcome page where there is none. Read only as a User setting.
    "workbench.startupEditor" = "readme"
    # No usage data leaves a learner's editor.
    "telemetry.telemetryLevel" = "off"
    # Right-clicking in the integrated terminal copies when text is selected
    # and pastes when nothing is selected, matching standard terminal workflow.
    "terminal.integrated.rightClickBehavior" = "copyPaste"
  }
}

# The image, by digest. keep_locally so a workspace delete does not remove the
# 484 MB pull every other workspace shares.
resource "docker_image" "hcw_lab" {
  name         = local.image
  keep_locally = true
}

# One volume per workspace, kept across stops (no count) so a learner's files
# survive the one-hour autostop. Deleting the workspace deletes it.
resource "docker_volume" "home" {
  name = "coder-${data.coder_workspace.me.id}-home"

  lifecycle {
    ignore_changes = all
  }

  labels {
    label = "com.coder.resource"
    value = "true"
  }
  labels {
    label = "coder.owner"
    value = data.coder_workspace_owner.me.name
  }
  labels {
    label = "coder.owner_id"
    value = data.coder_workspace_owner.me.id
  }
  labels {
    label = "coder.workspace_id"
    value = data.coder_workspace.me.id
  }
  labels {
    label = "coder.workspace_name_at_creation"
    value = data.coder_workspace.me.name
  }
}

# The workspace's own bridge network, created with the container and removed
# with it (count follows start_count so stopped workspaces do not hold one of
# Docker's finite address pools). Not `internal`, so `az login` and
# `terraform init` reach the internet; not the Compose network, so the
# container has no route to Coder's PostgreSQL or to the server's socket.
resource "docker_network" "workspace" {
  count      = data.coder_workspace.me.start_count
  name       = "coder-ws-${data.coder_workspace.me.id}"
  driver     = "bridge"
  internal   = false
  attachable = false

  labels {
    label = "com.coder.resource"
    value = "true"
  }
  labels {
    label = "coder.workspace_id"
    value = data.coder_workspace.me.id
  }
}

resource "docker_container" "workspace" {
  count = data.coder_workspace.me.start_count
  image = docker_image.hcw_lab.image_id
  # lower() because Docker restricts container names and workspace names may
  # carry capitals.
  name     = "coder-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  hostname = data.coder_workspace.me.name

  # The image already drops to 65534; stated here so the template, not the
  # image, is what template.test.mjs holds to it.
  user = "65534:65534"

  entrypoint = ["sh", "-c", coder_agent.main.init_script]
  env = [
    "CODER_AGENT_TOKEN=${coder_agent.main.token}",
    "HOME=${local.home}",
  ]

  # Hard limits: 2 GiB with no swap on top, one CPU. cpu_shares is the
  # relative weight when the host is contended; the quota is the ceiling.
  memory      = local.memory_mib
  memory_swap = local.memory_mib
  cpu_shares  = 1024
  cpu_period  = local.cpu_period
  cpu_quota   = local.cpu_quota

  # Nothing a lab needs requires a capability, and the process is not root
  # anyway; dropping them all and forbidding privilege gain is what makes
  # that true for anything a learner runs too.
  privileged    = false
  security_opts = ["no-new-privileges:true"]
  capabilities {
    drop = ["ALL"]
  }

  networks_advanced {
    name = docker_network.workspace[count.index].name
  }

  # The only mount: the per-workspace named volume. No host_path anywhere in
  # this file, by design and by test.
  volumes {
    container_path = local.home
    volume_name    = docker_volume.home.name
    read_only      = false
  }

  # The cloud CLIs' sign-ins, in memory (local.cloud_creds_dir). The tmpfs
  # map rather than a `mounts` block: a mount's tmpfs_options take only mode
  # and size (docker provider 4.6.0), and the learner's uid and gid are what
  # let them write there. What is written there counts against the 2 GiB
  # memory limit, up to its 64 MiB.
  tmpfs = {
    (local.cloud_creds_dir) = "rw,nosuid,nodev,noexec,size=64m,uid=65534,gid=65534,mode=0700"
  }

  # One workspace at a time per learner (local.max_running_workspaces).
  # Checked at plan, so a refused start creates nothing; Coder shows the
  # message in the build log, and the lab launcher shows it in hcw-lab's
  # panes (lab-host/coder/launcher/launcher.js, LIMIT_REFUSAL).
  lifecycle {
    precondition {
      condition     = length(local.other_running_workspaces) < local.max_running_workspaces
      error_message = "Only ${local.max_running_workspaces == 1 ? "one lab workspace" : "${local.max_running_workspaces} lab workspaces"} can run at a time. Stop your other lab first: ${join(", ", local.other_running_workspaces)}."
    }
  }

  labels {
    label = "com.coder.resource"
    value = "true"
  }
  labels {
    label = "coder.owner"
    value = data.coder_workspace_owner.me.name
  }
  labels {
    label = "coder.owner_id"
    value = data.coder_workspace_owner.me.id
  }
  labels {
    label = "coder.workspace_id"
    value = data.coder_workspace.me.id
  }
  labels {
    label = "coder.workspace_name"
    value = data.coder_workspace.me.name
  }
  labels {
    label = "hcw.lab"
    value = data.coder_parameter.lab.value
  }
}

# What the dashboard shows on the workspace page.
resource "coder_metadata" "workspace" {
  count       = data.coder_workspace.me.start_count
  resource_id = docker_container.workspace[0].id

  item {
    key   = "lab"
    value = local.lab.title
  }
  item {
    key   = "image"
    value = "hcw-lab ${substr(local.image_tag, 0, 12)} (${substr(local.image_digest, 0, 19)})"
  }
  item {
    key   = "limits"
    value = "1 CPU, 2 GiB, no socket, no host path"
  }
}

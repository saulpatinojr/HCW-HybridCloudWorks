# Coder template (amo-guided-lab): per-user, time-limited Docker workspace preloaded with one assessment bundle.
# Hardened to the ADR-0032 / LAB-5 boundary:
#   - reaches the rootless sandbox daemon via tcp://coder-docker-proxy:2375 (never a host Docker socket);
#   - runs as uid 65534:65534 (nobody) with HOME=/tmp/home on a per-workspace named volume (no host_path);
#   - drops all Linux capabilities, forbids privilege escalation, and attaches to an isolated per-workspace bridge network;
#   - keeps the cloud CLIs' sign-ins on a tmpfs, never on the volume, so a sign-in lasts until the workspace stops (#954);
#   - refuses a start while another workspace of the same learner is starting or running (#954);
#   - serves code-server via subdomain = true (compatible with CODER_DISABLE_PATH_APPS=true on the lab host);
#   - dispatches to /usr/local/libexec/hcw-boot/hcw-boot migration-assessment (with python3 -m zipfile fallback).

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

provider "docker" {
  host = "tcp://coder-docker-proxy:2375"
}

locals {
  image_tag      = "e3d24c3eab7ca2d4eb314cef190197f9700733da"
  image_digest   = "sha256:f92a9bbafc73a577a23b4f2392c58ac4fb7c7afd0cbf3be12700cb28548be54c"
  default_image  = "docker.io/hybridcloudworks/hcw-lab@${local.image_digest}"
  home           = "/tmp/home"
  assessment_dir = "/tmp/home/assessment"
  uid            = "65534:65534"
  memory_mib     = 2048
  cpu_period     = 100000
  cpu_quota      = 100000
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

data "coder_parameter" "assessment_id" {
  name         = "assessment_id"
  display_name = "Assessment ID"
  type         = "string"
  default      = "00000000-0000-0000-0000-000000000000"
  mutable      = false
  validation {
    regex = "^[0-9a-f-]{36}$"
    error = "must be an assessment UUID"
  }
}

data "coder_parameter" "bundle_token" {
  name         = "bundle_token"
  display_name = "One-time bundle token"
  type         = "string"
  default      = ""
  mutable      = true
  ephemeral    = true
}

data "coder_parameter" "api_base_url" {
  name         = "api_base_url"
  display_name = "Lab API base URL"
  type         = "string"
  mutable      = false
  default      = "https://migration.lab.hybridcloudworks.com"
}

resource "coder_agent" "main" {
  arch                    = data.coder_provisioner.me.arch
  os                      = "linux"
  startup_script_behavior = "blocking"

  startup_script = <<-EOT
    set -euo pipefail
    ${local.aws_home_link}
    mkdir -p "$HCW_ASSESSMENT_DIR"

    if [ -x /usr/local/libexec/hcw-boot/hcw-boot ] && [ -x /usr/local/libexec/hcw-boot/migration-assessment.sh ]; then
      /usr/local/libexec/hcw-boot/hcw-boot migration-assessment "${local.home}/lab"
    else
      if [ -n "$HCW_BUNDLE_TOKEN" ] && [ "$HCW_ASSESSMENT_ID" != "00000000-0000-0000-0000-000000000000" ]; then
        curl --proto '=https' --tlsv1.2 -fsSL \
          -H "x-bundle-token: $HCW_BUNDLE_TOKEN" \
          "$${HCW_API_BASE_URL%/}/api/assessments/$HCW_ASSESSMENT_ID/bundle.zip" \
          -o "$HCW_ASSESSMENT_DIR/bundle.zip"
        python3 -m zipfile -e "$HCW_ASSESSMENT_DIR/bundle.zip" "$HCW_ASSESSMENT_DIR"
        rm -f "$HCW_ASSESSMENT_DIR/bundle.zip"
      fi
      cat > "$HCW_ASSESSMENT_DIR/START-HERE.md" <<'MD'
    # Guided migration inspection lab

    1. Read `DEMO-NOT-FOR-PRODUCTION.md`.
    2. Review `reports/executive-summary.md` and `reports/engineering-assessment.md`.
    3. In `terraform/`: run `terraform init -backend=false && terraform validate` (no cloud access here).
    4. In `scripts/`: read the dry-run scaffolding; nothing here can reach Azure (no credentials in this workspace).
    5. In `terraform/state-impact/`: inspect how an ARM move would affect Terraform state.
    6. In `runbooks/` and `validation/`: adapt the checklists to your own environment.
    MD
      if [ ! -f "$HCW_ASSESSMENT_DIR/README.md" ]; then
        cp "$HCW_ASSESSMENT_DIR/START-HERE.md" "$HCW_ASSESSMENT_DIR/README.md"
      fi
    fi
  EOT

  # The agent hands these to every terminal, script and app it starts, so
  # the cloud CLIs find their configuration on the tmpfs (local.cloud_creds_env).
  env = merge(local.cloud_creds_env, {
    HOME                = local.home
    HCW_ASSESSMENT_ID   = data.coder_parameter.assessment_id.value
    HCW_BUNDLE_TOKEN    = data.coder_parameter.bundle_token.value
    HCW_API_BASE_URL    = data.coder_parameter.api_base_url.value
    HCW_ASSESSMENT_DIR  = local.assessment_dir
    GIT_AUTHOR_NAME     = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_AUTHOR_EMAIL    = data.coder_workspace_owner.me.email
    GIT_COMMITTER_NAME  = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_COMMITTER_EMAIL = data.coder_workspace_owner.me.email
  })

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

module "code-server" {
  # checkov:skip=CKV_TF_1: Coder registry module pinned to exact release 1.6.0. docs/security/scanner-triage.md#checkov
  count           = data.coder_workspace.me.start_count
  source          = "registry.coder.com/coder/code-server/coder"
  version         = "1.6.0"
  agent_id        = coder_agent.main.id
  folder          = local.assessment_dir
  install_prefix  = "${local.home}/.code-server"
  install_version = "4.140.0"
  use_cached      = true
  subdomain       = true
  order           = 1
  additional_args = "--disable-update-check"

  settings = {
    "security.workspace.trust.enabled" = false
    "chat.disableAIFeatures"           = true
    "workbench.startupEditor"          = "readme"
    "telemetry.telemetryLevel"         = "off"
  }
}

resource "docker_image" "workspace" {
  name         = local.default_image
  keep_locally = true
}

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
  count    = data.coder_workspace.me.start_count
  image    = docker_image.workspace.image_id
  name     = "coder-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  hostname = data.coder_workspace.me.name

  user       = local.uid
  entrypoint = ["sh", "-c", coder_agent.main.init_script]
  env = [
    "CODER_AGENT_TOKEN=${coder_agent.main.token}",
    "HOME=${local.home}",
  ]

  memory      = local.memory_mib
  memory_swap = local.memory_mib
  cpu_shares  = 1024
  cpu_period  = local.cpu_period
  cpu_quota   = local.cpu_quota

  privileged    = false
  security_opts = ["no-new-privileges:true"]
  capabilities {
    drop = ["ALL"]
  }

  networks_advanced {
    name = docker_network.workspace[count.index].name
  }

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
    label = "hcw.addon"
    value = "migration"
  }
}

resource "coder_metadata" "workspace" {
  count       = data.coder_workspace.me.start_count
  resource_id = docker_container.workspace[0].id

  item {
    key   = "addon"
    value = "Azure Migration Orchestrator"
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

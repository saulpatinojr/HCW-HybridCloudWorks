# Coder template (na-guided-lab): per-user, time-limited Docker workspace preloaded with one Network Assessment bundle.
# Hardened to the ADR-0032 / LAB-5 boundary:
#   - reaches the rootless sandbox daemon via tcp://coder-docker-proxy:2375 (never a host Docker socket);
#   - runs as uid 65534:65534 (nobody) with HOME=/tmp/home on a per-workspace named volume (no host_path);
#   - drops all Linux capabilities, forbids privilege escalation, and attaches to an isolated per-workspace bridge network;
#   - serves code-server via subdomain = true (compatible with CODER_DISABLE_PATH_APPS=true on the lab host);
#   - dispatches to /usr/local/libexec/hcw-boot/hcw-boot network-assessment (with python3 -m zipfile fallback).

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
  }
}

provider "docker" {
  host = "tcp://coder-docker-proxy:2375"
}

locals {
  image_tag      = "bfbdb83426bfe6128c20ae0ea2a5c742172bd51e"
  image_digest   = "sha256:7cb89818525b470b5bc9269481b8d8b643e142f969287a289da03db17d4fc9d0"
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
  default      = "https://network-assessment.lab.hybridcloudworks.com"
}

resource "coder_agent" "main" {
  arch                    = data.coder_provisioner.me.arch
  os                      = "linux"
  startup_script_behavior = "blocking"

  startup_script = <<-EOT
    set -euo pipefail
    mkdir -p "$HCW_ASSESSMENT_DIR"

    if [ -x /usr/local/libexec/hcw-boot/hcw-boot ] && [ -x /usr/local/libexec/hcw-boot/network-assessment.sh ]; then
      /usr/local/libexec/hcw-boot/hcw-boot network-assessment "${local.home}/lab"
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
    # Guided network assessment lab

    1. Read `NOT-FOR-PRODUCTION.md` and `README.md`.
    2. Open `report.md` (or `SUMMARY.md`): review executive summary, topology classification, and rule findings.
    3. Inspect `findings.json` and `topology.json`: examine structured findings, observed-state facts, and VNet/peering graph.
    4. Review `rules.json` and `summary.json`: compare evaluated export rules against live-only unknowns.
    5. Use `jq` or `python3` in the terminal to filter findings by severity, category, or subscription (no cloud credentials or Azure access exist in this workspace).
    MD
      if [ ! -f "$HCW_ASSESSMENT_DIR/README.md" ]; then
        cp "$HCW_ASSESSMENT_DIR/START-HERE.md" "$HCW_ASSESSMENT_DIR/README.md"
      fi
    fi
  EOT

  env = {
    HOME                = local.home
    HCW_ASSESSMENT_ID   = data.coder_parameter.assessment_id.value
    HCW_BUNDLE_TOKEN    = data.coder_parameter.bundle_token.value
    HCW_API_BASE_URL    = data.coder_parameter.api_base_url.value
    HCW_ASSESSMENT_DIR  = local.assessment_dir
    GIT_AUTHOR_NAME     = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_AUTHOR_EMAIL    = data.coder_workspace_owner.me.email
    GIT_COMMITTER_NAME  = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_COMMITTER_EMAIL = data.coder_workspace_owner.me.email
  }

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
    value = "network-assessment"
  }
}

resource "coder_metadata" "workspace" {
  count       = data.coder_workspace.me.start_count
  resource_id = docker_container.workspace[0].id

  item {
    key   = "addon"
    value = "Azure Network Assessment"
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

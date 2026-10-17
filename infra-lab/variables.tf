# =============================================================================
# variables.tf — inputs for the lab host
#
# Names are bound to hcw-lab workspace variable keys by exact spelling; a
# renamed variable here with no matching rename in the workspace is an unset
# variable, and every one below without a default fails the plan rather than
# guessing. Required inputs §4.7 is the register.
#
# The provider prefix on these names is the collision breaker the naming
# standard allows ("third word only to break a real collision"): this module
# talks to two providers that each need a token, so `api_token` alone would not
# say which.
#
# The four hostinger_* identity values are copied by the owner from the
# Hostinger API response for the existing server (infra-lab/README.md, step 1)
# so that the imported state and this configuration agree. main.tf both
# ignores changes to them (so a typo can never reinstall or re-purchase) and
# asserts them in a postcondition (so a typo is a plan error that names the
# right value, instead of silently disagreeing with state).
# =============================================================================

variable "hostinger_api_token" {
  description = "Hostinger API token (hPanel > Account > API). hcw-lab only, never hcw-azure."
  type        = string
  sensitive   = true

  validation {
    condition     = length(trimspace(var.hostinger_api_token)) > 0
    error_message = "hostinger_api_token is empty."
  }
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token with Zone:Read + DNS:Edit on hybridcloudworks.com and nothing else."
  type        = string
  sensitive   = true

  validation {
    condition     = length(trimspace(var.cloudflare_api_token)) > 0
    error_message = "cloudflare_api_token is empty."
  }
}

variable "cloudflare_zone_id" {
  description = "Zone ID of hybridcloudworks.com (Cloudflare dashboard, zone Overview page, API section). An identifier, not a credential."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id is a 32-character lowercase hexadecimal string. Copy it from the zone's Overview page, not the account ID beside it."
  }
}

variable "hostinger_vps_id" {
  description = "Hostinger ID of the EXISTING virtual machine to adopt. The `id` field of GET /api/vps/v1/virtual-machines, and the number in the hPanel VPS overview URL."
  type        = string

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.hostinger_vps_id))
    error_message = "hostinger_vps_id is the numeric VM id (for example 17923), with no hostname or srv prefix."
  }
}

variable "hostinger_plan" {
  description = "The `plan` field of the existing VM, copied exactly (for example \"KVM 4\")."
  type        = string

  validation {
    condition     = length(trimspace(var.hostinger_plan)) > 0
    error_message = "hostinger_plan is empty. Copy the `plan` field from the API response."
  }
}

variable "hostinger_data_center_id" {
  description = "The `data_center_id` field of the existing VM."
  type        = number

  validation {
    condition     = var.hostinger_data_center_id >= 1 && floor(var.hostinger_data_center_id) == var.hostinger_data_center_id
    error_message = "hostinger_data_center_id is a positive whole number."
  }
}

variable "hostinger_template_id" {
  description = "The `template.id` field of the existing VM (the installed OS). The lab host expects Ubuntu 26.04 LTS (24.04 LTS is still accepted)."
  type        = number

  validation {
    condition     = var.hostinger_template_id >= 1 && floor(var.hostinger_template_id) == var.hostinger_template_id
    error_message = "hostinger_template_id is a positive whole number."
  }
}

variable "lab_hostname" {
  description = "Public name of the lab host. The A record, and the parent of the *.lab, coder.lab and *.coder.lab names."
  type        = string
  default     = "lab.hybridcloudworks.com"

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", var.lab_hostname))
    error_message = "lab_hostname is a lowercase fully qualified name with no trailing dot and no scheme."
  }
}

# Optional, and unset for the adoption plan. Setting it registers the key in
# the Hostinger account and attaches it to the VM, which puts it in
# /root/.ssh/authorized_keys: the key the first bootstrap.sh run logs in with
# as root. That run gives hcwadmin the keys pinned in
# lab-host/ansible/group_vars/all.yml, empties root's file and turns root
# and password login off, and it refuses to run unless this key is pinned
# there (#953). It is a second, separate plan with its own counts
# (infra-lab/README.md, "Adding an SSH key").
#
# ed25519 and RSA only. The provider's own validation accepts keys beginning
# `ssh-rsa`, `ssh-ed25519` or `ssh-ecdsa`, and real ECDSA keys begin
# `ecdsa-sha2-`, so an ECDSA key would pass here and fail at apply.
variable "ssh_public_key" {
  description = "Owner SSH public key (one line, ssh-ed25519 or ssh-rsa) to attach to the lab VM. Leave unset for the first plan."
  type        = string
  default     = null

  validation {
    condition     = var.ssh_public_key == null || can(regex("^(ssh-ed25519|ssh-rsa) [A-Za-z0-9+/=]+( .*)?$", var.ssh_public_key))
    error_message = "ssh_public_key is a single ssh-ed25519 or ssh-rsa public key line (the contents of the .pub file). ECDSA keys are not accepted by the provider."
  }
}

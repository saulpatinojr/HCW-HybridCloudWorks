# The Code Conductor brain's switches (#1457, ADR 0036). Separate from the
# creator Second Brain's brain_* variables on purpose: switching one on or off
# never changes the other. Every value here is empty or false by default, and
# none of the real values belongs in this public repository; they are set as
# HCP Terraform workspace variables.

variable "code_brain_enabled" {
  type        = bool
  default     = false
  description = "Enable the private Code Conductor brain for one explicitly configured owner and desktop client."
  validation {
    condition = !var.code_brain_enabled || (
      var.code_brain_owner_oid != "" &&
      var.code_brain_owner_tenant_id == var.entra_tenant_id &&
      var.code_brain_sync_client_id != "" &&
      lower(var.code_brain_sync_client_id) != lower(var.brain_sync_client_id)
    )
    error_message = "Enabling the Code Conductor brain requires its owner object ID, the API's tenant ID, and its own desktop client ID (not brain_sync_client_id)."
  }
}

variable "code_brain_owner_oid" {
  type        = string
  default     = ""
  description = "Entra object ID of the sole Code Conductor brain owner. Empty disables access."
  validation {
    condition     = var.code_brain_owner_oid == "" || can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.code_brain_owner_oid))
    error_message = "The owner object ID must be empty or a GUID."
  }
}

variable "code_brain_owner_tenant_id" {
  type        = string
  default     = ""
  description = "Entra tenant ID of the Code Conductor brain owner; must match the API tenant when enabled."
  validation {
    condition     = var.code_brain_owner_tenant_id == "" || can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.code_brain_owner_tenant_id))
    error_message = "The owner tenant ID must be empty or a GUID."
  }
}

variable "code_brain_sync_client_id" {
  type        = string
  default     = ""
  description = "Dedicated public desktop client authorized for code_brain_sync only; never the creator brain's client. Empty disables the workspace."
  validation {
    condition     = var.code_brain_sync_client_id == "" || can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.code_brain_sync_client_id))
    error_message = "The sync client ID must be empty or a GUID."
  }
}

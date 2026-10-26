variable "brain_enabled" {
  type        = bool
  default     = false
  description = "Enable the private Second Brain for one explicitly configured owner."
  validation {
    condition     = !var.brain_enabled || (var.brain_owner_oid != "" && var.brain_owner_tenant_id == var.entra_tenant_id)
    error_message = "Enabling Second Brain requires its owner object ID and the API's configured tenant ID."
  }
}

variable "brain_ai_enabled" {
  type        = bool
  default     = false
  description = "Allow owner-triggered, source-citing Second Brain calls through the Foundry AI task."
}

variable "brain_owner_oid" {
  type        = string
  default     = ""
  description = "Entra object ID of the sole Second Brain owner. Empty disables access."
  validation {
    condition     = var.brain_owner_oid == "" || can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.brain_owner_oid))
    error_message = "The owner object ID must be empty or a GUID."
  }
}

variable "brain_owner_tenant_id" {
  type        = string
  default     = ""
  description = "Entra tenant ID of the Second Brain owner; must match the API tenant when enabled."
  validation {
    condition     = var.brain_owner_tenant_id == "" || can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.brain_owner_tenant_id))
    error_message = "The owner tenant ID must be empty or a GUID."
  }
}

variable "brain_sync_client_id" {
  type        = string
  default     = ""
  description = "Dedicated public desktop client authorized for brain_sync only. Empty disables Obsidian sync."
  validation {
    condition     = var.brain_sync_client_id == "" || can(regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", var.brain_sync_client_id))
    error_message = "The sync client ID must be empty or a GUID."
  }
}

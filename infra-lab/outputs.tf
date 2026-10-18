# =============================================================================
# outputs.tf — the lab host's public names
#
# Hostnames only. The address is in the A record and in the VPS resource's
# state for anyone who needs it; it is not repeated as an output, because an
# address copied off the Outputs tab goes stale the day the host moves and the
# name does not.
# =============================================================================

output "lab_hostname" {
  description = "Public name of the lab host (the A record)."
  value       = cloudflare_dns_record.lab.name
}

output "lab_aliases" {
  description = "The CNAMEs that point at the lab host: the *.lab wildcard, coder.lab and the *.coder.lab wildcard."
  value       = sort([for record in cloudflare_dns_record.lab_alias : record.name])
}

output "lab_acme_delegations" {
  description = "The _acme-challenge CNAMEs in the production zone and the one name in the lab zone they point at; Caddy's dns_challenge_override_domain must be that name."
  value = {
    names  = sort([for record in cloudflare_dns_record.lab_acme_delegation : record.name])
    target = var.lab_acme_challenge_target
  }
}

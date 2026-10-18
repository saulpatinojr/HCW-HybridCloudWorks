# =============================================================================
# dns.tf — the lab host's public names in the hybridcloudworks.com zone
#
# Same resource type and v5 conventions as infra/frontend.tf: `name` is the
# full record name, and `ttl` is a real value because `1` (automatic) is only
# accepted on proxied records.
#
# All four are DNS-only (proxied = false). A second-level wildcard such as
# *.coder.lab is outside Cloudflare's Universal SSL, and Caddy on the host
# terminates TLS for every lab name with its own certificate (ADR 0032), so
# Cloudflare must hand out the host's address rather than its own.
#
# Why four records and not three. Cloudflare follows RFC 4592: a wildcard does
# not answer for a name that is an empty non-terminal, and the *.coder.lab
# record below makes coder.lab exactly that. Without its own record,
# coder.lab.hybridcloudworks.com (Coder's URL, the CODER-URL value in Key
# Vault) would return no address even though *.lab exists
# (developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records).
#
# Two _acme-challenge CNAMEs, since 2026-10-18 (#948, LAB-1). ADR 0032 chooses
# DNS-01 by CNAME delegation into a dedicated lab zone, and that zone is
# hybridcloudinsights.com, a domain the owner already held, connected to the
# same Cloudflare account that day (owner decision 2026-10-18). The names the
# ACME CA looks up, _acme-challenge.lab and _acme-challenge.coder.lab (for the
# apex, *.lab and *.coder.lab certificates), are CNAMEs to one target in the
# lab zone, var.lab_acme_challenge_target. Caddy writes its TXT records at
# that target: certmagic does not follow a CNAME on its own (it finds the zone
# by SOA walk), so roles/caddy renders `dns_challenge_override_domain` with
# the same name, and the runtime token is scoped to the lab zone alone. One
# target for both names is fine: certmagic keeps same-named TXT records apart
# by value. Nothing in this configuration touches the lab zone itself; this
# workspace holds the production zone id only.
# =============================================================================

locals {
  # Everything below points at the one A record, so moving the host is a
  # change to one address.
  lab_records = {
    wildcard       = "*.${var.lab_hostname}"
    coder          = "coder.${var.lab_hostname}"
    coder_wildcard = "*.coder.${var.lab_hostname}"
  }
  # The challenge names the ACME CA resolves for the three certificates: the
  # apex and *.lab share one, *.coder.lab has its own.
  lab_acme_challenge_names = {
    lab   = "_acme-challenge.${var.lab_hostname}"
    coder = "_acme-challenge.coder.${var.lab_hostname}"
  }
}

resource "cloudflare_dns_record" "lab" {
  zone_id = var.cloudflare_zone_id
  name    = var.lab_hostname
  content = hostinger_vps.lab.ipv4_address
  type    = "A"
  proxied = false
  ttl     = 300
  comment = "HCW lab host (Hostinger VPS), managed by infra-lab"

  # include_shadow_metadata is a request query parameter the provider surfaces
  # as an attribute with a static default since 5.26.0; left alone it plans
  # null -> false on every existing record and the forced PUT fails
  # "inconsistent result after apply: .modified_on" (cloudflare/
  # terraform-provider-cloudflare #7387, #7396; seen here 2026-10-06 on 5.27.0).
  # Ignoring it is the provider's documented workaround and changes nothing
  # about the record. Drop it when a release removes the default.
  lifecycle {
    ignore_changes = [include_shadow_metadata]
    # The provider sets ipv4_address to "" when the API lists no IPv4 address.
    # Fail the plan with a reason rather than send Cloudflare an empty A record.
    precondition {
      condition     = can(regex("^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$", hostinger_vps.lab.ipv4_address))
      error_message = "The adopted Hostinger VM reports no IPv4 address, so the lab A record cannot be written. Check the VM in hPanel; nothing has been changed."
    }
  }
}

resource "cloudflare_dns_record" "lab_alias" {
  for_each = local.lab_records

  zone_id = var.cloudflare_zone_id
  name    = each.value
  content = cloudflare_dns_record.lab.name
  type    = "CNAME"
  proxied = false
  ttl     = 300
  comment = "HCW lab host alias, managed by infra-lab"

  # include_shadow_metadata is a request query parameter the provider surfaces
  # as an attribute with a static default since 5.26.0; left alone it plans
  # null -> false on every existing record and the forced PUT fails
  # "inconsistent result after apply: .modified_on" (cloudflare/
  # terraform-provider-cloudflare #7387, #7396; seen here 2026-10-06 on 5.27.0).
  # Ignoring it is the provider's documented workaround and changes nothing
  # about the record. Drop it when a release removes the default.
  lifecycle {
    ignore_changes = [include_shadow_metadata]
  }
}

# The DNS-01 delegations (#948, LAB-1): the two challenge names are CNAMEs to
# one target in the dedicated lab zone, so the CA follows them there and
# Caddy, told the same name by dns_challenge_override_domain, writes its TXT
# records with a token that can edit that zone alone. DNS-only like the rest:
# a CNAME the CA must follow cannot sit behind the proxy.
resource "cloudflare_dns_record" "lab_acme_delegation" {
  for_each = local.lab_acme_challenge_names

  zone_id = var.cloudflare_zone_id
  name    = each.value
  content = var.lab_acme_challenge_target
  type    = "CNAME"
  proxied = false
  ttl     = 300
  comment = "HCW lab DNS-01 delegation into the lab zone, managed by infra-lab (#948)"

  # include_shadow_metadata: the same provider workaround as the records
  # above; drop it when a release removes the default.
  lifecycle {
    ignore_changes = [include_shadow_metadata]
  }
}

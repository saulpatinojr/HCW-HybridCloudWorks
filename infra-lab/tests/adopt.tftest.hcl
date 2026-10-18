# Offline contract tests for the adoption plan (#661). Run with
# `terraform init -backend=false && terraform test` in infra-lab/; CI runs them
# in .github/workflows/iac-validate.yml. No credential and no network call: both
# providers are mocked, and the adopted server's state is supplied by
# override_resource, because Terraform refuses to import from a mock provider.
#
# What these prove is the configuration's logic: the guards fire, the key path
# is off by default, the four names are the ones Caddy and Coder expect. What
# they cannot prove is the real provider's behaviour against the real server,
# which only the owner's first plan in hcw-lab shows (infra-lab/README.md,
# step 4).

mock_provider "hostinger" {}

mock_provider "cloudflare" {}

# The adopted server as the import would read it. Values are shaped like the
# Hostinger API's own example (VirtualMachineResource); the address is from
# the documentation range.
override_resource {
  target = hostinger_vps.lab
  values = {
    id             = "17923"
    vps_id         = 17923
    plan           = "KVM 4"
    data_center_id = 521
    template_id    = 1077
    hostname       = "srv17923.hstgr.cloud"
    ipv4_address   = "203.0.113.10"
    ipv6_address   = ""
    status         = "running"
  }
}

override_resource {
  target = hostinger_vps_ssh_key.owner
  values = {
    id = "42"
  }
}

variables {
  hostinger_api_token      = "test-token"
  cloudflare_api_token     = "test-token"
  cloudflare_zone_id       = "0123456789abcdef0123456789abcdef"
  hostinger_vps_id         = "17923"
  hostinger_plan           = "KVM 4"
  hostinger_data_center_id = 521
  hostinger_template_id    = 1077
}

run "adoption_plan_writes_the_four_lab_names" {
  command = plan

  assert {
    condition     = cloudflare_dns_record.lab.name == "lab.hybridcloudworks.com" && cloudflare_dns_record.lab.type == "A" && cloudflare_dns_record.lab.content == "203.0.113.10"
    error_message = "The lab A record must be lab.hybridcloudworks.com and carry the adopted server's IPv4 address."
  }

  assert {
    condition = toset([for r in cloudflare_dns_record.lab_alias : r.name]) == toset([
      "*.lab.hybridcloudworks.com",
      "coder.lab.hybridcloudworks.com",
      "*.coder.lab.hybridcloudworks.com",
    ])
    error_message = "The aliases must be *.lab, coder.lab and *.coder.lab. coder.lab needs its own record: *.coder.lab makes it an empty non-terminal, which *.lab does not answer for."
  }

  assert {
    condition     = alltrue([for r in cloudflare_dns_record.lab_alias : r.type == "CNAME" && r.content == "lab.hybridcloudworks.com"])
    error_message = "Every alias must be a CNAME to the one A record."
  }

  assert {
    condition     = !cloudflare_dns_record.lab.proxied && alltrue([for r in cloudflare_dns_record.lab_alias : !r.proxied])
    error_message = "Every lab record must be DNS-only: Caddy terminates TLS, and *.coder.lab is outside Universal SSL."
  }

  assert {
    condition = toset([for r in cloudflare_dns_record.lab_acme_delegation : r.name]) == toset([
      "_acme-challenge.lab.hybridcloudworks.com",
      "_acme-challenge.coder.lab.hybridcloudworks.com",
    ])
    error_message = "The DNS-01 delegations must be _acme-challenge.lab (apex and *.lab) and _acme-challenge.coder.lab (*.coder.lab), and nothing else (#948)."
  }

  assert {
    condition     = alltrue([for r in cloudflare_dns_record.lab_acme_delegation : r.type == "CNAME" && r.content == "_acme-challenge.lab.hybridcloudinsights.com" && !r.proxied && r.zone_id == var.cloudflare_zone_id])
    error_message = "Each delegation is a DNS-only CNAME in the production zone to the one target in the lab zone, the name roles/caddy renders as dns_challenge_override_domain."
  }

  assert {
    condition     = output.lab_acme_delegations.target == "_acme-challenge.lab.hybridcloudinsights.com" && length(output.lab_acme_delegations.names) == 2
    error_message = "The output names the two delegations and their one target."
  }

  assert {
    condition     = length(hostinger_vps_ssh_key.owner) == 0 && hostinger_vps.lab.ssh_key_ids == null
    error_message = "With ssh_public_key unset, the adoption plan must register no key and attach nothing."
  }

  assert {
    condition     = hostinger_vps.lab.post_install_script_id == null && hostinger_vps.lab.password == null && hostinger_vps.lab.payment_method_id == null
    error_message = "password, post_install_script_id and payment_method_id must stay unset; each belongs to purchase or reinstall."
  }

  assert {
    condition     = length([for name in output.lab_aliases : name if can(regex("^[0-9.]+$", name))]) == 0 && output.lab_hostname == "lab.hybridcloudworks.com"
    error_message = "Outputs are hostnames only."
  }
}

# Planned before anything is applied, so the address comes from the import
# (this override) rather than from the state a later run would refresh.
run "a_server_with_no_ipv4_address_writes_no_record" {
  command = plan

  override_resource {
    target = hostinger_vps.lab
    values = {
      id             = "17923"
      vps_id         = 17923
      plan           = "KVM 4"
      data_center_id = 521
      template_id    = 1077
      ipv4_address   = ""
    }
  }

  expect_failures = [cloudflare_dns_record.lab]
}

# Applied (against the mocks) so the runs below plan against a state that
# holds the server, which is the case ignore_changes and the postconditions are
# for.
run "adopted" {}

# A workspace variable that disagrees with the server must be a plan error,
# not a replacement (ignore_changes) and not silence (the postcondition).
run "mismatched_plan_variable_is_a_plan_error" {
  command = plan

  variables {
    hostinger_plan = "KVM 8"
  }

  expect_failures = [hostinger_vps.lab]
}

run "mismatched_template_variable_is_a_plan_error" {
  command = plan

  variables {
    hostinger_template_id = 9999
  }

  expect_failures = [hostinger_vps.lab]
}

run "mismatched_data_center_variable_is_a_plan_error" {
  command = plan

  variables {
    hostinger_data_center_id = 1
  }

  expect_failures = [hostinger_vps.lab]
}

# Applied, because the key's id is only known once the key exists.
run "setting_the_ssh_key_registers_and_attaches_it" {
  variables {
    ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq5x2Yl8i9dKf4b0j1f2Vd3mTQ6n0fW7a8b9c0d1e2f owner@laptop"
  }

  assert {
    condition     = length(hostinger_vps_ssh_key.owner) == 1 && hostinger_vps.lab.ssh_key_ids == tolist([42])
    error_message = "A set ssh_public_key must register one key and attach it to the VM."
  }
}

run "an_ecdsa_key_is_refused_before_the_provider_sees_it" {
  command = plan

  variables {
    ssh_public_key = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY= owner@laptop"
  }

  expect_failures = [var.ssh_public_key]
}

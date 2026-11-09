# ADR 0041: Native Terraform is the only infrastructure-as-code tool the site offers

**Status:** Accepted 2026-11-09 (owner decision)
**Decision date:** 2026-11-09
**Owners:** Workload owner

Related: issue [#1593](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1593)
(the fixed passphrase in the OpenTofu export, which this decision makes moot);
pull request [#1177](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1177)
(where the OpenTofu and Terragrunt export formats came in);
[ADR 0020](0020-native-terraform-root-module.md) (the site's own
infrastructure is a native Terraform root module).

## Context

Infrastructure as code (IaC) means describing cloud resources in text files
that a tool reads and builds. The site teaches it and, through the Landing
Zone Builder at `/tools/landing-zone`, generates it for visitors to download.

Since pull request #1177 (2026-10-15) the builder offered three export formats:
native Terraform (HashiCorp's tool, written in its HCL language), OpenTofu (a
fork of Terraform) and Terragrunt (a wrapper that runs Terraform). The
Terraform tools page also listed Terragrunt as a recommended tool. No decision
record approved either of the other two, and the OpenTofu export wrote the
same state-encryption passphrase into every download (#1593).

## Purpose and decision drivers

- The site recommends only tools it has chosen to stand behind.
- One tool to teach, test and keep current, instead of three.
- A download should never carry a shared secret a visitor might use as is.

## Decision

The owner's rule of 2026-11-09: "pure terraform should be the only approved
partner". Native Terraform (HashiCorp, HCL) is the only infrastructure-as-code
tool for what the site generates and teaches. Its forks and wrappers,
OpenTofu and Terragrunt by name, are not offered: no export format, no tool
card, no lab instruction and no recommendation on a public page.

## Consequences and accepted risks

- The Landing Zone Builder writes plain Terraform only, downloaded as
  `landing-zone.zip`; its format picker is removed. An old link that still
  carries a format value gets the Terraform files.
- The fixed passphrase of #1593 is gone with the OpenTofu emitter.
- `frontend/src/public-copy.test.js` fails a public page, component, hook or
  lab text that names OpenTofu or Terragrunt, so neither can return quietly.
- A visitor who uses OpenTofu or Terragrunt can still adapt the Terraform
  files themselves; the site does not explain how.

## Alternatives considered

- **Keep the formats and fix the passphrase** (the options on #1593):
  rejected by the owner, because the tools are not approved partners.
- **Keep Terragrunt only:** rejected for the same reason.

## Validation and revisit triggers

- Validated by the frontend tests that pin a Terraform-only export and the
  public-copy guard.
- Revisit only on a new owner decision that names another tool.

## Related decisions and references

- [ADR 0020](0020-native-terraform-root-module.md) · [ADR 0005](0005-github-terraform-delivery.md)

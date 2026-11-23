# ADR 0043: Muse reads the whole Azure estate through a Terraform-made app registration with a client secret

**Status:** Proposed (owner request of 2026-11-22; accepted when the owner merges
[#1763](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1763)'s pull request)
**Decision date:** 2026-11-22
**Owners:** Workload owner and architecture owner

## Context

Muse runs Koda, the owner's content agent
([ADR 0037](0037-agent-content-api.md), [ADR 0038](0038-koda-admin-access.md)).
When an alert fires, Koda investigates from the alert email alone: it cannot
see the logs, the alert rule, the cost or the resource's health that would
explain it. The owner asked on 2026-11-22
([#1763](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1763))
for:

- an Entra app registration and service principal for Muse, made by Terraform
  in `infra/`;
- the built-in **Reader** role at subscription scope on every subscription in
  the estate (application, management, connectivity), full read and not
  Application Insights only, so the gap the `github_reader` identity had (it
  could not read the Management subscription at all) is not repeated;
- a client secret made by Terraform and kept only in Terraform state, which
  the owner copies into Muse's own vault.

This is a new standing access grant, and it meets four things the
repository had settled the other way:

1. `infra/` had **no `azuread` provider**, and the HCP Terraform run identity
   (`id-plat-terraform-prod-cus-01`) holds **no Entra directory role**
   (`infra/oidc.tf` header, `infra/lab-hybrid.tf` onboarding note). Entra
   objects were owner-made by script (`Register-LabAgent.ps1`,
   `Register-LabArc.ps1`).
2. Since SEC-1 step two, **no role assignment in `infra/` sits above a
   resource group**. [ADR 0039](0039-cost-page.md) kept the Cost page's
   subscription-scope Cost Management Reader grant out of Terraform for that
   reason, and `scripts/terraform-identity-grants.test.mjs` refused any such
   block.
3. [Variables and secrets](../standards/variables-and-secrets.md) says secret
   values do not transit Terraform state, because state is a plaintext record
   readable by everyone who can read the workspace.
4. Microsoft advises against client secrets in production and prefers a
   certificate or a federated credential
   ([Add and manage app credentials](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials)).

## Purpose and decision drivers

- Operational Excellence: alert investigations start from evidence, not from
  the wording of an email.
- Security: read only, with no data action; the access is visible, rotated
  and revocable in one place; the secret is never in the repository, a pull
  request, an issue or a log.
- Reliability of the change itself: nothing is created until the one missing
  permission exists, so merging cannot fail an estate-wide apply halfway.

## Decision

1. **`infra/muse-reader.tf`** declares the app registration
   `sp-muse-reader-plat-prod-cus-01` (single tenant), its service principal
   (both owned by the run identity), a client secret
   (`azuread_application_password`) and three `azurerm_role_assignment`
   blocks, built-in **Reader** at `/subscriptions/<id>` on the application,
   management and connectivity subscriptions, each through that
   subscription's provider. The `azuread` (`~> 3.0`) and `time` (`~> 0.13`)
   providers are added; both are HashiCorp's.
2. **Everything is behind `muse_reader_enabled`, default `false`.** The owner
   sets it in the workspace after giving the run identity the Entra role
   **Application Developer** (`cf1c38e5-3621-4004-a7cb-879624dced7c`), which
   lets it create app registrations and service principals and change only
   the ones it owns
   ([role reference](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference#application-developer)).
   That is narrower than Application Administrator or Cloud Application
   Administrator, which reach every app in the tenant. Setting the switch
   back to `false` destroys all of it: the revoke.
3. **Each secret works for 210 days**, and is replaced only when the owner
   raises `muse_reader_secret_generation` (a `time_static` start date keyed
   on it), so no unrelated apply can replace it and cut Muse off. The
   reminder is due at day 180, leaving 30 days' slack. 180 is the
   estate's hand-rotation rule (`HAND_ROTATION_DAYS`) and within Microsoft's
   "less than 12 months". The credential register carries it
   (`tfc-azure-muse-reader-secret`), so it is on Admin → Integrations →
   Credentials and the reminders sheet.
4. **The secret leaves state once, by the owner**: the sensitive output
   `muse_reader_client_secret`, read with `terraform output -raw` straight
   into the clipboard and pasted into Muse's vault
   ([runbook](../runbooks/muse-azure-reader.md)). The client id and tenant id
   are plain outputs.
5. **The test keeps the exception exact.**
   `scripts/terraform-identity-grants.test.mjs` allows whole-subscription
   scope for these three labels only, and only as built-in Reader on their
   own subscription through their own provider, granted to this service
   principal. Every other block still goes through the scope checks.
   `infra/tests/guards.tftest.hcl` checks that nothing is planned while the
   switch is off and that, on, the three grants are Reader on the three
   subscriptions.

## Consequences and accepted risks

- **Whoever can read the `hcw-azure` state can read the whole estate.** The
  secret is in state in plain text. That is the owner's choice in #1763 and
  the main accepted risk. It is bounded by what Reader can do: no write, no
  Key Vault secret value, no blob, no Cosmos document, no storage key, no
  Function App setting value. It is not bounded on logs: every log the
  estate keeps, including visitor IP addresses in request logs, is readable.
  It also reads ordinary resource properties, which include Application
  Insights connection strings (enough to send made-up telemetry) and the
  inputs of past ARM deployments.
- **The run identity gains a lasting Entra role.** Application Developer is
  the smallest built-in role that creates app registrations; it includes
  `oAuth2PermissionGrants/createAsOwner`, which Microsoft marks privileged.
  A compromised run could create new app registrations it owns. It cannot
  change apps it does not own or assign Entra roles. Revisit if a custom
  Entra role with only `applications/createAsOwner` and
  `servicePrincipals/createAsOwner` is worth setting up (not checked: what
  a custom Entra role needs in this tenant's licence).
- **`infra/` now assigns roles at subscription scope.** The RBAC
  Administrator condition (`scripts/Set-TerraformRbacCondition.ps1`) already
  allowed it; the repository's own rule did not. The exception is three
  named Reader grants, held by a test. The Cost page's Cost Management Reader
  grant stays owner-made: this decision does not move it.
- **A client secret, against Microsoft's preference.** Muse runs outside
  Azure and outside GitHub Actions and presents no token Entra can trust, so
  a federated credential is not available today; a certificate would need
  Muse to hold and present a private key, which it was not asked to do.
- **Rotation needs a hand.** Terraform makes the new secret; only the owner
  can carry it to Muse. Until then Muse fails to sign in, and the old secret
  is gone from the apply that replaced it.

## Alternatives considered

- **Terraform makes the app and the grants; the owner mints the secret with
  `az ad app credential reset`.** Keeps the secret out of state entirely,
  which the standard prefers. Not chosen because the owner asked for the
  secret in Terraform, with state as its only store. A small change (drop
  the password resource and its output) if the owner changes their mind.
- **Owner-made app registration by script, as for the lab agent.** Keeps the
  run identity free of any Entra role. Not chosen because the owner asked for
  Terraform.
- **Narrower roles** (Monitoring Reader, Log Analytics Reader, Cost
  Management Reader) or **resource-group scope**. Not chosen: the owner asked
  for full read everywhere, and the `github_reader` gap is what a narrower
  scope produced before.
- **Federated credential or certificate.** Preferred by Microsoft; not
  possible without a change on Muse's side. Revisit when Muse can present an
  OIDC token or hold a certificate.

## Validation and revisit triggers

- Validated when, after the owner's apply, the three `Reader` rows show in the
  runbook's check (step 7), and Koda answers an alert with a log query.
- Revisit if Muse gains an OIDC issuer or certificate support (move off the
  secret), if a protected Log Analytics table is introduced (Reader will not
  read it), if a fourth subscription joins the estate (add its grant and
  extend the test), or if the state's readership widens.

## Related decisions and references

- [ADR 0037](0037-agent-content-api.md) and [ADR 0038](0038-koda-admin-access.md):
  Koda's access to the site.
- [ADR 0039](0039-cost-page.md): the owner-made subscription grant this
  decision does not change.
- [Muse Azure reader runbook](../runbooks/muse-azure-reader.md).
- [Required inputs §4.1, §4.10](../standards/required-inputs.md),
  [Variables and secrets](../standards/variables-and-secrets.md).
- [Manage access to Log Analytics workspaces](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/manage-access),
  [Cost Management scopes](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-work-scopes),
  [HCP Terraform Azure dynamic credentials](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/dynamic-provider-credentials/azure-configuration).

# ADR 0043: Muse reads the whole Azure estate through a Terraform-made app registration with a client secret

**Status:** Proposed (owner request of 2026-11-22; accepted when the owner merges
[#1763](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1763)'s pull request)
**Decision date:** 2026-11-22
**Corrected:** 2026-11-23. Decision 2 and the second accepted risk named the
Entra role Application Developer as what the run identity needs. The first
apply showed that was wrong, and both now name the Microsoft Graph permission
`Application.ReadWrite.OwnedBy`. "Correction of 2026-11-23" below has the
evidence.
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
   sets it in the workspace after giving the run identity the Microsoft
   Graph application permission **`Application.ReadWrite.OwnedBy`** (a
   permission a program holds in its own right, given by an administrator),
   which lets it create app registrations and service principals and change
   or delete only the ones it owns
   ([Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference#applicationreadwriteownedby)).
   That is narrower than `Application.ReadWrite.All`, or the Entra roles
   Application Administrator and Cloud Application Administrator, which
   reach every app in the tenant. It holds no Entra role. Setting the switch
   back to `false` destroys all of it: the revoke. *(Corrected 2026-11-23:
   this said the Entra role Application Developer.)*
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
- **The run identity gains a lasting Microsoft Graph permission.**
  `Application.ReadWrite.OwnedBy` is the smallest permission Microsoft
  documents for a program that creates a service principal and then changes
  it. A compromised run could create new app registrations it owns, give
  them secrets, and list (not change) every app in the tenant. It cannot
  change an app it does not own, give any app a Graph permission, or assign
  Entra roles. One thing to keep true: nobody should add the run identity as
  an owner of another app, because it could then change that app too.
  *(Corrected 2026-11-23: this said the run identity gains the Entra role
  Application Developer.)*
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
  run identity free of any Entra role or Graph permission. Not chosen because
  the owner asked for Terraform. It stays the fallback if the Graph
  permission ever proves not to be enough.
- **The Entra role Application Developer for the run identity.** This was
  the first decision, and it failed on the first apply; see the correction
  below.
- **A change in `infra/muse-reader.tf` that avoids the refused call.** Not
  possible: the provider sends it after every service principal create,
  whatever the configuration says.
- **Narrower roles** (Monitoring Reader, Log Analytics Reader, Cost
  Management Reader) or **resource-group scope**. Not chosen: the owner asked
  for full read everywhere, and the `github_reader` gap is what a narrower
  scope produced before.
- **Federated credential or certificate.** Preferred by Microsoft; not
  possible without a change on Muse's side. Revisit when Muse can present an
  OIDC token or hold a certificate.

## Correction of 2026-11-23

This record first said the run identity needs the Entra role Application
Developer. The owner gave it that role, turned the switch on, and the first
apply failed:

```text
Error: Failed to patch service principal after creating
  with azuread_service_principal.muse_reader[0]
unexpected status 403 (403 Forbidden) with error: Authorization_RequestDenied: Insufficient privileges to complete the operation.
```

The app registration and the service principal had both been created; only
the next call was refused. What was read afterwards, on 2026-11-23:

- **The provider (`hashicorp/azuread` 3.10.0) always changes a service
  principal straight after creating it.** It creates it with a temporary
  description, then sends an update that sets the real one, and returns this
  exact error if that update fails for any reason other than "not found"
  ([source](https://github.com/hashicorp/terraform-provider-azuread/blob/v3.10.0/internal/services/serviceprincipals/service_principal_resource.go#L500-L510)).
  No argument turns it off. The same code puts the caller on the owner list
  in the create call itself, so the update did run as an owner.
- **Application Developer does not cover that update.** Its permission list
  is three create rights (`applications/createAsOwner`,
  `servicePrincipals/createAsOwner`, `oAuth2PermissionGrants/createAsOwner`)
  and a section headed "Owned application registrations", which lists
  `microsoft.directory/applications/...` actions only
  ([role reference](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference#application-developer)).
  The actions that change an owned service principal
  (`microsoft.directory/servicePrincipals/basic/update` and others) are
  listed as what a member **user** may do to objects they own
  ([default user permissions](https://learn.microsoft.com/en-us/entra/fundamentals/users-default-permissions#object-ownership)),
  and the run identity is a managed identity, not a user.
- **Microsoft names the permission for a program.** "Update
  servicePrincipal" lists `Application.ReadWrite.OwnedBy` as the least
  privileged application permission, and mentions Application Developer only
  for a signed-in user
  ([Update servicePrincipal](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-update?view=graph-rest-1.0#permissions)).
  The provider's pages for `azuread_application`,
  `azuread_service_principal` and `azuread_application_password` each say
  the same for a caller that is a service principal: `Application.ReadWrite.OwnedBy`
  or `Application.ReadWrite.All`, with the caller in `owners`
  ([service principal page](https://github.com/hashicorp/terraform-provider-azuread/blob/v3.10.0/docs/resources/service_principal.md#api-permissions)).
  The first version of this record read the role's description and did not
  open those pages.

**How sure this is.** The documents fit the failure call for call (app
create allowed, app update allowed, service principal create allowed,
service principal update refused), but the fix was not tried in a test
directory before this correction was written. The one other cause not ruled
out is timing: the update reaching a Microsoft server that did not yet know
the new object's owner. The provider retries that update only on "not
found", not on "forbidden". If the same error returns with the Graph
permission in place, timing or something else is the cause and this section
is corrected again.

**What changes.** The run identity is given `Application.ReadWrite.OwnedBy`
on Microsoft Graph, and the Application Developer role is removed once the
apply has succeeded: the Graph permission covers creating as well
([Create application](https://learn.microsoft.com/en-us/graph/api/application-post-applications?view=graph-rest-1.0#permissions)),
and the role carries `oAuth2PermissionGrants/createAsOwner`, which
Microsoft marks privileged and nothing here needs. No Terraform resource
changes. The [runbook](../runbooks/muse-azure-reader.md) has the owner's
steps, including the recovery from the half-made service principal.

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
  [Grant or revoke API permissions programmatically](https://learn.microsoft.com/en-us/graph/permissions-grant-via-msgraph),
  [HCP Terraform Azure dynamic credentials](https://developer.hashicorp.com/terraform/cloud-docs/workspaces/dynamic-provider-credentials/azure-configuration).

# ADR 0005: Use AVM-based Terraform and GitHub OIDC delivery

**Status:** Accepted
**Decision date:** 2026-07-22
**Owners:** Workload owner and architecture owner

## Context

The platform must be deployed as code and use GitHub as the change-control surface. The prototype uses
direct resources and workflow patterns that require stronger identity and approval boundaries.

## Purpose and decision drivers

Make infrastructure changes consistent, reviewable, credentialless, reproducible, and reversible.

## Decision

Compose pinned Azure Verified Modules from a thin Terraform production root. Use separate GitHub OIDC
identities for read-only plan and protected apply. Apply only the reviewed artifact with serialized
production concurrency.

## Consequences and accepted risks

- Bootstrap OIDC trust, state, and RBAC are separately governed.
- Direct `azurerm` resources require a documented AVM gap.
- Actions and modules are pinned to immutable versions.
- The apply identity cannot change its own trust or grant itself RBAC.

## Alternatives considered

- Static service-principal secrets: rejected due to credential rotation and exposure risk.
- Portal deployment: rejected because it removes reviewable desired state.
- HCP Terraform as the primary change surface: not selected because GitHub is the requested control
  plane; remote state mechanics remain an implementation detail.

## Validation and revisit triggers

Validate reviewed-plan hash, protected approval, lock behavior, rollback, and absence of static Azure
credentials. Revisit if organization-level delivery tooling becomes mandatory.

## Amendment 2026-10-07 — the Terraform run identity's grants (estate review SEC-1)

The consequence above, "the apply identity cannot change its own trust or
grant itself RBAC", was not true when the estate review of 2026-10-06 read
it. HCP Terraform runs as `id-plat-terraform-prod-cus-01`, created and
granted by `scripts/bootstrap-terraform-oidc.ps1` outside Terraform state,
and it held Contributor and an unconditioned Role Based Access Control
Administrator on every target subscription. Unconditioned, that role writes
any role assignment, Owner included. This amendment records what now makes
the sentence true, and what still does not.

- **The condition, applied 2026-10-06.** `scripts/Set-TerraformRbacCondition.ps1`
  (#893, #906, #907) put an ABAC condition on each RBAC Administrator
  assignment: it refuses writes of Owner, User Access Administrator, RBAC
  Administrator and every Key Vault administrator and officer role, except
  Key Vault Secrets Officer to a user (the `admin_object_ids` seeding
  window), and refuses deletes of Owner, User Access Administrator and RBAC
  Administrator. From 2026-10-07 it also refuses **Contributor**, so the
  scoping below cannot be undone by one role assignment;
  `scripts/terraform-identity-grants.test.mjs` fails the build if `infra/`
  ever assigns a refused role.
- **The condition stays in the operator script, not in Terraform.** Decided
  2026-10-07. The identity's grants are not in Terraform state by design
  (section 0 of the deployment runbook: Terraform must not manage the
  credential it authenticates with), and a condition held in `infra/` would
  be maintained by the very identity it constrains: a run could rewrite or
  drop its own condition, which is the escalation the condition exists to
  stop. Revisit if a separate, more privileged bootstrap workspace ever
  holds the run identity's grants; that workspace could hold the condition.
- **Contributor scoped to the resource groups `infra/` declares.** From
  2026-10-07 the bootstrap grants Contributor on each of the nine groups
  `infra/` creates (seven in the application subscription,
  `rg-mgmt-plat-prod-cus` in Management, `rg-conn-hub-prod-cus` in
  Connectivity; listed in `scripts/terraform-identity-grants.json`, which
  the test above keeps equal to the HCL), plus a custom role,
  `HCW Terraform Subscription Scope`, for the only things `infra/` does at
  subscription scope: create and update those groups, keep the two
  subscription budgets, and register `var.azure_resource_providers`. The
  custom role has no `resourceGroups/delete`, because at subscription scope
  that verb deletes any group and everything in it; removing a group from
  `infra/` is an owner step. Terraform creates its groups, so
  Contributor on a group alone could not create one; the custom role is
  what closes that.
- **Two steps.** The subscription-wide Contributor stays until a later,
  separate change removes it, after a plan and an apply have run on the
  narrow grants. Doing both at once would make the first run to find a
  missing action the run that had already lost the wide grant. Once it is
  gone, a new resource group needs one extra pass (deployment runbook,
  section 0).
- **Still open.** RBAC Administrator is still granted per subscription, so
  the identity can still assign narrower built-in roles at subscription
  scope to principals it controls; scoping it to the same groups is the
  next narrowing. The acceptance evidence, a test apply that tries to
  assign Key Vault Secrets Officer to a service principal and is refused,
  has not been recorded.
- **Team tokens: an owner decision, not implemented.** The review also asked
  for a read-scoped team token for the workspace-busy check and a separate
  token for the plan check. Team API tokens need HCP Terraform's Teams
  feature, and the `hcw` organisation does not have that entitlement; the
  owner decides whether to buy it, and until then both checks use the
  existing token. Separate Azure credentials per run phase are a different
  mechanism that does not need Teams: HashiCorp documents
  `TFC_AZURE_PLAN_CLIENT_ID` and `TFC_AZURE_APPLY_CLIENT_ID`, which fall
  back to `TFC_AZURE_RUN_CLIENT_ID`. A plan identity with read-only rights
  would still need the list actions a refresh calls (app settings, storage
  keys), so it is a designed custom role, not Reader; recorded here as the
  option, not built.

## Amendment 2026-10-07, step two — subscription Contributor removed (SEC-1)

Step one ran on 2026-10-07: the nine group Contributors, the custom role and
the conditioned RBAC Administrator were granted on all three subscriptions
beside subscription Contributor, and a plan and apply on `hcw-azure`
succeeded. That proved nothing broke, not that the narrow grants suffice.
Step two removes the wide grant.

- **What is removed.** The identity's Contributor assignment at each of the
  three target subscriptions (`sub-app-site-prod-cus`,
  `sub-plat-conn-prod-cus`, `sub-plat-mgmt-prod-cus`), by
  `scripts/bootstrap-terraform-oidc.ps1 -RemoveSubscriptionContributor`. The
  switch first reads every narrow grant back from Azure (each group's
  Contributor, the custom role's assignment and its definition, and an RBAC
  Administrator whose condition refuses Owner and Contributor) and removes
  nothing if one is missing. The owner runs it; the deployment runbook,
  section 0, "Step two", has the commands and what success looks like.
- **What `infra/` does outside the nine groups, and what covers it after.**
  Audited from every `azurerm_*` and `azapi_*` resource and data source:

  | What | Where it acts | Covered by, once subscription Contributor is gone |
  | --- | --- | --- |
  | Create and update the nine resource groups | subscription | custom role (`resourceGroups/read`, `/write`) |
  | The two subscription budgets | subscription | custom role (`Microsoft.Consumption/budgets/read`, `/write`, `/delete`) |
  | Provider registration (azurerm's `resource_providers_to_register`; azapi touches only namespaces in the same list) | subscription | custom role (`providers/read`, one `register/action` per namespace) |
  | Control-plane reads above a group: the provider list, any name-availability check, the soft-deleted Key Vault lookup on create, role definitions by name | subscription | RBAC Administrator: its built-in definition carries `*/read`, and the condition restricts only role-assignment writes and deletes |
  | Role assignments (`azurerm_role_assignment`, all scoped inside the groups) | groups and resources | RBAC Administrator, under its condition |
  | `data.azurerm_client_config` | none | read from the token, no Azure call |
  | Cross-group and cross-subscription references: the hub and spoke peerings, diagnostic settings, the data collection rule and Application Insights writing to the Management workspace, the budgets' action group | both ends in declared groups | Contributor on each group |
  | Activity Log alerts that watch a whole subscription (`alert-rbac-assignment-app`, `alert-rbac-definition-app`, `alert-rbac-assignment-mgmt`, `alert-rbac-definition-mgmt`, added by PLAT-4, #964) | written in `rg-web-site-prod-cus` and `rg-mgmt-plat-prod-cus`; the subscription is only read | Contributor on each group writes the rule; the subscription in its `scopes` is the event prefix it evaluates, which needs read alone, and that is RBAC Administrator's `*/read`. `WATCH_SCOPES` in `scripts/terraform-identity-grants.test.mjs` admits exactly this, and only for the two subscriptions `infra/` already targets |
  | The lab policy assignment (`lab_hybrid_policy_enabled`) | `rg-lab-hybrid-prod-cus` | nothing the identity holds, before or after: Contributor excludes `Microsoft.Authorization/*/Write`; the owner grants Resource Policy Contributor on the group first (labs-host runbook) |
  | Data-plane operations | resources | unchanged: Contributor carries no data actions at any scope |
  | Management groups, tenant, Entra | none | `infra/` declares nothing there; no `azuread` provider |

- **What the custom role gained: nothing, and why.** Every write `infra/`
  makes above a group was already in it; every read above a group is
  RBAC Administrator's. Adding reads to the custom role would duplicate
  that without narrowing anything. `scripts/terraform-identity-grants.test.mjs`
  now classifies every Azure type `infra/` uses by the grant that covers it
  and fails on an unclassified one, fails if a block names a resource group
  other than a declared `azurerm_resource_group` or builds a literal Azure id
  above a declared group (the subscription budgets excepted), and holds the
  role's only delete to the budgets'.
- **The known gap, destroy-time only.** azurerm purges a deleted Cognitive
  Services account by default, and the purge
  (`Microsoft.CognitiveServices/locations/resourceGroups/deletedAccounts/delete`)
  is a subscription-scope action. It is deliberately not granted: the role
  carries no delete above a group but the budgets'. Destroying or replacing
  the Foundry account is therefore an owner step, like removing a group, or
  a later change sets `purge_soft_delete_on_destroy = false` for
  `cognitive_account` in the provider features.
- **Rollback.** Run the bootstrap without the switch. Its default list of
  subscription roles still includes Contributor, so a plain run grants it
  wherever it is missing (as the owner, whose Owner right is not subject to
  the identity's condition). The same fact means every re-run after step two
  carries the switch, or it restores the wide grant.
- **What the proof covers.** A plan exercises reads; only an apply exercises
  writes. Today's permanent diff (`3 to add, 1 to change, 3 to destroy`)
  writes the azapi app-settings pair and the Function App only, so a clean
  apply proves those paths. The first apply that creates or changes anything
  else is the real test of the rest, and the runbook says how to read an
  `AuthorizationFailed` from it.

## Related decisions and references

- [ADR 0009](../decisions/0009-production-state.md)
- [Azure Verified Modules](https://azure.github.io/Azure-Verified-Modules/)
- [Azure infrastructure delivery with GitHub Actions](https://learn.microsoft.com/devops/deliver/iac-github-actions)

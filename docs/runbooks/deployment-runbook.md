# Deployment Runbook — Azure platform (infra/)

**Scope:** provisioning and operating the Azure platform from `infra/` in the
main repository. Migration and DNS cutover are covered by the
[Migration Runbook](../history/migration-runbook.md); this page owns the Terraform
lifecycle: validate → plan → apply → verify → operate → (eventually) ALZ
absorption.

**Authority:** this runbook does not authorize anything. Production applies,
destructive changes, DNS cutover, and decommissioning each require the
explicit approvals listed in the root README and [Migration Runbook](../history/migration-runbook.md)
roles table.

## System of record

| Concern | Where |
| --- | --- |
| Terraform source | `infra/` on `main` in HCW-HybridCloudWorks |
| State and variables | HCP Terraform Cloud — org `hcw`, project `Site`, workspace `hcw-azure` |
| Required inputs (names, formats, consumers — never values) | [Required inputs](../standards/required-inputs.md) on this site (it was `REVIEW.md` Part 4 at the repository root until 2026-08-29, and that file no longer exists) |
| Terraform's own identity | `id-plat-terraform-prod-cus-01`, federated to `app.terraform.io` — created once by `scripts/bootstrap-terraform-oidc.ps1`, outside Terraform state (section 0) |
| Deployment identity | User-assigned managed identity + GitHub OIDC federated credentials (`infra/oidc.tf`) — no static credentials exist |
| Working rules for the directory | `infra/README.md` |

## Which directory holds the estate

The four subscriptions — `sub-app-site-prod-cus`, `sub-plat-mgmt-prod-cus`,
`sub-plat-conn-prod-cus`, `sub-plat-ident-prod-cus` — live in the Entra tenant
named **Default Directory**, primary domain
`saulpatinojrhotmail.onmicrosoft.com`. That is the tenant Azure created
alongside the first subscription. It is **not** the `hybridcloudworks.com`
tenant that the owner's work account calls home: that account is a guest in
Default Directory, and Default Directory requires multi-factor authentication.

So a plain `az login` from a fresh machine lands in `hybridcloudworks.com`,
which holds no subscriptions, and ends with `No subscriptions found` followed by
`The subscription of 'b9e02281…' doesn't exist in cloud 'AzureCloud'`. The
second line reads as a missing subscription. It is a wrong-directory sign-in,
and the `AADSTS50076` lines above it, one per other tenant, are the CLI failing
to refresh silently into a tenant that wants MFA. Cost one round trip on
2026-09-18.

Name the tenant on every manual sign-in. This line is the same in PowerShell,
Git Bash and macOS zsh, and it opens the browser to complete MFA:

```powershell
az login --tenant saulpatinojrhotmail.onmicrosoft.com
```

Success is a table listing all four `sub-*-prod-cus` subscriptions. Then
select the one the command you are about to run targets, by name:

```powershell
az account set --subscription sub-app-site-prod-cus
```

The tenant is named here by its domain rather than its GUID because the docs
redaction gate (`scripts/docs/check_redaction.py`) keeps real GUIDs out of
published pages, per [Variables and secrets](../standards/variables-and-secrets.md).
When a GUID is needed — `ARM_TENANT_ID` below, or a GitHub variable — read it
back from the signed-in session rather than from a screenshot:

```powershell
az account show --query tenantId -o tsv
```

The bootstrap and variable-seeding scripts in section 0 do not need this: they
run `az login --tenant` themselves after matching the tenant from
`sub-plat-mgmt-*`. This section is for a hand-run `az` command, which is where
the wrong directory bites.

## 0. Bootstrap — once per subscription, before anything else

Everything below this section assumes HCP Terraform can already authenticate
to Azure. On a subscription that has never been applied to, it cannot, and no
amount of Terraform fixes that: **Terraform cannot create the credential
Terraform authenticates with.** This section breaks that chicken-and-egg. It
runs exactly once in the life of a subscription.

### The two handshakes

Confusing these is the most common way to get stuck, because both are called
"the OIDC setup" and only one of them is in the repository.

| | HCP Terraform → Azure | GitHub Actions → Azure |
| --- | --- | --- |
| Who authenticates | Terraform runs in HashiCorp's cloud | The deploy workflows |
| Created by | `scripts/bootstrap-terraform-oidc.ps1` (manual, once) | `infra/oidc.tf` (Terraform) |
| Identity | `id-plat-terraform-prod-cus-01` in `rg-mgmt-boot-prod-cus` | `id-site-github-deploy-prod-cus-01` in `rg-web-site-prod-cus` |
| Issuer | `https://app.terraform.io` | `https://token.actions.githubusercontent.com` |
| Exists when | After you run the script | After the first successful apply |
| Consumed as | `TFC_AZURE_RUN_CLIENT_ID` in the workspace | `CLIENT_ID` repository variable |

If you are hunting for `CLIENT_ID` to give `azure/login`, it comes from the
Terraform outputs **after** the left-hand column works. It does not exist
before the first apply.

### Why a managed identity, not an app registration

Same reason as `infra/oidc.tf`, which documents it at length: app registrations
need Application Administrator in Entra, and Azure **Owner does not grant
that** — Entra and Azure RBAC are separate permission planes. A user-assigned
managed identity is an ordinary Azure resource, and Entra supports federating
one to an arbitrary external issuer, so an Azure Owner can create the whole
chain with no directory role at all.

### Why it is not in Terraform state

The bootstrap identity is deliberately excluded from `infra/`. If Terraform
managed the identity it authenticates with, a destroy, a taint, or a bad plan
would lock the workspace out of the subscription with no path back in except
re-running this script. It lives in its own resource group for the same
reason: nothing in `infra/` can reach it.

### Run it

```powershell
# Dry run first — prints every change without making one.
./scripts/bootstrap-terraform-oidc.ps1 -WhatIf
```

**No arguments, by design.** Every value the three deployment scripts need is
a GUID, and GUIDs passed as flags go wrong in ways that surface later as
something else: they land in shell history, one transposed character reads as
a permissions problem, and the operator has to know which of four similar
subscription IDs belongs in which slot from a terminal that cannot show them
the list. So the scripts *discover* what Azure already knows, offer a numbered
list where there is a real choice — with the subscription matching the naming
convention preselected — and prompt only for what cannot be found. Everything
resolved is printed for one confirmation before anything is written.

Here that means the tenant comes from your `az` sign-in, the identity's home
is matched from `sub-plat-mgmt-*`, and the deployment targets default to the
three subscriptions the configuration actually targets (app, mgmt, conn —
Identity is deliberately excluded, since that landing zone holds nothing).

Parameters still exist for every value, so CI can supply them; they are simply
never required. `-DeviceCode` remains for a session with no browser.

The script is idempotent, so re-running it is how you repair a broken
handshake, not just how you create one. It preflights before it proposes
anything: CLI present, signed in, correct tenant, subscription visible,
role-assignment rights held, `Microsoft.ManagedIdentity` registered.

**Sign-in is handled for you.** If you are not signed in, or your session is
in a different directory — the normal state for anyone who works across
tenants — the script runs `az login --tenant` itself and re-reads the account
afterwards, because switching directories also changes which subscriptions are
visible. Signing in happens even under `-WhatIf`: it reads your directory
rather than changing it, and nothing can be inspected without a session.

Add `-DeviceCode` when this session has no browser of its own (SSH, a
container, Cloud Shell, a locked-down VM), or when the browser that opens
keeps silently reusing the wrong account. You get a short code and a URL to
complete in any browser, on any machine. The script also falls back to it
automatically if the interactive sign-in fails, since that failure is usually
environmental — no display, no loopback — rather than a credential problem.

**If the preflight says you hold no roles on the subscription:** that is
expected on a tenant you created yourself. Global Administrator is an Entra
role and carries zero Azure RBAC. Re-run with `-ElevateAccess`, which takes
the documented one-time root-scope elevation, grants you Owner on the target
subscription, and removes the root-scope grant again.

It creates: `rg-mgmt-boot-prod-cus`, the `id-plat-terraform-prod-cus-01` managed identity, two
federated credentials, and the identity's role assignments, each as narrow as
what `infra/` does with it (estate review 2026-10-06, SEC-1; ADR 0005,
amendment of 2026-10-07):

| Grant | Scope | Why |
| --- | --- | --- |
| Role Based Access Control Administrator, with the ABAC condition below | each target subscription | `infra/` creates role assignments and Contributor cannot. The condition is what stops it granting Owner, Contributor or a Key Vault officer role |
| `HCW Terraform Subscription Scope` (custom, `scripts/terraform-identity-grants.json`) | each target subscription | The only things `infra/` does above a resource group: create and update its groups, keep the two subscription budgets, register its resource providers. No resource-group delete |
| Contributor | each resource group `infra/` declares, listed in the same JSON | Everything inside a group |
| Contributor | each target subscription | **Step one only.** A run with `-RemoveSubscriptionContributor` (step two) removes it; a plain run grants it back, which is the rollback. See below |

The subscription-wide Contributor goes in a second, separate step, after a
plan and an apply have run on the narrow grants above. The two steps are
apart on purpose: while both exist a run proves nothing broke but cannot
prove the narrow grants are enough, and removing the wide one in the same
change would make the first run to find a missing action the run that has
already lost it. None of it can lock a run out mid-apply, because these
assignments are not in Terraform state; only the script changes them.

#### Step two: remove subscription Contributor

What `infra/` does outside its nine groups, and which grant covers it once
the wide one is gone, is audited in ADR 0005 (amendment "2026-10-07, step
two"); `terraform-identity-grants.test.mjs` fails when `infra/` gains an
Azure type nobody has classified that way. The custom role needed nothing
new. The switch reads every narrow grant back before it deletes anything,
and stops with nothing removed if one is missing.

These read `scripts/bootstrap-terraform-oidc.ps1` and
`scripts/terraform-identity-grants.json` from the working tree, so run them
on an up-to-date `main`. The second line prints `True` when the switch is
there:

```powershell
git switch main; git pull --ff-only
```

```powershell
Select-String -Path scripts/bootstrap-terraform-oidc.ps1 -Pattern 'RemoveSubscriptionContributor' -Quiet
```

Preview. Success is a `=== SEC-1 step two` section of `[ok]` lines (the
custom role's definition; per subscription the custom role and a
conditioned RBAC Administrator; Contributor on each of the nine groups)
followed by exactly three `[write]  Would remove Contributor at subscription
scope on ...` lines, one per subscription. A `[stop]` listing missing grants
means nothing would be removed; it names what to fix.

```powershell
./scripts/bootstrap-terraform-oidc.ps1 -RemoveSubscriptionContributor -WhatIf
```

Then for real, answering `Y` at each confirmation. Success is three
`[write]  ... — Contributor at subscription scope removed` lines, each
followed by an `[ok]  ... — no Contributor at subscription scope (read
back)`.

```powershell
./scripts/bootstrap-terraform-oidc.ps1 -RemoveSubscriptionContributor
```

Then start a **Plan and apply** run at
<https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs> ("New run").
Today's permanent diff is `Plan: 3 to add, 1 to change, 3 to destroy` (the
azapi app-settings pair and the Function App); confirm it and watch the apply
finish.

The read-back, any time: success is two rows per subscription, `Role Based
Access Control Administrator` and `HCW Terraform Subscription Scope`, and
no `Contributor` row.

```powershell
$p = az identity show -n id-plat-terraform-prod-cus-01 -g rg-mgmt-boot-prod-cus --subscription sub-plat-mgmt-prod-cus --query principalId -o tsv; foreach ($s in 'sub-app-site-prod-cus', 'sub-plat-conn-prod-cus', 'sub-plat-mgmt-prod-cus') { az role assignment list --assignee $p --all --subscription $s -o json | ConvertFrom-Json | Where-Object { $_.scope -match '^/subscriptions/[^/]+$' } | Select-Object @{ n = 'subscription'; e = { $s } }, roleDefinitionName }
```

**Rollback** is a plain run, which grants subscription Contributor wherever
it is missing (the owner's Owner right makes the grant, so the identity's
condition, which refuses Contributor, is not in the way). Success is three
`[write]  ... — Contributor assigned` lines.

```powershell
./scripts/bootstrap-terraform-oidc.ps1
```

Roll back when a plan or apply fails with `AuthorizationFailed`. The message
names the action and the scope, and the scope says which grant is short: a
bare `/subscriptions/<id>` is the custom role (add the action to
`scripts/terraform-identity-grants.json` with a test, re-run with the
switch), a scope inside one of the nine groups is that group's Contributor,
and `Microsoft.Authorization/roleAssignments/write` is RBAC Administrator or
its condition.

**What the proof covers.** A plan exercises the reads; only an apply
exercises writes, and today's permanent diff writes the azapi app-settings
pair and the Function App only. A clean apply proves those paths. The first
apply that creates or changes anything else (a new alert, a budget change,
a new group) is the real test of the rest; read its output before confirming
the next.

**After step two every re-run carries the switch.** A plain run is the
rollback, so re-applying the condition or adding a group's grant without
`-RemoveSubscriptionContributor` puts the wide grant back.

Once step two is done, a **new resource group** in `infra/` takes one
extra pass: the apply that creates it cannot create anything inside it.
Add the group to `scripts/terraform-identity-grants.json` in the same pull
request (`terraform-identity-grants.test.mjs` fails until you do), apply,
re-run this script with `-RemoveSubscriptionContributor`, and apply again;
or land the empty group first.
**Removing** a group is an owner step for the same reason the custom role
has no delete: the apply destroys its contents and stops at the group,
which the owner deletes by hand before the next plan.

**Two federated credentials, not one.** HCP Terraform stamps the run phase
into the token subject, and Entra matches subjects as exact case-sensitive
strings with no wildcards, so `run_phase:plan` and `run_phase:apply` are two
different subjects. With only the plan credential every run plans cleanly and
every apply fails at authentication — which reads like a permissions problem
and is not one.

### Then set the workspace variables

In HCP Terraform → `hcw-azure` → **Variables**, as *environment*
variables (the script prints these with the values filled in):

| Name | Value |
| --- | --- |
| `TFC_AZURE_PROVIDER_AUTH` | `true` |
| `TFC_AZURE_RUN_CLIENT_ID` | client ID of `id-plat-terraform-prod-cus-01` |
| `ARM_TENANT_ID` | tenant GUID |
| `ARM_SUBSCRIPTION_ID` | subscription GUID |

These four names come from HashiCorp and Microsoft and are exempt from the
[2-word variable rule](../standards/iac-repository-standard.md#variable-naming) as contractual
names. Terraform *variables* for the same workspace are listed in
Required-Inputs §4.1.

Both seeding halves are scripted — prefer the scripts over the UI forms, and
both take no arguments for the reasons given in section 0:

- `scripts/set-tfc-variables.ps1` writes all twelve HCP Terraform workspace
  values (the four environment variables above plus the eight Terraform
  variables) in one idempotent run, and reads back the workspace's real
  project name — the value the federated-credential subject must contain.
  It finds the Terraform identity's client id by reading the identity the
  bootstrap created, so that value is never copied by hand out of a
  scrolled-away console; the subscriptions come from `az`; the Cloudflare zone
  is chosen from the zones the token can actually see, after prompting for the
  token itself. Only the app-registration audience and the Cloudflare token
  are typed, and only when they cannot be discovered.
- `scripts/set-github-variables.ps1` seeds the GitHub repository variables
  and secrets. Run it once **before** the first apply — that seeds only
  `TENANT_ID` and `SUBSCRIPTION_ID`, the two values that are inputs *to*
  Terraform rather than products of it — and once **after**, when it reads
  `CLIENT_ID`, `APP_HOSTNAME`, `FUNCTIONS_URL`, `RESOURCE_GROUP`,
  `FUNCTIONS_STORAGE_ACCOUNT` and the `COSMOS_ENDPOINT` secret straight from
  the workspace's state outputs over the HCP Terraform API. Outputs rather
  than hardcoded copies on purpose: a copy drifts silently when the code
  changes, an applied output cannot. The corollary is directional — **re-run
  the script after any apply that changes an output** (a renamed group, a
  new hostname), or the GitHub-side copies go stale. The first post-apply
  run is also what arms the self-skipping workflows that sign in with
  `CLIENT_ID`, `READER_CLIENT_ID`, `ALERT_READER_CLIENT_ID` and
  `MANIFEST_WINDOW_CLIENT_ID`.

### Verify

```bash
cd infra && terraform login && terraform plan
```

A plan that authenticates and shows resources to create is success — you are
not applying yet. `AADSTS70021` ("No matching federated identity record
found") means the subject did not match: re-run the script passing
`-TfcProject` and `-TfcWorkspace` copied exactly off the workspace Settings
page, capitalisation and spaces included. A workspace created without choosing
a project is in `Default Project`, with the space.

Bootstrap is done when a plan authenticates. Continue from section 1.

### The condition on the identity's role-assignment right

Since 2026-10-06 (estate review, finding SEC-1) the identity's Role Based
Access Control Administrator assignments carry an ABAC condition: it can
assign the roles `infra/` needs and cannot assign Owner, User Access
Administrator, RBAC Administrator or a Key Vault officer role to anything
but a named human (the `admin_object_ids` seeding window), and cannot remove
an Owner or User Access Administrator assignment. Since 2026-10-07 it also
refuses Contributor, so the resource-group scoping above cannot be undone by
one role assignment. The bootstrap script applies it at the end of its role
step, and re-running the bootstrap is how an existing estate picks up both
the new grants and the changed condition (with `-RemoveSubscriptionContributor`
once step two is done, or the re-run grants subscription Contributor back).
The condition script alone, from a
desktop signed in as the owner:

```powershell
pwsh -NoProfile -File scripts/Set-TerraformRbacCondition.ps1 -WhatIf
```

```powershell
pwsh -NoProfile -File scripts/Set-TerraformRbacCondition.ps1
```

Success is one `conditioned` line per subscription and a final listing in
which every row reads `condition present`. The script resolves the role ids
by name, prints the condition it applies, and leaves an assignment that
already carries it alone.

## 1. Preflight (every change)

1. Branch from `main`; never push to `main` directly.
2. Local validation, no credentials needed:
   ```bash
   cd infra
   terraform fmt -recursive -check
   terraform init -backend=false -input=false
   terraform validate
   tflint --init && tflint
   ```
3. CI must be green: **IaC Validation** (fmt/validate/tflint/Trivy),
   Repository Policy, CI, CodeQL.
4. PR uses the infrastructure section of the template: plan linked, no
   unexpected destroy/create pairs, no address renames without `moved`
   blocks, tags on every new resource, Required-Inputs updated for any new
   required input.
5. If the change alters an accepted ADR, write the superseding ADR first
   ([register](../decisions/index.md)).
6. **A Terraform apply and a Functions deploy must never overlap.** Before
   dispatching `deploy-functions.yml`, confirm the `hcw-azure` workspace has
   no run in progress, and before confirming an apply, confirm no deploy is
   running.

### Why they cannot overlap

Both writers rewrite the Function App's **entire** app-settings map, because
ARM's `appsettings` PUT replaces rather than merges — the same property the
T-511 strip depends on. Two writers that read-modify-write that map within a
few minutes therefore discard each other's changes, and neither one errors.

It happened on 2026-09-09 (#454). The deploy read the map at 04:37:56,
Terraform wrote six new settings at 04:39:14, and the deploy's closing write
at 04:39:50 replayed the map it had read three minutes earlier:

| UTC | Writer | Effect |
| --- | --- | --- |
| 04:37:56 | deploy | reads and writes the map as it stands |
| 04:39:14 | Terraform | writes six new settings |
| 04:39:50 | deploy | writes the 04:37 map back — the six are gone |

The Cosmos and blob containers from that same apply survived, so the apply
itself was fine. Only the map lost, and the loss surfaced days later as
integrations that read nothing.

### What now prevents it

- `deploy-functions.yml` runs `scripts/tfc-workspace-busy.mjs` before it opens
  any firewall window and refuses to continue while `hcw-azure` has a run that
  is not finished. It fails closed (PLAT-3, #963): without `TFC_TOKEN` it
  reports that it cannot check and refuses the deploy, naming the secret to
  seed. `TFC_TOKEN` has been a repository secret since 2026-10-08, so its
  absence is a fault to fix, not a reason to deploy unguarded; the step's
  log says "armed" when the guard could read the workspace.
- After the deploy, `scripts/assert-live-app-settings.mjs` compares the live
  settings against every Key Vault reference Terraform declares and fails the
  job naming what is absent. This is the half that catches a run which
  *started* after the deploy read the map, which the pre-flight guard cannot.
  Plain settings such as `PUBLIC_API_ORIGIN` are not covered — `app_settings`
  is a `merge()` with computed maps, and a parse confident enough to gate a
  release on cannot be written against it.

**If the assertion fires, do not add the settings by hand.** Re-apply `infra/`
and then rerun the deploy. Adding them manually leaves the race in place, and
the next deploy loses them again.

## 2. Plan

Plans run in HCP Terraform Cloud, where the state and the workspace variables
live — not on laptops, not on GitHub-hosted runners holding tokens.

1. Open a run in the `hcw-azure` workspace (VCS-triggered or
   CLI-triggered from the merged commit).
2. The infrastructure operator reviews the plan **in TFC**, checking:
   - zero destroy/create pairs on stateful resources (Cosmos, storage
     accounts, Key Vault carry `prevent_destroy` — a plan that wants to
     replace them fails; treat any attempt as a defect, not an obstacle).
     They were lifted exactly once, for the centralus rebuild on 2026-08-19,
     and restored the same day. If a plan proposes replacing a stateful
     resource and no one has deliberately lifted a guard, stop;
   - every change traceable to the merged diff;
   - cost-relevant changes against the **USD 150/month ceiling**
     ([Cost analysis](../architecture/cost-analysis.md)).
3. Anything surprising: discard the run, fix in a new PR.

## 3. Apply

**A run that creates a budget needs nothing set by hand (#820).** Azure
rejects a monthly budget whose start date falls before the current month, and
checks it only on *create*. Since #820 a new budget takes the first of the
month the plan runs in (`local.budget_start_date`, `infra/budget.tf`), and
existing budgets ignore the attribute. The one way to reintroduce the old
failure is a `budget_start_date` value in the `hcw-azure` workspace, which
pins a month. Leave it unset unless a specific month is the point, and delete
it once that month has passed.

1. Apply is confirmed in HCP Terraform by a human who is **not** the change
   author where role separation permits.
2. There is no GitHub apply workflow. `deploy-infra.yml`, which this step
   used to say stayed hard-disabled, was deleted with the migration surface
   (`59e471b`). Applies happen only in HCP Terraform, confirmed in its UI.
   What GitHub adds is a verdict: `tfc-plan-check.yml` reads the run's plan
   and holds it to the permanent diff (`scripts/assert-expected-plan.mjs`),
   so whoever confirms has a machine answer to "is this only the known
   diff?" before they click.
3. Record in the run description: PR number, approver, and (for anything
   touching data-bearing resources) the rollback decision point.

## 4. Post-apply verification

Do these **in order**. Step 1 is first because it is the only one where a
problem means production is already degraded rather than merely unchanged.

1. **Assert the Function App is not degraded.** Any apply that writes to
   `azurerm_function_app_flex_consumption.hcw` — including one that only
   changes a site setting — has `azurerm` re-inject a keyless
   `AzureWebJobsStorage`, which the azapi pair strips two graph hops later.

   **What Terraform guarantees, and what it cannot** (PLAT-2, #962). A
   green, untargeted apply that wrote the Function App also ran the strip
   after that write. An error in
   any *other* resource cannot strand it: Terraform skips only what depends
   on a failed resource and keeps running everything else, and the strip
   depends on nothing but the Function App and the settings read. What can
   strand it is a failure *on that path*: the Function App's own update
   failing after `azurerm` has written the settings, the read or the strip
   failing, the run being cancelled between them, or a `-target` that names
   the Function App without the pair. No ordering prevents those, because
   Terraform runs nothing after a resource that failed; `infra/functionapp.tf`
   gives the reasoning beside the pair. So after **any apply that did not
   finish green**, and after any targeted apply, do this read before
   anything else.

   From PowerShell, with the application subscription as the `az` default
   (`ResourceGroupNotFound` means it is not; `az account show` names the one
   that is). Listing app settings is an action,
   `Microsoft.Web/sites/config/list/action`, so `Reader` alone answers
   `AuthorizationFailed`; the owner's own sign-in carries it. The first should
   print one row, `RUNTIME_CONFIG_WRITER` with the value `azapi-strip`:

   ```powershell
   az functionapp config appsettings list -n func-site-prod-cus-01 -g rg-web-site-prod-cus -o json | ConvertFrom-Json | Where-Object name -eq 'RUNTIME_CONFIG_WRITER' | Select-Object name, value
   ```

   The second should print `0`, meaning there is no `AzureWebJobsStorage`
   row. It counts the row rather than printing it, and the identity-based
   `AzureWebJobsStorage__accountName` is a different name and is not counted:

   ```powershell
   (az functionapp config appsettings list -n func-site-prod-cus-01 -g rg-web-site-prod-cus -o json | ConvertFrom-Json | Where-Object name -eq 'AzureWebJobsStorage' | Measure-Object).Count
   ```

   `azurerm` in the first, or `1` in the second, is the stranded state the
   three recorded incidents came from. **Re-apply to convergence; do not edit
   either setting by hand.** The next plan may not look like the permanent
   diff. A settings read or strip that was skipped is absent from state, and
   one whose own call failed may be tainted, so the plan creates or replaces
   it without the usual trio and `tfc-plan-check.yml` reports the difference.
   That plan is the repair. Both reads
   are also what `deploy-functions.yml` asserts before it syncs triggers, and
   what `monitor-functions-registered.yml` reports on its timer, so a
   stranded host that nobody reads is caught at the next deploy or monitor
   run ([Alerting and support](../runbooks/alerting-and-support.md)).
2. `terraform plan` again → **empty plan** (no immediate drift). Expect the
   permanent 3-add / 1-change / 3-destroy signature from the three azapi
   resources — the app-settings pair and the FTP policy — which
   `infra/functionapp.tf` documents beside them.
3. **Check the alert fabric, if the run created or changed an alert rule or the
   action group.** Delivery itself is proven: both receivers delivered a CLI
   test notification on 2026-08-30, and a rule in the application subscription
   reached the action group across the boundary on 2026-08-25
   ([Alerting and support](alerting-and-support.md#delivery-is-proven-on-both-channels)).
   What an apply can still break is a rule's own state, so:
   - Run [Verify Alert Rule State](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/verify-alert-state.yml)
     and expect every declared rule `OK`, or `GATED OFF` where its gate is
     off. It derives the rule list from `infra/`, so a rule the run added is
     in it.
   - If the run changed the action group itself, re-send the CLI test
     notifications on that page and watch for both the mail and the text.
   - A **new** rule has not been seen to fire until it has: make it fire once
     and record the firing on that page, beside the rule.

   A rule that exists and pages nobody is worse than a visibly empty alert
   inventory, because it looks fixed.
4. Smoke: from the repository root, `node scripts/smoke-deployed.mjs`
   (see script header for flags) — anonymous surface filtered, admin guards
   refusing, health endpoint answering. **Run it from an operator machine, not
   from Actions.** A **Validate Deployed Surface** workflow once did this and
   was **retired on 2026-09-08**: neither of its jobs could pass. Both ran on a
   GitHub-hosted runner whoever dispatched them, and through Cloudflare that
   runner is answered by Bot Fight Mode with a 403, while direct to the origin
   it is answered by the origin lock with a 403 — the surface job asserted a
   200 from the apex and got that 403 too. This runbook previously said the
   surface half "still runs usefully", which the job history disproves.
   `deploy-functions.yml` used to rely on Cloudflare's 403 to prove the origin
   lock, which proved nothing: Bot Fight Mode answers a runner with 403
   whether the Azure restriction is on or off. Since PLAT-2 (#962) it reads
   the Function App's access restriction from the control plane instead and
   fails unless unmatched requests are `Deny` and every Allow rule matches
   what `infra/` declares (`scripts/assert-origin-lock.mjs`), so a deploy while
   `functions_origin_lock_enabled` is false goes red by design. That assertion
   accepts any one-host `ci-*` window, because a concurrent run may hold one;
   a window whose run died before closing it is named by the hourly
   `monitor-functions-registered.yml`, with the command that removes it
   (#1050). The operator path is
   [Edge and DNS verification](edge-dns-verification.md). Making the smoke job
   pass from CI needs the same Cloudflare change that blocked the standard
   availability test (T-519 itself closed 2026-09-01 by routing around it with
   the ADR 0024 Worker; runner paths stay blocked); the alternatives are
   weakening the origin lock or asserting against a host that answers without
   touching the API. Tiers 2–3 need credentials and stay operator-run
   regardless.
5. Azure portal / CLI spot checks for the changed resources.
6. Application Insights: no new exception cluster in the 30 minutes after
   apply; both budgets' configuration intact after any change that touches
   them.
7. Update Required-Inputs status (`SET` → `VERIFIED`) for
   any input exercised for the first time.

## 5. Rollback

**A failed apply is not a rollback.** Terraform converges forward: on error it
skips everything that depends on the failed resource, still runs everything
that does not, and leaves state wherever it got to. Nothing is undone, and a
destroy that has already run is gone. (This paragraph said Terraform "stops
scheduling new nodes" on an error until 2026-10-09. It does not: its graph
walker skips only the failed resource's dependents, which is why an error in
an unrelated resource cannot stop the azapi strip in §4 step 1.) So the response to a red apply is §4 step 1 followed by re-running to
convergence — investigate from a known state, not from a half-applied one. Most
partial applies are harmless and self-heal on the next run; the one that does
not announce itself is the Function App case in §4 step 1.

Deliberate rollback is **roll-forward to the previous definition**:

1. Revert the merge commit in Git (`git revert`), PR it, merge.
2. Plan and apply the revert through the same gates (§2–§3).
3. `prevent_destroy` resources cannot be rolled back by replacement. If a
   bad change landed *inside* one (e.g. an indexing policy), the revert
   updates it in place. If the resource itself must go, that is a human
   decision recorded on a GitHub issue — remove the guard in a dedicated PR that
   says so in its title.
4. State surgery (`terraform state mv/rm`, imports) is a last resort:
   snapshot the state first (TFC keeps versions), record the commands run
   in the PR that motivated them.

## 6. Day-2 operations

| Concern | Mechanism | Where |
| --- | --- | --- |
| Cost | Two **subscription**-scoped budgets — USD 150 on the application subscription, USD 25 on Platform Management for Log Analytics — each at 50/75/90/100% actual plus a forecast alert | `azurerm_consumption_budget_subscription` (two) in `infra/budget.tf`, [Cost analysis](../architecture/cost-analysis.md) |
| Alerting | Metric and log rules routed through `ag-plat-prod-cus-01`. This row read "**declared, not yet applied**; the live estate has none" until 2026-09-07; that is **no longer true** — `alert-api-reachability-prod-cus` has been armed since 2026-09-01 (T-519), and the rules are on `main`, not on a branch. Which rules the last apply carried is a live-tenant question: `az monitor scheduled-query list -g rg-web-site-prod-cus` answers it. What each one means, what to check first, and what nothing watches | [Alerting and support](../runbooks/alerting-and-support.md), `infra/observability.tf` |
| Drift | Periodic TFC plan (enable a scheduled speculative plan); investigate non-empty plans — portal edits are defects | TFC workspace settings |
| Computed properties | The apply writes `cp_sortDate` onto `content` and `blogs` whenever it updates either container, and fails if the container lacks it afterwards (`azapi_update_resource.cosmos_computed_properties`, #816). Nothing repairs it on a timer: the six-hourly `heal-computed-properties.yml`, its custom role and the script's `--apply` path were deleted once the apply had held (#816). `node scripts/apply-computed-sortdate.mjs --inspect` remains, run locally, to check that every date alias is ISO-sortable | `infra/cosmos.tf`, `scripts/lib/cosmos-sort-date.mjs` |
| Secrets | Values live only in Key Vault. Seeded from **Admin → Platform → API Keys**, which writes from inside the integration subnet through a set-only role — no firewall window. `scripts/cutover/06-seed-secret.ps1` remains the break-glass path for when the app itself is down: it opens a firewall rule for the caller's address directly, not through `admin_ip_rules`, and removes it in a `finally`. References in Required-Inputs §4.6 | `scripts/cutover/06-seed-secret.ps1`, Key Vault |
| Storage access | Account keys are disabled on both production accounts by `storage_shared_access_key_enabled`, which **defaults to `false` on `main`** (`infra/variables.tf`, `infra/storage.tf`); this row named the retired `fix/go-live-remediation` branch until 2026-09-07. Rollback is one edit to `true` and an apply. From that apply on, `az storage` data-plane commands and the portal Storage Browser default to key auth and answer 403: use `--auth-mode login` plus a data-plane role, and note the content account has no operator network path at all | [Alerting and support](../runbooks/alerting-and-support.md#break-glass-storage-after-shared-key-authentication-is-disabled) |
| Purge protection | `purge_protection_enabled` is **`true`** by an owner decision of 2026-09-14. It is one-way: once applied, Azure refuses to turn it off, and a deleted vault stays soft-deleted and unpurgeable, with its name reserved, for 90 days | [ADR 0031](../decisions/0031-security-scanner-owner-decisions.md), superseding [ADR 0021](../decisions/0021-key-vault-purge-protection.md) |
| Dependency and action updates | Dependabot (npm + github-actions) with CI as the gate | `.github/dependabot.yml` |
| Telegram pairing | A phone that loses the bot is paired again from the Reminders tab, which shows the owner's QR artwork, a verified plain code for `https://t.me/agenticarchitectbot` beneath it, the three re-pairing steps and the **Test Telegram** button, whose message arriving on that phone is the proof; the bot answers only the chat id in `TELEGRAM-CHAT-ID`, which the same Telegram account keeps on any phone | [`/admin/platform-settings?tab=reminders`](https://hybridcloudworks.com/admin/platform-settings?tab=reminders), `frontend/src/components/admin/platform-settings/TelegramReconnectPanel.jsx` |

## 7. ALZ absorption

The subscription is a standalone platform subscription today and is expected
to move under an Azure Landing Zone management-group hierarchy. Nothing in
`infra/` assumes tenant-root placement, so the move is administrative — but
policy inheritance is not, and it is where the friction will be.

Sequence, when the ALZ exists:

1. **Inventory in audit mode.** Ask the ALZ operators for the policy set of
   the target management group; run it in audit against this subscription.
   Expected friction points: public-network-access defaults on Cosmos and
   Storage (the static-first architecture deliberately serves public media
   through the Function App identity), Key Vault firewall shape, allowed
   regions, mandated diagnostic-settings destinations.
2. **Remediate or exempt, in-repo.** Every remediation is a normal PR
   through this runbook; every exemption is recorded as an ADR.
3. **Move the subscription** into the management group (ALZ operators).
4. **Verify survivors.** Budget, RBAC role assignments, and the OIDC
   deployment identities are subscription-scoped and should survive; run
   §4 verification plus a full plan to confirm zero drift.
5. **Re-point diagnostics** to the central Log Analytics workspace if the
   ALZ mandates one — additive diagnostic settings, not replacement of the
   local workspace.

Tags are already the ALZ contract (`workload`, `environment`, `owner`,
`costCenter`, `managedBy`, `criticality`, `dataClassification`); do not fork
the schema per-resource.

---

*Companion pages: [IaC Repository Standard](../standards/iac-repository-standard.md) ·
[Migration Runbook](../history/migration-runbook.md) · [Architecture](../architecture/architecture.md) ·
[Well-Architected assessment](../architecture/well-architected-assessment.md)*

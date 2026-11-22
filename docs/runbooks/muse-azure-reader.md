# Muse's read-only Azure access: turn it on, rotate it, revoke it

> **Status: built, switched off.** Owner request of 2026-11-22
> ([#1763](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1763)).
> The Terraform is in
> [`infra/muse-reader.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/muse-reader.tf);
> nothing is created until you do "Turn it on" below. The decision and its
> trade-offs are in [ADR 0042](../decisions/0042-muse-azure-reader.md).

**Scope:** what Muse can read in Azure, the one-time setup, how to hand the
secret to Muse, how to rotate it, and how to take the access away.

**Authority:** read only. Muse can look at everything in the three
subscriptions and change nothing.

## What it is, in plain words

Muse runs Koda, the content agent
([ADR 0037](../decisions/0037-agent-content-api.md)). When an alert email
arrives, Koda can now look at the evidence itself: the logs in Application
Insights and Log Analytics, the alert rules, what things cost and whether
Azure reports a resource as unhealthy.

To do that, Muse signs in to Azure as its own identity: an **app
registration** (an entry in Microsoft Entra, the directory that holds the
estate's sign-ins) named `sp-muse-reader-plat-prod-cus-01`, with a **client
secret** (a password for a program). That identity holds the built-in
**Reader** role on each of the three subscriptions:

| Subscription | What is in it |
| --- | --- |
| `sub-app-site-prod-cus` (application) | The site: Function App, Static Web App, Cosmos DB, storage, Key Vault, Application Insights, the lab host's Azure Arc machine |
| `sub-plat-mgmt-prod-cus` (management) | The central Log Analytics workspace, the action group, the platform alert rules |
| `sub-plat-conn-prod-cus` (connectivity) | The hub network |

### What Reader can and cannot read

Reader is "look, don't touch": it allows every read and no change
([Reader role definition](https://learn.microsoft.com/en-us/azure/role-based-access-control/built-in-roles#reader)).

| Muse **can** | Why |
| --- | --- |
| Run log queries in Log Analytics and Application Insights | A query is the read action `Microsoft.OperationalInsights/workspaces/query/read`, which Reader's `*/read` covers ([Manage access to Log Analytics workspaces](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/manage-access)) |
| List alert rules, action groups, and the alerts that fired | Plain reads |
| See costs, budgets and forecasts | Reader is "Read only" on Cost Analysis, budgets and alerts ([Cost Management scopes](https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/understand-work-scopes)) |
| See Resource Health and every resource's settings | Plain reads |

| Muse **cannot** | Why |
| --- | --- |
| Change, create, restart or delete anything | Reader has no write action |
| Read a Key Vault secret's value | That is a data action; Reader has none |
| Read storage blobs, Cosmos DB documents, or a storage account's keys | Data actions, or a `listKeys` action, not reads |
| Read the Function App's setting values | Listing them is an action (`config/list`), not a read |
| Read a Log Analytics table marked "protected" | Protected tables need a separate data role ([protected tables](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/manage-access)); none is set up in this estate today |

One thing to be aware of: logs can carry what visitors sent (IP addresses,
for example), and Reader can read every log. That is the point of the access,
and it is why the secret is treated like any other production credential.

## Turn it on (one time, owner only)

Do these from PowerShell on your computer, in your clone of this repository,
on `main`, after the pull request for #1763 has merged. Sign in to `az` as
yourself first (`az login`). You need to be able to assign Entra roles
(Privileged Role Administrator or Global Administrator).

1. **Give the Terraform run identity the Entra role "Application
   Developer".** Until now this identity (`id-plat-terraform-prod-cus-01`,
   the one HCP Terraform signs in as) could only manage Azure resources, not
   Entra entries. Application Developer lets it create app registrations and
   change only the ones it created; it cannot touch any other app, user or
   group ([role reference](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference#application-developer)).
   This is a lasting extra permission for the run identity; ADR 0042 records
   it.

   ```powershell
   $sp = @(az ad sp list --display-name id-plat-terraform-prod-cus-01 -o json | ConvertFrom-Json); if ($sp.Count -ne 1) { Write-Error "Expected one identity named id-plat-terraform-prod-cus-01, found $($sp.Count)" } else { @{ principalId = $sp[0].id; roleDefinitionId = 'cf1c38e5-3621-4004-a7cb-879624dced7c'; directoryScopeId = '/' } | ConvertTo-Json -Compress | Set-Content -Encoding utf8NoBOM "$env:TEMP\hcw-app-developer.json"; az rest --method POST --url https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments --body "@$env:TEMP\hcw-app-developer.json" }
   ```

   **Worked:** a block of JSON that includes
   `"roleDefinitionId": "cf1c38e5-3621-4004-a7cb-879624dced7c"`.
   **If you see** `Authorization_RequestDenied`, your account cannot assign
   Entra roles; sign in with one that can and run it again. **If you see**
   `A conflicting object with one or more of the specified property values is present`,
   the role is already there; carry on.

2. **Turn the switch on.** Open the workspace variables page,
   [hcw-azure → Variables](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables),
   choose **+ Add variable**, pick **Terraform variable**, key
   `muse_reader_enabled`, value `true`, tick **HCL**, leave **Sensitive**
   unticked, and save.

3. **Run a plan and read it.** On
   [hcw-azure → Runs](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs)
   choose **New run** → **Plan and apply**. **Worked:** the plan shows
   **7 to add** for these, and nothing else from this change:
   `azuread_application.muse_reader[0]`,
   `azuread_service_principal.muse_reader[0]`,
   `time_rotating.muse_reader_secret[0]`,
   `azuread_application_password.muse_reader[0]`, and
   `azurerm_role_assignment.muse_reader_app[0]`, `_mgmt[0]` and `_conn[0]`,
   each with `role_definition_name = "Reader"`. **If you see** anything
   else to change or destroy, stop and do not confirm.

4. **Confirm the apply.** ⚠️ This creates the app registration and the three
   grants. **Worked:** the run ends **Applied** with 7 added. **If it fails**
   with `Authorization_RequestDenied` on `azuread_application`, step 1 has
   not taken effect yet; wait five minutes and start a new run.

5. **Copy the secret into Muse's vault.** This reads the secret from the
   workspace's state straight into your clipboard; it is never shown on
   screen. You need to be signed in to HCP Terraform on this computer
   (`terraform login`, once).

   ```powershell
   Set-Location infra; terraform init -input=false | Out-Null; terraform output -raw muse_reader_client_secret | Set-Clipboard; terraform output -raw muse_reader_client_id; terraform output -raw muse_reader_tenant_id; terraform output -raw muse_reader_secret_expires; Set-Location ..
   ```

   **Worked:** three lines print: the client id, the tenant id (both are
   identifiers, not secrets) and the date the secret stops working; the
   secret itself is on your clipboard. Paste the three values and the secret
   into Muse's own secure vault, then clear the clipboard with
   `Set-Clipboard -Value $null`. **If you see** `No outputs found` or
   `Output "muse_reader_client_secret" not found`, the apply in step 4 has
   not finished; **if you see** `Required token could not be found`, run
   `terraform login` and try again.

6. **Record the date on the Credentials tab.** Open
   [Admin → Integrations → Credentials](https://hybridcloudworks.com/admin/integrations?tab=credentials),
   find `muse_reader_client_secret` under **HCP Terraform hcw/hcw-azure**,
   and record today as the date it was made. That sets the 180-day reminder.

7. **Check the three grants.**

   ```powershell
   $app = @(az ad app list --display-name sp-muse-reader-plat-prod-cus-01 -o json | ConvertFrom-Json); foreach ($s in 'sub-app-site-prod-cus', 'sub-plat-mgmt-prod-cus', 'sub-plat-conn-prod-cus') { az role assignment list --assignee $app[0].appId --subscription $s -o json | ConvertFrom-Json | Select-Object roleDefinitionName, scope }
   ```

   **Worked:** three rows, each `Reader`, each with a scope of
   `/subscriptions/` and one subscription id and nothing after it.

## Rotate the secret

**On schedule (every 180 days).** The reminders sheet raises it. Run a plan
and apply on
[hcw-azure → Runs](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs):
from day 180 the plan replaces `time_rotating.muse_reader_secret[0]` and
`azuread_application_password.muse_reader[0]`. Then do step 5 and step 6 of
"Turn it on" again. The old secret stops working in that same apply, so have
Muse's vault open. If no apply happens, the old secret keeps working for 30
more days, then stops.

**Now (for example after a suspected leak).** On
[hcw-azure → Variables](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables)
set `muse_reader_secret_generation` one higher than it is (add it with value
`2`, HCL ticked, if it is not there yet). Run a plan and apply; the plan
replaces the same two resources and nothing else. Then do steps 5 and 6
again. The leaked secret stops working when the apply finishes.

## Revoke it

**For good.** On
[hcw-azure → Variables](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables)
set `muse_reader_enabled` to `false`, then run a plan and apply. ⚠️ The plan
**destroys** the app registration, its secret and the three Reader grants
(seven resources); this cannot be undone, and turning it back on later makes
a new app with a new client id. **Worked:** the run ends **Applied** with 7
destroyed, and step 7 above finds nothing.

**Right now, while you set that up.** Turn the identity off so it can get no
new sign-in token:

```powershell
$app = @(az ad app list --display-name sp-muse-reader-plat-prod-cus-01 -o json | ConvertFrom-Json); az ad sp update --id $app[0].appId --set accountEnabled=false
```

**Worked:** no output. A token Muse already holds keeps working until it
expires, which is usually within about an hour. Follow this with the
"For good" step: the next apply would otherwise switch the identity back on,
because Terraform manages that setting.

## Related

- [ADR 0042](../decisions/0042-muse-azure-reader.md): why an app registration
  with a secret, why Reader on whole subscriptions, and the risks accepted.
- [Required inputs §4.1 and §4.10](../standards/required-inputs.md): the two
  workspace variables and the four outputs.
- [Variables and secrets](../standards/variables-and-secrets.md): why this one
  secret is allowed in Terraform state.
- [Credential compromise](credential-compromise.md): the general response when
  any credential may have leaked.

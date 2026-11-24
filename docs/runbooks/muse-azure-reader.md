# Muse's read-only Azure access: turn it on, rotate it, revoke it

> **Status: turned on.** The first apply failed part-way on 2026-11-23 and
> the corrected one succeeded on 2026-11-24 (the owner's report; a session
> cannot read the workspace). The secret was replaced once that day
> (generation 2) and Muse signed in with the sign-in header of step 5 (the
> owner's report). What is left for the owner is step 6 of "Turn it on"
> and step 6 of "Recover from the failed first apply".
> Owner request of 2026-11-22
> ([#1763](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1763)).
> The Terraform is in
> [`infra/muse-reader.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/muse-reader.tf).
> The decision and its trade-offs are in
> [ADR 0043](../decisions/0043-muse-azure-reader.md), which was corrected on
> 2026-11-23: step 1 used to give the run identity the Entra role
> "Application Developer", and that role turned out not to be enough.
> In the admin portal this secret, and the sign-in Terraform runs with, are
> listed on the **Microsoft Azure and Entra ID** card under
> [Integrations → Services → Site platform](https://hybridcloudworks.com/admin/integrations?tab=services&group=platform).

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
| Use most resource settings to act | It **can** read settings that are ordinary properties, which includes Application Insights connection strings (enough to send made-up telemetry, not to read any) and the inputs of past deployments. Nothing in this estate keeps a secret there: Key Vault holds them |
| Read a Log Analytics table marked "protected" | Protected tables need a separate data role ([protected tables](https://learn.microsoft.com/en-us/azure/azure-monitor/logs/manage-access)); none is set up in this estate today |

One thing to be aware of: logs can carry what visitors sent (IP addresses,
for example), and Reader can read every log. That is the point of the access,
and it is why the secret is treated like any other production credential.

## Turn it on (one time, owner only)

Do these from PowerShell on your computer, in your clone of this repository,
on `main`, after the pull request for #1763 has merged. Sign in to `az` as
yourself first (`az login`). You need to be able to give Microsoft Graph
permissions (Privileged Role Administrator or Global Administrator).

1. **Give the Terraform run identity the Microsoft Graph permission
   `Application.ReadWrite.OwnedBy`.** Until now this identity
   (`id-plat-terraform-prod-cus-01`, the one HCP Terraform signs in as) could
   only manage Azure resources, not Entra entries. Microsoft Graph is the API
   (the web interface programs call) that Entra entries are managed through,
   and this permission lets a program create app registrations and their
   service principals (the sign-in identity each app registration gets in
   this directory) and then change or delete **only the ones it owns**. It
   can also list every app in the directory, but not change them
   ([Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference#applicationreadwriteownedby)).
   It is the permission the Terraform provider's own page names for a
   program that is not a person
   ([`azuread_service_principal`, "API Permissions"](https://github.com/hashicorp/terraform-provider-azuread/blob/v3.10.0/docs/resources/service_principal.md#api-permissions)).
   This is a lasting extra permission for the run identity; ADR 0043 records
   it. "Why not the Application Developer role" below says why the role this
   step used to give did not work.

   The line looks the permission up by its name, so no id is typed by hand
   (`00000003-0000-0000-c000-000000000000` is Microsoft Graph's own
   application id, the same in every directory:
   [Grant or revoke API permissions programmatically](https://learn.microsoft.com/en-us/graph/permissions-grant-via-msgraph)).

   ```powershell
   $sp = @(az ad sp list --display-name id-plat-terraform-prod-cus-01 -o json | ConvertFrom-Json); $graph = az ad sp show --id 00000003-0000-0000-c000-000000000000 -o json | ConvertFrom-Json; $role = @($graph.appRoles | Where-Object { $_.value -eq 'Application.ReadWrite.OwnedBy' }); if ($sp.Count -ne 1 -or $role.Count -ne 1) { Write-Error "Expected one identity named id-plat-terraform-prod-cus-01 and one permission named Application.ReadWrite.OwnedBy, found $($sp.Count) and $($role.Count)" } else { @{ principalId = $sp[0].id; resourceId = $graph.id; appRoleId = $role[0].id } | ConvertTo-Json -Compress | Set-Content -Encoding ascii "$env:TEMP\hcw-app-ownedby.json"; az rest --method POST --url "https://graph.microsoft.com/v1.0/servicePrincipals/$($graph.id)/appRoleAssignedTo" --body "@$env:TEMP\hcw-app-ownedby.json" }
   ```

   **Worked:** a block of JSON that includes
   `"principalDisplayName": "id-plat-terraform-prod-cus-01"` and
   `"resourceDisplayName": "Microsoft Graph"`. Nothing else is needed: giving
   the permission this way is the administrator's consent
   ([Grant an appRoleAssignment](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-post-approleassignments?view=graph-rest-1.0)).
   **If you see** `Authorization_RequestDenied`, your account cannot give
   Graph permissions; sign in with one that holds Privileged Role
   Administrator or Global Administrator and run it again. **If you see** a
   message that the permission already exists on the object, it is already
   there; carry on. **If you see** a message asking for multi-factor
   authentication, run the `az login` line that message prints, then this
   line again.

   To check it at any time (read-only; it prints the name of each Graph
   permission the run identity holds):

   ```powershell
   $sp = @(az ad sp list --display-name id-plat-terraform-prod-cus-01 -o json | ConvertFrom-Json); $graph = az ad sp show --id 00000003-0000-0000-c000-000000000000 -o json | ConvertFrom-Json; if ($sp.Count -ne 1) { Write-Error "Expected one identity named id-plat-terraform-prod-cus-01, found $($sp.Count)" } else { (az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp[0].id)/appRoleAssignments" -o json | ConvertFrom-Json).value | ForEach-Object { $id = $_.appRoleId; ($graph.appRoles | Where-Object { $_.id -eq $id }).value } }
   ```

   **Worked:** one line, `Application.ReadWrite.OwnedBy`. No output means
   the identity holds no Graph permission yet.

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
   `time_static.muse_reader_secret[0]`,
   `azuread_application_password.muse_reader[0]`, and
   `azurerm_role_assignment.muse_reader_app[0]`, `_mgmt[0]` and `_conn[0]`,
   each with `role_definition_name = "Reader"`. **If you see** anything
   else to change or destroy, stop and do not confirm.

4. **Confirm the apply.** ⚠️ This creates the app registration and the three
   grants. **Worked:** the run ends **Applied** with 7 added. **If it fails**
   with `Authorization_RequestDenied` (also shown as `403 Forbidden` and
   `Insufficient privileges to complete the operation`), read which resource
   the error names, because the two cases differ:

   - on `azuread_application.muse_reader[0]`: nothing was made. Step 1 is
     missing or has not taken effect yet; check it with step 1's second
     line, wait five minutes and start a new run.
   - on `azuread_service_principal.muse_reader[0]`, with the words
     `Failed to patch service principal after creating`: the app
     registration and a half-made service principal now exist. This is what
     happened on 2026-11-23. Do "Recover from the failed first apply" below;
     do not just start the run again.

5. **Copy the sign-in header into Muse's vault.** This reads the secret
   from the workspace's state, wraps it the way Muse needs, and puts the
   result on your clipboard; nothing secret is shown on screen.

   **Muse cannot use the plain secret, so what you paste is a wrapped
   form of it.** Muse can only send a stored value as a header (a labelled
   line sent ahead of a request), unchanged; it cannot put one in the form
   body, which is where a client secret normally goes. Found on 2026-11-24:
   three pastes of the plain secret were each refused with
   `AADSTS7000215` (invalid client secret) although the secret was right.
   Microsoft also accepts the secret in an `Authorization` header, "the
   Basic auth pattern"
   ([client credentials flow, "Get a token"](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow#get-a-token)).
   So the line below builds the whole header value, the word `Basic`, a
   space, and the client id and secret joined by a colon and encoded as
   base64 (a way of writing bytes as letters and digits), and Muse stores
   and sends exactly that. Muse's request body then holds only
   `grant_type=client_credentials` and the scope, with no client id and no
   secret.

   **The header value is as sensitive as the secret.** Base64 is
   packaging, not protection: anyone who has it can sign in as Muse. It
   goes only into Muse's secure field.

   **This step only works from the repository's folder, on an up-to-date
   `main`.** It reads a file in the repository (`infra\muse-reader.tf`,
   which is on `main`). On 2026-11-24 the earlier version of this line was
   run from `C:\Users`: its first command failed, PowerShell carried on,
   every later command ran in the wrong folder and the prompt ended up at
   `C:\`. So do these two lines first.

   Go to your clone (your copy of the repository on this computer). This
   looks for it under your user folder and moves there:

   ```powershell
   $found = @(Get-ChildItem -Path $HOME -Directory -Recurse -Depth 4 -Filter HCW-HybridCloudWorks -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'infra\muse-reader.tf') }); if ($found.Count -eq 1) { Set-Location $found[0].FullName; Get-Location } else { Write-Output "Found $($found.Count) folders named HCW-HybridCloudWorks that hold infra\muse-reader.tf:"; $found.FullName }
   ```

   **Worked:** it prints one path and the prompt is now in that folder.
   **If you see** `Found 0 folders`, the clone is somewhere else (another
   drive, or under a different folder name) or its `main` is too old to
   have the file: open the folder yourself with `Set-Location` and its
   path, then carry on. **If you see** `Found 2` or more, it lists them;
   `Set-Location` to the one you normally work in.

   Then bring `main` up to date:

   ```powershell
   git switch main; git pull --ff-only; Test-Path infra\muse-reader.tf
   ```

   **Worked:** `Already up to date.` or a list of updated files, then
   `True`. **If you see** `False`, or an error from `git switch` about
   local changes, stop here: you are not on a clean `main`, and the next
   line will refuse to run.

   You also need to be signed in to HCP Terraform on this computer
   (`terraform login`, once). Now the line itself:

   ```powershell
   if (-not (Test-Path infra\muse-reader.tf)) { Write-Error 'Stopped, nothing was run: this folder is not the repository root, or main is not up to date (infra\muse-reader.tf is not here).' } else { Push-Location infra; try { terraform init -input=false | Out-Null; if ($LASTEXITCODE -ne 0) { Write-Error 'Stopped, nothing was copied: terraform init failed. Run it by itself to see why: terraform -chdir=infra init -input=false' } else { $sec = terraform output -raw muse_reader_client_secret; if ($LASTEXITCODE -ne 0) { Write-Error 'Stopped, nothing was copied: the secret could not be read. The message above says why.' } else { $cid = terraform output -raw muse_reader_client_id; ('Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([uri]::EscapeDataString("$cid") + ':' + [uri]::EscapeDataString("$sec")))) | Set-Clipboard; $sec = $null; foreach ($name in 'muse_reader_client_id', 'muse_reader_tenant_id', 'muse_reader_secret_expires') { $value = terraform output -raw $name; Write-Output "${name}: $value"; Write-Output '' }; Write-Output 'The sign-in header is on the clipboard.' } } } finally { git checkout -- .terraform.lock.hcl; Pop-Location } }
   ```

   The line checks the folder before it does anything, and always comes
   back to the folder it started in. The `git checkout` puts back the
   provider lock file (the file that pins the exact provider versions),
   which `terraform init` may have added Windows entries to.

   **Worked:** three labelled lines with a blank line after each (the
   client id, the tenant id, which are identifiers and not secrets, and the
   date the secret stops working), then `The sign-in header is on the
   clipboard.` Paste the header into Muse's secure field **before you copy
   anything else**: copying one of the three printed values first replaces
   it on the clipboard, and Muse then stores an id in place of the
   credential. Save, then clear the clipboard with
   `Set-Clipboard -Value ' '`. Muse already has the client id and tenant
   id; check they match the two printed.

   The line keeps the secret in a PowerShell variable for the moment it
   takes to wrap it, then empties the variable. The owner ran the same
   wrapping on 2026-11-24 and Muse signed in with the result; this guarded
   form of the line has not been run since it was rewritten.

   **If you see** `Stopped, nothing was run`, you are not in the repository
   folder or `main` is behind: do the two lines above again. **If you see**
   `Stopped, nothing was copied: terraform init failed`, run the command
   that message gives; when its output says `Required token could not be
   found` (followed by `Run the following command to generate a token for
   app.terraform.io: terraform login`), run `terraform login`, approve it in
   the browser, and run the line again. **If you see** `No outputs found` or
   `Output "muse_reader_client_secret" not found`, the apply in step 4 has
   not finished. **If you see** `Unsupported value for raw output`, the
   output is empty because `muse_reader_enabled` is not `true` in the
   workspace (step 2).

6. **Record the date on the Credentials tab.** Open
   [Admin → Integrations → Credentials](https://hybridcloudworks.com/admin/integrations?tab=credentials),
   find `muse_reader_client_secret` under **HCP Terraform hcw/hcw-azure**,
   and record today as the date it was made. That sets the reminder, due 180 days later.

7. **Check the three grants.**

   ```powershell
   $app = @(az ad app list --display-name sp-muse-reader-plat-prod-cus-01 -o json | ConvertFrom-Json); if ($app.Count -ne 1) { Write-Error "Expected one app named sp-muse-reader-plat-prod-cus-01, found $($app.Count)" } else { foreach ($s in 'sub-app-site-prod-cus', 'sub-plat-mgmt-prod-cus', 'sub-plat-conn-prod-cus') { az role assignment list --assignee $app[0].appId --subscription $s -o json | ConvertFrom-Json | Select-Object roleDefinitionName, scope } }
   ```

   **Worked:** three rows, each `Reader`, each with a scope of
   `/subscriptions/` and one subscription id and nothing after it.

## Recover from the failed first apply

On 2026-11-23 the first apply stopped with this, after step 1 had given the
run identity the Entra role "Application Developer" (what this runbook said
then):

```text
Error: Failed to patch service principal after creating
  with azuread_service_principal.muse_reader[0]
unexpected status 403 (403 Forbidden) with error: Authorization_RequestDenied: Insufficient privileges to complete the operation.
```

**What that left behind.** Terraform had already made the app registration
`sp-muse-reader-plat-prod-cus-01`, and had made its service principal too.
Only the small follow-up change Terraform always makes straight after
creating a service principal was refused. So:

- The app registration exists and Terraform knows about it. It is kept; its
  client id does not change.
- The service principal exists, half-made, with no access to anything (the
  three Reader grants come after it and were never reached). Terraform
  records a resource in that position as **tainted**, which means "made, but
  not finished: replace it on the next run"
  ([Terraform: taint](https://developer.hashicorp.com/terraform/cli/state/taint)).
- A client secret may exist as well, because Terraform can make it at the
  same time as the service principal. If it does, it is in the workspace's
  state like any later one. It is useless until the Reader grants exist.

Nothing has to be deleted by hand in the usual case: the next run replaces
the half-made service principal by itself, once the run identity is allowed
to.

1. **Look at what exists (read-only, changes nothing).** Your `az` sign-in
   needs the multi-factor sign-in for Microsoft Graph you did for step 1.

   ```powershell
   $n = 'sp-muse-reader-plat-prod-cus-01'; az ad app list --display-name $n -o json | ConvertFrom-Json | Select-Object displayName, createdDateTime, @{ n = 'secrets'; e = { @($_.passwordCredentials).Count } } | Format-List; $sp = @(az ad sp list --display-name $n -o json | ConvertFrom-Json); $sp | Select-Object displayName, description, accountEnabled | Format-List; if ($sp.Count -eq 1) { az ad sp owner list --id $sp[0].id -o json | ConvertFrom-Json | Select-Object @{ n = 'owner'; e = { $_.displayName } } | Format-List }
   ```

   **Expected:** one app registration (with `secrets` 0 or 1); one service
   principal whose `description` starts with `TERRAFORM_UPDATE_` (a
   temporary marker Terraform writes and then replaces; seeing it proves the
   follow-up change never happened); and one `owner`,
   `id-plat-terraform-prod-cus-01`. **If you see** two app registrations, no
   owner, or a different owner, stop and paste the output into
   [#1763](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1763):
   none of it is secret, and the line prints no ids. **If you see** no
   service principal at all, that is fine: the next run just creates one.

2. **Give the run identity the Graph permission.** Do step 1 of "Turn it on"
   above (both lines: the grant, then the check). Leave the Application
   Developer role in place for now; step 6 removes it.

3. **Start a new run and read the plan.** On
   [hcw-azure → Runs](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs)
   choose **New run** → **Plan and apply**. ⚠️ This plan **deletes** one
   thing on purpose, the half-made service principal, and makes a new one in
   its place. Nothing uses the old one. **Worked:** the plan says
   `azuread_service_principal.muse_reader[0]` `is tainted, so must be
   replaced`, adds `azurerm_role_assignment.muse_reader_app[0]`, `_mgmt[0]`
   and `_conn[0]` (each `role_definition_name = "Reader"`), and may add
   `time_static.muse_reader_secret[0]` and
   `azuread_application_password.muse_reader[0]` if the first run did not
   get to them. The summary line reads **4, 5 or 6 to add, 0 to change, 1 to
   destroy**. **If you see** `azuread_application.muse_reader[0]` in the plan
   at all, or anything else to change or destroy, stop and do not confirm (a
   second app registration with the same name must not be made). **If you
   see** the service principal as a plain `will be created` with nothing to
   destroy, while step 1 here showed that one exists, do "If Terraform says
   the service principal already exists" below first.

4. **Confirm the apply.** **Worked:** the run ends **Applied**. **If it
   fails** again with the same `Failed to patch service principal after
   creating`, wait ten minutes and start one more run (a new permission can
   take a few minutes to reach every Microsoft server). If that fails too,
   stop: paste the run's whole error block and the output of step 1 here
   into [#1763](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1763),
   with any long ids removed. The cause is then not the one this section
   fixes.

5. **Carry on with "Turn it on" from step 5** (copy the secret into Muse's
   vault, record the date, check the three grants).

6. **Take the Application Developer role away again.** ⚠️ This deletes the
   role assignment the old step 1 made. It is no longer needed, and Microsoft
   marks the role as privileged. It can be given back later if ever wanted
   (the old command is in this file's history).

   ```powershell
   $sp = @(az ad sp list --display-name id-plat-terraform-prod-cus-01 -o json | ConvertFrom-Json); if ($sp.Count -ne 1) { Write-Error "Expected one identity named id-plat-terraform-prod-cus-01, found $($sp.Count)" } else { $url = 'https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?$filter=principalId eq ''' + $sp[0].id + ''''; $ra = @((az rest --method GET --url $url -o json | ConvertFrom-Json).value | Where-Object { $_.roleDefinitionId -eq 'cf1c38e5-3621-4004-a7cb-879624dced7c' }); if ($ra.Count -ne 1) { Write-Output "Found $($ra.Count) Application Developer assignments for the run identity; nothing removed" } else { az rest --method DELETE --url "https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments/$($ra[0].id)"; Write-Output 'Application Developer removed from the run identity' } }
   ```

   **Worked:** the line `Application Developer removed from the run
   identity`, with no error above it. `Found 0 ...` means it was already
   gone. If the line errors instead, the same thing can be done by hand: no
   direct link to the page was found, so open the
   [Microsoft Entra admin center](https://entra.microsoft.com), then **Entra
   ID** → **Roles & admins** → **Application Developer** → select
   `id-plat-terraform-prod-cus-01` → **Remove assignments**.

7. **Prove the final setup.** Start one more run on
   [hcw-azure → Runs](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs).
   **Worked:** the plan shows no change to any `muse_reader` resource, which
   shows Terraform can still read them with the Graph permission alone.
   **If it fails** with `Authorization_RequestDenied` on a `muse_reader`
   resource, the Graph permission alone was not enough to read them: say so
   on [#1763](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1763)
   with the error block. Muse's access is not affected meanwhile.

### If Terraform says the service principal already exists

This is the less likely case: the half-made service principal is in Entra but
Terraform did not record it. The apply then fails with `A resource with the
ID ... already exists - to be managed via Terraform this resource needs to
be imported`. ⚠️ The fix **deletes** the half-made service principal (not the
app registration), so the next run can make a clean one:

```powershell
$sp = @(az ad sp list --display-name sp-muse-reader-plat-prod-cus-01 -o json | ConvertFrom-Json); if ($sp.Count -ne 1) { Write-Error "Expected one service principal named sp-muse-reader-plat-prod-cus-01, found $($sp.Count)" } else { az ad sp delete --id $sp[0].id }
```

**Worked:** no output. Then start a new run; the plan creates the service
principal and has nothing to destroy.

### Where to read what Terraform recorded

The plan in step 3 is the safe place to read it. The raw record is on
[hcw-azure → States](https://app.terraform.io/app/hcw/workspaces/hcw-azure/states)
(open the newest one and search for `muse_reader`; a half-made resource has
`"status": "tainted"`). ⚠️ That page shows the client secret in plain text if
one was made, so do not open it on a shared screen and do not copy from it
into an issue or a chat.

### Why not the Application Developer role

Checked on 2026-11-23 against Microsoft's and the provider's own pages:

- The role gives three "create" rights
  (`applications/createAsOwner`, `servicePrincipals/createAsOwner`,
  `oAuth2PermissionGrants/createAsOwner`) and then a list of things its
  holder may do to **app registrations** it owns. That list has no line for
  changing a **service principal** it owns
  ([role reference](https://learn.microsoft.com/en-us/entra/identity/role-based-access-control/permissions-reference#application-developer)).
- The rights to change an owned service principal
  (`servicePrincipals/basic/update` and the rest) are on a different list:
  what an ordinary signed-in **user** may do to things they own
  ([default user permissions, "Object ownership"](https://learn.microsoft.com/en-us/entra/fundamentals/users-default-permissions#object-ownership)).
  The run identity is a program, not a user.
- Straight after creating a service principal, the provider always sends one
  small change to it (it sets the description), and stops with exactly this
  error when that is refused
  ([provider source, v3.10.0](https://github.com/hashicorp/terraform-provider-azuread/blob/v3.10.0/internal/services/serviceprincipals/service_principal_resource.go#L500-L510)).
  No setting in `infra/muse-reader.tf` turns that change off, and the
  provider does put the run identity on the owner list when it creates the
  service principal.
- For a program, Microsoft's page for that change names the Graph permission
  `Application.ReadWrite.OwnedBy` as the smallest that allows it
  ([Update servicePrincipal](https://learn.microsoft.com/en-us/graph/api/serviceprincipal-update?view=graph-rest-1.0#permissions)).

That fits what happened step for step: create the app (allowed), rename the
app twice (allowed, it is on the role's list), create the service principal
(allowed), change the service principal (refused). It was not tested in a
spare directory, so one other cause is not ruled out: the change reaching a
Microsoft server that had not yet heard who owns the new service principal.
Step 4 above covers that case too.

## Rotate the secret

Each secret works for **210 days**. The reminders sheet asks for a rotation at
day 180, which leaves 30 days of slack. Nothing replaces the secret by itself:
only the steps below do, so an unrelated merge can never cut Muse off.
Rotate on the reminder, or at once after a suspected leak.

1. On
   [hcw-azure → Variables](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables)
   set `muse_reader_secret_generation` one higher than it is. If it is not
   there yet, add it as a Terraform variable with value `2`, **HCL** ticked.
2. Start a run on
   [hcw-azure → Runs](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs).
   **Worked:** the plan replaces exactly two resources,
   `time_static.muse_reader_secret[0]` and
   `azuread_application_password.muse_reader[0]`. **If you see** anything
   else from this file changing, stop and do not confirm.
3. ⚠️ Confirm the apply, with Muse's vault open: the old secret stops working
   in this apply.
4. Do steps 5 and 6 of "Turn it on" again: copy the new secret into Muse's
   vault (step 5 starts with the two lines that put you in the repository
   folder on an up-to-date `main`), and record today on the Credentials tab.

## Revoke it

**For good.** On
[hcw-azure → Variables](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables)
set `muse_reader_enabled` to `false`, then run a plan and apply. ⚠️ The plan
**destroys** the app registration, its secret and the three Reader grants
(seven resources). Terraform will not bring them back (Entra keeps a deleted
app restorable for 30 days, but restoring it by hand is not this runbook's
path), and turning it back on later makes
a new app with a new client id. **Worked:** the run ends **Applied** with 7
destroyed, and step 7 above finds nothing.

The run identity keeps its Graph permission after that, so it could still
create new app registrations. If Muse's access is gone for good, take the
permission away too. ⚠️ This deletes the grant from step 1 of "Turn it on":

```powershell
$sp = @(az ad sp list --display-name id-plat-terraform-prod-cus-01 -o json | ConvertFrom-Json); $graph = az ad sp show --id 00000003-0000-0000-c000-000000000000 -o json | ConvertFrom-Json; $role = @($graph.appRoles | Where-Object { $_.value -eq 'Application.ReadWrite.OwnedBy' }); if ($sp.Count -ne 1 -or $role.Count -ne 1) { Write-Error "Expected one identity and one permission, found $($sp.Count) and $($role.Count)" } else { $as = @((az rest --method GET --url "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp[0].id)/appRoleAssignments" -o json | ConvertFrom-Json).value | Where-Object { $_.appRoleId -eq $role[0].id }); if ($as.Count -ne 1) { Write-Output "Found $($as.Count) grants of Application.ReadWrite.OwnedBy; nothing removed" } else { az rest --method DELETE --url "https://graph.microsoft.com/v1.0/servicePrincipals/$($sp[0].id)/appRoleAssignments/$($as[0].id)"; Write-Output 'Application.ReadWrite.OwnedBy removed from the run identity' } }
```

**Worked:** the line `Application.ReadWrite.OwnedBy removed from the run
identity`, with no error above it.

**Right now, while you set that up.** Turn the identity off so it can get no
new sign-in token:

```powershell
$app = @(az ad app list --display-name sp-muse-reader-plat-prod-cus-01 -o json | ConvertFrom-Json); if ($app.Count -ne 1) { Write-Error "Expected one app named sp-muse-reader-plat-prod-cus-01, found $($app.Count)" } else { az ad sp update --id $app[0].appId --set accountEnabled=false }
```

**Worked:** no output. A token Muse already holds keeps working until it
expires, which is usually within about an hour. Follow this with the
"For good" step: the next apply would otherwise switch the identity back on,
because Terraform manages that setting.

## Related

- [ADR 0043](../decisions/0043-muse-azure-reader.md): why an app registration
  with a secret, why Reader on whole subscriptions, and the risks accepted,
  including the run identity's Graph permission.
- [Required inputs §4.1 and §4.10](../standards/required-inputs.md): the two
  workspace variables and the four outputs.
- [Variables and secrets](../standards/variables-and-secrets.md): why this one
  secret is allowed in Terraform state.
- [Integrations → Services → Site platform](https://hybridcloudworks.com/admin/integrations?tab=services&group=platform):
  the **Microsoft Azure and Entra ID** card, which lists this secret and the
  Terraform run identity (where each is kept, what it costs, how to check and
  replace it, when it expires).
- [Credential compromise](credential-compromise.md): the general response when
  any credential may have leaked.

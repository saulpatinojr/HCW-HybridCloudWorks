# Code Conductor brain: deploy, back up and switch on

The Code Conductor brain is a second private notes workspace, for engineering
notes. It works like the creator [Second Brain](second-brain.md) (versioned
saves, conflict protection, a desktop sync API) but is kept apart from it in
every way that can be configured: its own Cosmos database (`hcw_code_brain`,
in the existing account), its own on/off switch, owner, desktop client and
sign-in permission (the `code_brain_sync` scope). It holds no creator articles,
drafts or references. The reasons are in
[ADR 0036](../decisions/0036-code-conductor-brain.md); the ticket is
[#1457](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1457).

It ships **switched off**. Until the steps in part 3 are done, every route
under `/api/cms/code-brain/` answers 401 (no or wrong token), 403 (wrong
desktop client or role) or 404 (not switched on), and reads nothing.

All commands are PowerShell. Run them from the repository folder on `main`
after the pull request has merged.

## 1. Create the database, switched off

1. Open the `hcw-azure` workspace's runs at
   <https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs> and open the
   run for the merge commit. Wait for its plan to finish. Note the run's ID: it
   starts with `run-` and is the last part of the run page's address.
2. Check that run, and not just the workspace's newest one, against what this
   change declared. The first line asks you for the run ID from step 1; paste
   it and press Enter:

   ```powershell
   $runId = (Read-Host 'HCP Terraform run ID from step 1 (starts with run-)').Trim()
   ```

   ```powershell
   gh workflow run tfc-plan-check.yml --repo saulpatinojr/HCW-HybridCloudWorks --ref main -f run_id=$runId
   ```

   Wait about ten seconds for GitHub to start it, then list it:

   ```powershell
   gh run list --workflow tfc-plan-check.yml --repo saulpatinojr/HCW-HybridCloudWorks --limit 1
   ```

   Open the run it lists (its start time should be a few seconds ago; if it is
   older, wait and list again). The summary names the same `run-` ID you
   pasted; if it names a different one, the wrong run was checked, so do not
   apply. Success is a summary whose `DECLARED` lines include
   `azurerm_cosmosdb_sql_database.code_brain` create,
   `azurerm_cosmosdb_sql_container.code_brain["code_brain_records"]` create and
   the five `app_settings.CODE_BRAIN_*` additions, with no `UNEXPECTED` line.
   An `UNEXPECTED` line means the plan holds something this change did not
   ask for: do not apply; read the line first.
3. **Before you apply: this creates a database that Terraform will refuse to
   delete** (`prevent_destroy`). Removing it later takes its own reviewed pull
   request. Nothing is stored in it yet, and on the serverless account an
   empty database costs nothing. Then press **Confirm & apply** on the run.
   Success is the run's state reading **Applied**.
4. Deploy the Functions code, which adds the routes:

   ```powershell
   gh workflow run deploy-functions.yml --repo saulpatinojr/HCW-HybridCloudWorks --ref main
   ```

   Approve the `production` environment on the run if GitHub asks. Success is
   the run finishing green, smoke checks included.
5. Confirm the database and its container exist, partitioned by owner:

   ```powershell
   az cosmosdb sql container list -a cosmos-site-prod-cus -g rg-db-site-prod-cus -d hcw_code_brain -o json | ConvertFrom-Json | Select-Object name, @{ n = 'partitionKey'; e = { $_.resource.partitionKey.paths -join ',' } }
   ```

   Success is one row: `code_brain_records`, `/ownerId`. `NotFound` means the
   apply in step 3 has not finished.
6. Confirm the switches are off and the database is named:

   ```powershell
   az functionapp config appsettings list -g rg-web-site-prod-cus -n func-site-prod-cus-01 -o json | ConvertFrom-Json | Where-Object name -like 'CODE_BRAIN_*' | Select-Object name, value
   ```

   Success is five rows: `CODE_BRAIN_ENABLED` `false`,
   `CODE_BRAIN_COSMOS_DATABASE` `hcw_code_brain`, and the owner, tenant and
   client rows empty.
7. Confirm the routes are closed to an anonymous caller:

   ```powershell
   curl.exe -s -o NUL -w "%{http_code}" https://api-azure.hybridcloudworks.com/api/cms/code-brain/status
   ```

   Success is `401`.

## 2. Confirm the backup includes it

The daily export (03:00 UTC, [Cosmos restore](cosmos-restore.md)) adds
`code_brain_records` from the first run after step 3, because Terraform set
`CODE_BRAIN_COSMOS_DATABASE` in that apply. Check it the day after:

1. Look for the export's line for the new container:

   ```powershell
   az monitor app-insights query --app appi-site-prod-cus-01 -g rg-web-site-prod-cus --offset 2d --analytics-query 'traces | where message startswith "[cosmosExport] code_brain_records" | project timestamp, message | order by timestamp desc' -o table
   ```

   Success is at least one row such as
   `[cosmosExport] code_brain_records delta/2026-11-02: 0 docs, ...` (zero
   documents is right while the workspace is empty). No rows after 04:00 UTC
   means the export did not pick it up: check step 6 above, and the export's
   own health in [Cosmos restore](cosmos-restore.md#is-the-export-running-read-this-first).
2. Confirm the run completed with one more container than before:

   ```powershell
   az monitor app-insights query --app appi-site-prod-cus-01 -g rg-web-site-prod-cus --offset 2d --analytics-query 'customEvents | where name == "cosmosExportCompleted" | project timestamp, mode = tostring(customDimensions.mode), containers = toint(customDimensions.containers) | order by timestamp desc' -o table
   ```

   Success is a `delta` row with `58` containers, or a `full` row with `65`.

## 3. Register the desktop client and switch on

This part waits for one more piece of work: the desktop plugin in
`obsidian-plugin/` signs in with the creator brain's `brain_sync` scope and
calls the creator routes. Until it can be pointed at this workspace (its
routes and the `code_brain_sync` scope), switching on gives you an API nothing
can sync with. That work is tracked in
[#1467](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1467). Do
steps 1 to 4 whenever convenient; leave step 5 until #1467 is closed.

1. Sign in to Azure as the owner, then put the three identifiers the script
   needs into this window (they stay in this window; do not paste them into
   the repository):

   ```powershell
   $tenant = (az account show -o json | ConvertFrom-Json).tenantId
   ```

   ```powershell
   $owner = (az ad signed-in-user show -o json | ConvertFrom-Json).id
   ```

   ```powershell
   $api = (az functionapp config appsettings list -g rg-web-site-prod-cus -n func-site-prod-cus-01 -o json | ConvertFrom-Json | Where-Object name -eq 'ENTRA_API_AUDIENCE').value
   ```

   Success is that `$tenant`, `$owner` and `$api` each print a GUID when typed
   on their own.
2. Preview the registration. This only reads:

   ```powershell
   Test-Path scripts/brain/configure-entra-sync.ps1
   ```

   ```powershell
   ./scripts/brain/configure-entra-sync.ps1 -ApiAppId $api -TenantId $tenant -OwnerOid $owner -Workspace code
   ```

   Success is a JSON manifest with `displayName` `HCW Code Conductor Brain
   Obsidian`, one `resourceAccess` entry, and `No changes made.` If it says
   `The owner must already hold the API Admin role`, you are signed in as a
   different account.
3. **Before you run this: it changes Microsoft Entra.** It adds the
   `code_brain_sync` permission to the site's API registration and creates a
   new public desktop app registration with no secret. Existing permissions
   and the creator brain's client are kept as they are
   ([how scopes work](https://learn.microsoft.com/entra/identity-platform/quickstart-configure-app-expose-web-apis#add-a-scope)).

   ```powershell
   ./scripts/brain/configure-entra-sync.ps1 -ApiAppId $api -TenantId $tenant -OwnerOid $owner -Workspace code -Apply
   ```

   Success ends with `Desktop client created/verified:` and a GUID. Then keep
   that client id in the window:

   ```powershell
   $client = (az ad app list --display-name 'HCW Code Conductor Brain Obsidian' -o json | ConvertFrom-Json).appId
   ```

4. Add three Terraform variables at
   <https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables> with
   **+ Add variable**, category **Terraform variable**, **HCL** unticked and
   **Sensitive** unticked (they are identifiers, not secrets, and the public
   plan-check summary masks every GUID). Type `$owner`, `$tenant` and
   `$client` in the PowerShell window to see each value.

   | Key | Value | Description |
   | --- | --- | --- |
   | `code_brain_owner_oid` | the value of `$owner` | Owner of the Code Conductor brain (#1457) |
   | `code_brain_owner_tenant_id` | the value of `$tenant` | Owner's tenant for the Code Conductor brain (#1457) |
   | `code_brain_sync_client_id` | the value of `$client` | Code Conductor brain desktop client, code_brain_sync only (#1457) |

   Start a plan (**+ New run**, **Plan only** is fine first). The plan check
   reports these three settings as `UNEXPECTED` on purpose: identities are
   never pre-approved in the repository, so read the three values in the run's
   own plan and confirm they are yours. Then apply. The workspace is still off.
5. When the plugin can use this workspace
   ([#1467](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1467)
   is closed), add `code_brain_enabled` with value
   `true` the same way (description: `Switches the Code Conductor brain on
   (#1457)`), plan and apply. Terraform refuses this if the owner, tenant or
   client is missing, or if the client is the creator brain's. Then repeat
   part 1 step 7: an anonymous caller still gets `401`. Sign in from the
   plugin and save one synthetic note, and write down the time you saved it.
   Check it comes back on a second device or after a fresh pull, and that a
   stale edit becomes a conflict copy rather than overwriting.

## 4. Restore drill before real notes

Before real notes go in, prove a note comes back.

1. Wait for a daily export that started after you saved the synthetic note
   (the export runs at 03:00 UTC). A drill against an older export proves
   nothing about the note, because the note is not in it. Check that one has
   completed:

   ```powershell
   az monitor app-insights query --app appi-site-prod-cus-01 -g rg-web-site-prod-cus --offset 3d --analytics-query 'customEvents | where name == "cosmosExportCompleted" | project timestamp, mode = tostring(customDimensions.mode), runId = tostring(customDimensions.runId), containers = toint(customDimensions.containers), docs = tolong(customDimensions.docs) | order by timestamp desc' -o table
   ```

   Success is a row whose `runId` (the UTC date the run started, at 03:00 UTC)
   is after the time you saved the note, with `58` containers (`delta`) or `65`
   (`full`). Then confirm that run carried the note:

   ```powershell
   az monitor app-insights query --app appi-site-prod-cus-01 -g rg-web-site-prod-cus --offset 3d --analytics-query 'traces | where message startswith "[cosmosExport] code_brain_records" | project timestamp, message | order by timestamp desc' -o table
   ```

   Success is a line from that same run (the same date in its `delta/` or
   `full/` name) showing at least one document. `0 docs` there means the run
   began before the note was saved: wait for the next one.
2. Follow the [Cosmos restore](cosmos-restore.md) drill; its step 3 now
   creates `hcw_code_brain` in the scratch account, and the restore script
   writes `code_brain_records` back into it. Use `--as-of` with the `runId`
   from step 1 or later, or leave it out to take the newest complete export.
3. Check the synthetic note's body, version, revisions and links in the
   restored copy, record the run on
   [#1457](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1457),
   and tear the scratch account down as that runbook says.

## Switching off and rollback

- Remove `code_brain_enabled` (or set it to `false`) at
  <https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables> and apply.
  The routes return 404 again; nothing is deleted and the creator brain is not
  touched.
- To revoke the desktop client, either replace `code_brain_sync_client_id`
  with a new client's ID, or clear it **and** set `code_brain_enabled` to
  `false` in the same apply. While the workspace is switched on, Terraform
  refuses an empty client ID (the check in `infra/code-brain-variables.tf`),
  so clearing it on its own fails the plan and revokes nothing. Remove the old
  registration through the normal identity process when it is retired.
- The records stay in `hcw_code_brain` and in the export. Deleting the
  database takes a reviewed pull request that lifts `prevent_destroy` first.

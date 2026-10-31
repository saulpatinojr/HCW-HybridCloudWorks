# ADR 0036: The Code Conductor brain is a second private workspace with its own Cosmos database in the existing account, its own switches, owner, desktop client and `code_brain_sync` scope

**Status:** Accepted 2026-10-31 by the owner as architecture owner, on [#1465](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1465) (implemented disabled by default; activation is the owner's, in the [runbook](../runbooks/code-conductor-brain.md))
**Decision date:** 2026-10-31
**Owners:** Workload owner and architecture owner

Related: issue [#1457](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1457)
(the owner's request of 2026-10-28); the creator Second Brain's
[architecture record](../architecture/second-brain.md) and
[runbook](../runbooks/second-brain.md); [ADR 0028](0028-cosmos-out-of-account-export.md)
(the out-of-account export the new records join).

## Context

The creator Second Brain is a private notes workspace inside the site's admin
area. The owner syncs it with a desktop note app (Obsidian) through a plugin,
and the setup is proven in production: saves are versioned, a stale edit is
refused instead of overwriting, a repeated save is recognised and applied
once, and the plugin signs in with a token that only the sync routes accept.

The owner asked for the same setup for a second, separate workspace: engineering
notes for the Code Conductor work. Two things are fixed by the request. It has
to be a new database inside the existing Cosmos account (Cosmos is the
document database the site runs on), and it has to be fully separate from the
creator brain: no creator records, no creator articles and drafts, no shared
switches.

## Purpose and decision drivers

- **Isolation (security).** A token, setting or bug in one workspace must not
  read or write the other. The creator brain's behaviour must not change.
- **Reuse what is proven (reliability).** The save transaction, conflict and
  replay handling, paging and sync heartbeat already work; a copy would drift.
- **Recoverable before it holds anything (reliability).** The authored records
  must be in the daily and weekly out-of-account export before the workspace
  is switched on.
- **Nothing new to run or pay for (cost, operations).** On a serverless Cosmos
  account an empty database costs nothing; no new account, identity or
  network rule should be needed.

## Decision

1. **A new database, `hcw_code_brain`, in the existing account**, with one
   container, `code_brain_records`, partitioned on `/ownerId` (one logical
   partition per owner). Terraform creates both
   ([`infra/code-brain.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/code-brain.tf)),
   from one small file the code and the restore script also read
   ([`infra/cosmos-code-brain-containers.json`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/cosmos-code-brain-containers.json)).
   Both carry `prevent_destroy`, and a precondition refuses a plan that would
   name the creator's `hcw` database. There is no search container: this
   workspace has no index to rebuild.
2. **Its own switches and identities**, all empty or off by default:
   `code_brain_enabled`, `code_brain_owner_oid`, `code_brain_owner_tenant_id`
   and `code_brain_sync_client_id`, which become the app settings
   `CODE_BRAIN_ENABLED`, `CODE_BRAIN_OWNER_OID`, `CODE_BRAIN_OWNER_TENANT_ID`
   and `CODE_BRAIN_SYNC_CLIENT_ID`. Terraform sets
   `CODE_BRAIN_COSMOS_DATABASE` from the database resource. The code turns the
   workspace on only when every one of these is set, the database is not
   `COSMOS_DATABASE`, and the desktop client is not the creator brain's
   (`functions/src/lib/code-brain/config.js`); Terraform refuses the same two
   overlaps when `code_brain_enabled` is true.
3. **A sync-only API under `/api/cms/code-brain/`** in the existing Function
   App: `status`, `items` (list), `items/{id}`, `history/{id}`, `sync` (pull
   and push) and `sync-status`. Every route needs a token carrying the new
   delegated scope `code_brain_sync`, issued to the dedicated desktop client
   (checked through the token's `azp` claim), for the configured owner, who
   must also be an active editor or higher in the site's admin registry. An
   ordinary admin token (`access_as_admin`) and a creator sync token
   (`brain_sync`) both fail the scope check before anything is read. There are
   no creator reference, search, context, draft, AI or reindex routes here.
4. **Shared mechanics, separate wiring.** The save transaction and paging are
   the creator brain's own code, given the container name as a parameter
   (`createBrainRepository(..., { records, search })`); the response wrapper,
   save checks, list and history paging and the heartbeat moved into
   `functions/src/lib/brain/workspace.js` and both workspaces call them. The
   creator brain's defaults are unchanged, so its routes behave exactly as
   before; its whole test suite passes unchanged. The Code Conductor store
   (`functions/src/lib/code-brain/store.js`) reaches one container in one
   database, and refuses a read, query or write that does not name an owner
   partition.
5. **Backups and restores include it from the first apply.** The export
   classification lists `code_brain_records` as authored (weekly full plus
   daily deltas) and maps it to its database's app setting. The export plans
   the container whenever `CODE_BRAIN_COSMOS_DATABASE` is set, which Terraform
   does in the apply that creates the database, so the first daily export
   after that apply carries it, before anyone switches the workspace on. The
   restore script writes it back into its own database
   (`--code-brain-database`, default `hcw_code_brain`, refused if equal to
   `--database`).
6. **No new identity or role.** The Function App's existing Cosmos role
   assignment is the built-in Data Contributor at account scope, which already
   covers a new database in the account. A database-scope assignment for the
   same identity would grant nothing new, so none is added.

## Consequences and accepted risks

- The workspace is invisible until the owner switches it on. Until then every
  route answers 401, 403 or 404 and reads nothing.
- The desktop plugin in `obsidian-plugin/` still targets the creator routes
  and the `brain_sync` scope. Using it against this workspace needs a
  workspace setting in the plugin (routes and scope), which is a separate
  change
  ([#1467](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1467)); the API speaks the same sync protocol (version 1) so the plugin's
  engine is reusable as is. Until then the API can be exercised directly.
- The admin registry lookup (`admins` in the `hcw` database) is shared: it is
  the site's one list of who is an administrator, and the Code Conductor brain
  reads it, never writes it.
- **Accepted risk:** the Function App identity's account-scope role means the
  separation between the two databases is enforced in code and in
  configuration, not by Cosmos itself. Code that misused that identity could
  reach either database. This is the same position every container is in
  today.
  Narrowing it is
  [#1469](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1469).
- A switched-off or half-configured workspace refuses a valid token before
  the admin registry is read, so it costs no Cosmos read. Both workspaces'
  sync guards now write their refusals to `admin_audit_logs`, as the admin
  guard always has. For the creator brain this changes one edge case: while
  it is switched off, a signed-in caller with a valid `brain_sync` token gets
  404 where a caller missing the Admin role used to get 403.
- One more container in the export: a few cents a month at this size.
- The engineering notes' export copies sit in the same private `cosmos-export`
  blob container on `stsiteprodcus01` as the creator site's backups. That
  container is closed to the internet by the storage firewall. It is readable
  by the Function App's identity, which holds Storage Blob Data Contributor on
  the whole storage account (`azurerm_role_assignment.func_blob` in
  `infra/storage.tf`), and by an operator only while they hold the temporary
  Storage Blob Data Reader grant and firewall rule that the
  [restore drill](../runbooks/cosmos-restore.md) adds and then removes, plus
  anyone with owner-level access to the subscription.

## Alternatives considered

- **New containers in the creator's `hcw` database.** Rejected by the owner's
  request, and weaker: any code holding the creator client could name them.
- **A second Cosmos account.** Stronger separation (its own firewall, keys and
  backups), but a second serverless account to secure, monitor and pay for,
  a second private network rule, and a second restore drill target. Not
  needed for one owner's notes.
- **Narrow the Function App's Cosmos role to database scopes now.** Cosmos
  accepts role assignments scoped to `/dbs/<database>`
  ([Microsoft Learn: data plane role-based access](https://learn.microsoft.com/azure/cosmos-db/how-to-connect-role-based-access-control#grant-data-plane-role-based-access)),
  so the identity could hold one assignment per database. It would replace
  the assignment the whole site runs on, and a mistake there is a site-wide
  403, so it belongs in its own reviewed change, not in this one. Tracked in
  [#1469](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1469).
- **Reuse `brain_sync` and the creator's desktop client.** Rejected: one
  token would then open both workspaces.

## Validation and revisit triggers

- Unit tests (`functions/src/lib/code-brain/code-brain.test.js`) cover the
  disabled default, each missing or shared setting, wrong identity, tenant,
  scope and client, cross-workspace isolation, replay, conflicts, paging and
  the store's partition rule. The Terraform contract test
  (`infra/tests/guards.tftest.hcl`) checks the separate database, the
  `/ownerId` key and the off-by-default settings. The plan check
  (`scripts/assert-expected-plan.mjs`) declares exactly the new creates and
  settings.
- Before activation: a complete export manifest lists `code_brain_records`,
  and a restore drill brings a synthetic note back into an isolated
  `hcw_code_brain` (runbook).
- Revisit if a second identity needs Cosmos access, if either workspace needs
  a stronger boundary than code and configuration, or if the plugin gains a
  workspace setting (then record the client side here).

## Related decisions and references

- [ADR 0028](0028-cosmos-out-of-account-export.md), the export and restore.
- [Second Brain architecture](../architecture/second-brain.md).
- [Code Conductor brain runbook](../runbooks/code-conductor-brain.md).
- [Microsoft Learn: transactional batch operations](https://learn.microsoft.com/azure/cosmos-db/transactional-batch)
  (all operations in one batch share one partition key value).
- [Microsoft Learn: expose a web API and add a scope](https://learn.microsoft.com/entra/identity-platform/quickstart-configure-app-expose-web-apis#add-a-scope).

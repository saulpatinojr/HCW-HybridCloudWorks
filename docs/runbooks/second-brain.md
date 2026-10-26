# Enable and operate Second Brain

Second Brain is private and disabled by default. Its design and data boundaries
are in [the architecture record](../architecture/second-brain.md).

## Prepare the release

1. Run Functions and frontend lint/tests, frontend build and the
   `second-brain.spec.js` browser journey. Build/test `obsidian-plugin`.
2. Review the Terraform plan: it adds `brain_records` and `brain_search` with
   `/ownerId` partitioning, app settings, and the reconciliation timer's alert
   schedule. Existing content is not migrated or rewritten.
3. Deploy infrastructure and application through the usual delivery process
   with both `brain_enabled` and `brain_ai_enabled` false.

## Owner and desktop registration

Obtain the owner's existing Entra tenant and object ID through the signed-in
identity/admin registry. Do not use email as the access key or paste IDs into
this public repository. The owner must already be an active editor or higher
with the API's Admin role.

Set these Terraform inputs through the existing environment configuration:

| Input | Initial value |
| --- | --- |
| `brain_owner_oid` | The owner's Entra object ID |
| `brain_owner_tenant_id` | The existing API tenant |
| `brain_sync_client_id` | Dedicated desktop registration created below |
| `brain_enabled` | false until the sample pilot |
| `brain_ai_enabled` | false until Foundry readiness is checked |

Run `scripts/brain/configure-entra-sync.ps1` with `-ApiAppId`, `-TenantId`, and
`-OwnerOid`. Its default invocation is read-only and prints the intended
desktop manifest. After reviewing it, use `-Apply` through the normal approved
identity-change process. It preserves existing API scopes/roles/clients,
exposes only the new `brain_sync` delegated permission to this desktop client,
and refuses to repurpose a broader or credentialed registration. Record the
returned client ID as `brain_sync_client_id`.

Verify that the desktop client's required resource permissions contain only
the API's `brain_sync`, that it has no secrets, and that `access_as_admin` is
still required by existing admin routes. Record owner identity and the native
client registration in the environment's identity inventory.

## Pilot without touching the original vault

1. Enable `brain_enabled` for the configured owner. Confirm the owner sees the
   Second Brain menu, then verify a different admin and an unauthenticated
   request cannot read notes, search, graph, sync, or exports.
2. Capture synthetic sample notes and a topic/project. Save an explicit link,
   inspect backlinks and the graph, archive/restore, and save concurrently in
   two browser tabs. Confirm the second save preserves local text and returns
   a conflict instead of overwriting.
3. Press **Index creator content**. Watch its checkpoint/status on Home until
   complete. Check each source format, rename/update an article, and remove a
   sample source; search must never return removed text even before indexing
   catches up. The timer resumes an interrupted queued/running checkpoint.
4. In `obsidian-plugin`, run `npm ci --ignore-scripts`, `npm test`, and
   `npm run build`. Copy the contents of `dist` to
   `.obsidian/plugins/hcw-second-brain` in a separate test vault, then enable
   the plugin in Obsidian Community plugins. Keep the test vault out of Git.
5. Copy connection settings from Second Brain Home, sign in, and enroll only
   sample Markdown notes. Test an offline edit, a rename, concurrent edits,
   deletion/restore, and a local edit of an `HCW/Site` reference. Confirm
   recovery notes under `HCW/Conflicts` and that published content is unchanged.
6. Verify the plugin state and Markdown files contain no access/refresh token.
   The encrypted cache is under
   `%LOCALAPPDATA%/HybridCloudWorks/Obsidian/<client-id>/tokens.cache`.
   If Windows refuses the helper, keep sync disabled and investigate the
   signed-in user's policy; do not weaken policy or enable plaintext storage.
7. Check the `brainAssistant` task in AI Engine, its enabled Foundry model,
   and usage reporting. Set `brain_ai_enabled=true`. Ask a source-backed
   question and one absent from your corpus. Verify citations, the missing
   evidence state, and that answering alone creates no note/draft/publication.
8. Review an outline and create a draft twice with the same request. Verify
   one draft exists, starts in Drafts, and links back to its private provenance.
9. Restore a sample authored note and its revisions/relationships into an
   isolated environment using the existing Cosmos backup process. Rebuild the
   index there. Do not replay restored production notes into the live workspace.

## Enroll the real notes and retire private Publish

Back up the original vault. After the sample pilot passes, install the tested
plugin there and preview/select the notes to enroll. Never select the whole
vault implicitly. Existing personal notes stay in their chosen paths; notes
created in HCW download under `HCW/Notes`.

Confirm the hosted HCW workspace contains the intended notes and that only
the owner can read them. Then unpublish the private notes through Obsidian's
Publish interface, including checking the original Publish URL. A DNS change
alone does not unpublish upstream copies. Verify both the custom hostname and
original Publish address no longer serve those notes. Keep the local vault.
Subscription cancellation is a separate account action.

## Operations and rollback

- Home reports indexing status and the last reported completed plugin cycle, pending changes, and conflicts. The plugin
  reports local pending operations, the last completed cycle, and local errors.
  A failed/offline plugin cannot report fresh status to the server, so the
  hosted timestamp is not a proof that every local change has uploaded.
- Reindexing resumes a checkpoint; a completed run can be started again. The
  15-minute timer reconciles content changes without any AI call.
- On an AI failure, use notes/search normally. Answers send bounded excerpts
  to Foundry only and retain no automatic conversation history.
- Set `brain_ai_enabled=false` to stop AI alone. Set `brain_enabled=false` to
  deny the brain APIs and stop index/sync processing. Disabling the feature
  does not delete Cosmos data or local notes and does not alter site articles.
- To revoke one desktop client, clear/change `brain_sync_client_id`. Revoke the
  Entra registration/permission through the identity process when retiring it.
- Sign out in the plugin to clear its cached account tokens. Uninstalling the
  plugin leaves enrolled notes intact. Keep authored backups; the search index
  is disposable and safe to rebuild.

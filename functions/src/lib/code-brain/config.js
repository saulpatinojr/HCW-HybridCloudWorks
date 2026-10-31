/**
 * The Code Conductor brain's configuration (#1457, ADR 0036).
 *
 * A second private workspace for engineering notes, kept apart from the
 * creator Second Brain in every way that can be configured: its own Cosmos
 * database in the same account, its own records container, its own on/off
 * switch, owner, desktop client and delegated scope. Nothing here reads a
 * BRAIN_* setting except to refuse a configuration that would let the two
 * workspaces share a client or a database.
 *
 * It is off unless every one of these holds, and off is the default:
 *
 *   CODE_BRAIN_ENABLED          exactly "true"
 *   CODE_BRAIN_OWNER_OID        the owner's Entra object id
 *   CODE_BRAIN_OWNER_TENANT_ID  the owner's tenant id
 *   CODE_BRAIN_SYNC_CLIENT_ID   the dedicated desktop client, and not the
 *                               creator brain's BRAIN_SYNC_CLIENT_ID
 *   CODE_BRAIN_COSMOS_DATABASE  the workspace's database, and not
 *                               COSMOS_DATABASE (default "hcw") in any
 *                               spelling
 *
 * The names below must match infra/cosmos-code-brain-containers.json, the
 * file Terraform creates the database from. The Functions package does not
 * ship infra/, so code-brain.test.js holds the two equal instead.
 */
import { isCreatorDatabase } from '../cosmos-client.js';

export const CODE_RECORDS = 'code_brain_records';
export const CODE_SYNC_SCOPE = 'code_brain_sync';
export const CODE_BRAIN_UNAVAILABLE =
  'The Code Conductor brain is unavailable for this account.';

/** The one container this workspace stores, and its partition key. */
export const CODE_BRAIN_PARTITION_KEY_PATHS = Object.freeze({
  [CODE_RECORDS]: '/ownerId',
});

const same = (a, b) =>
  Boolean(a && b) && String(a).toLowerCase() === String(b).toLowerCase();

/**
 * Read the workspace's settings. `enabled` is true only when every setting
 * is present and none is shared with the creator workspace.
 *
 * @param {Record<string, string|undefined>} [env]
 */
export function codeBrainConfig(env = process.env) {
  const database = String(env.CODE_BRAIN_COSMOS_DATABASE || '').trim();
  const ownerOid = env.CODE_BRAIN_OWNER_OID || '';
  const ownerTenantId = env.CODE_BRAIN_OWNER_TENANT_ID || '';
  const syncClientId = env.CODE_BRAIN_SYNC_CLIENT_ID || '';
  // Trimmed and case-insensitive, so "HCW" cannot pass for a new database.
  const separateDatabase = Boolean(database) && !isCreatorDatabase(database, env);
  const separateClient =
    Boolean(syncClientId) && !same(syncClientId, env.BRAIN_SYNC_CLIENT_ID);
  return {
    enabled:
      env.CODE_BRAIN_ENABLED === 'true' &&
      Boolean(ownerOid && ownerTenantId) &&
      separateDatabase &&
      separateClient,
    ownerOid,
    ownerTenantId,
    syncClientId,
    database: separateDatabase ? database : '',
    unavailable: CODE_BRAIN_UNAVAILABLE,
  };
}

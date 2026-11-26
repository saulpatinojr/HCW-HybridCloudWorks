/**
 * agent-content/agent-switches.js — the switches that are on for one agent
 * key, read from that key's own record. Every check that asks "may this
 * agent key see that?" outside the key guards (the Pipeline's origin
 * references, the kept reminder rows) reads them here, so no key's answer
 * can come from another key's record.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { agentKeyById, enabledCapabilities } from './keys.js';

/**
 * The switches on one agent key's record, or none at all when no id is
 * given, the id is not an agent key, or the record cannot be found: a missing record fails closed here (review of #1891), rather than
 * taking the defaults an older record is read with. A document whose own id
 * is not that key's record id is no record of it.
 *
 * @param {{ readDoc: Function }} store
 * @param {string} agentId
 * @returns {Promise<string[]>} capability ids
 */
export async function agentSwitchesOn(store, agentId) {
  const key = agentKeyById(agentId);
  if (!key) return [];
  const record = await store.readDoc('admin_config', key.recordId, ADMIN_CONFIG_PARTITION);
  if (!record) return [];
  if (typeof record.id === 'string' && record.id !== key.recordId) return [];
  return enabledCapabilities(record);
}

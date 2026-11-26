/**
 * agent-content/agent-keys.js — the list of agent keys the site can hold.
 *
 * The site can hold more than one agent key. Each one is a row here and has
 * its own key record (one `admin_config` document holding a hash of the key,
 * never the key), its own capability switches, its own tab on the AI Engine
 * page, its own per-minute limit and its own audit rows. A key is matched to
 * its row by the hash it presents (guard.js), and everything that asks "may
 * this key see that?" reads that key's own record, never another's.
 *
 *   id                  the agent id: what `user.agent` carries, what audit
 *                       rows name, and the `?agent=` value of the admin route
 *   displayName         what the tab and the messages call it
 *   recordId            its key record in `admin_config`
 *   switchesOnWhenMade  the list of capability ids a new key starts with
 *                       on. It is also what a switch the record never stored
 *                       (a capability added after the key was made) reads
 *                       as, so a capability added later is off for every key
 *                       until its row lists it or the owner turns it on.
 *                       Koda's row lists the nine capabilities that existed
 *                       before the Cloudflare switches, which were all on for
 *                       it, so nothing Koda could do changes; the Cloudflare
 *                       switches start off for Koda (#1905). Claude
 *                       Publisher's key creates drafts, so only reading and
 *                       writing drafts start on. Claude Network Guy's key
 *                       starts with only reading Cloudflare on.
 *
 * It imports nothing, so the browser's mirror test can read it
 * (frontend/src/components/admin/ai-engine/agentKeys.test.js), the way
 * page-links/origin-pages.js is read.
 *
 * ADDING A KEY. One row here, its tab entry in the browser's mirror
 * (agentKeys.js beside the AI Engine tabs), and a literal record id in the
 * backup's leave-out list (backup/archive-classification-admin.js). The
 * credential register and the Integrations card build their rows from this
 * list. docs/runbooks/agent-content-api.md, part 8, has the rest.
 */

export const AGENT_KEYS = Object.freeze(
  [
    {
      // Every capability that existed when the Cloudflare switches were added
      // (#1905). Until then this was `true` (every switch on), which would
      // have opened the Cloudflare switches for Koda's stored record too,
      // because a switch a record never stored reads as its row's default.
      id: 'koda',
      displayName: 'Koda',
      recordId: 'agent_content_key:koda',
      switchesOnWhenMade: Object.freeze([
        'drafts.read',
        'drafts.write',
        'drafts.review',
        'published.read',
        'admin.pipeline',
        'admin.enhanced',
        'admin.brain',
        'admin.spotlight',
        'admin.platform',
      ]),
    },
    {
      // A draft creator: it reads, writes and edits drafts through the agent
      // API, and starts with nothing else on. Sending to review, the admin
      // sections and the published reads stay off until the owner turns them on.
      // Shown as "Claude Publisher" since #1905; the id stays `claude`, so its
      // key record, its audit rows and the drafts it wrote keep their names.
      id: 'claude',
      displayName: 'Claude Publisher',
      recordId: 'agent_content_key:claude',
      switchesOnWhenMade: Object.freeze(['drafts.read', 'drafts.write']),
    },
    {
      // Administers the site's Cloudflare zone through the Cloudflare admin
      // routes (cloudflare/, #1905). It starts able to read only; each kind of
      // change (zone settings and cache, DNS records, rules) is its own switch
      // the owner turns on. It never deletes, like every agent key.
      id: 'claude-network',
      displayName: 'Claude Network Guy',
      recordId: 'agent_content_key:claude-network',
      switchesOnWhenMade: Object.freeze(['admin.cloudflare']),
    },
  ].map(Object.freeze),
);

export const AGENT_KEY_IDS = Object.freeze(AGENT_KEYS.map((entry) => entry.id));

/** The first key, which every older caller means when it names none. */
export const DEFAULT_AGENT_KEY = AGENT_KEYS[0];

/** The row for an agent id, or null. Own values only: `constructor` finds nothing. */
export function agentKeyById(id) {
  return AGENT_KEYS.find((entry) => entry.id === id) || null;
}

/** The row whose key record this is, or null. */
export function agentKeyByRecordId(recordId) {
  return AGENT_KEYS.find((entry) => entry.recordId === recordId) || null;
}

/**
 * Whether a caller is an agent key rather than a person: the key guards put
 * the key's agent id on the user they make, and nothing else sets it.
 */
export function isAgentUser(user) {
  return typeof user?.agent === 'string' && user.agent.length > 0;
}

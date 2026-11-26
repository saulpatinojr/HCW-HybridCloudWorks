/**
 * The agent keys the site can hold, as the Agents page shows them: one tab
 * per key, each drawn by the same component (KodaTab.jsx) over that key's
 * own record, switches and audit trail on the server. The tabs lived on the
 * AI Engine page until #1905; its old `?tab=` links now redirect to the
 * Agents page (components/admin/agents/tabs.js).
 *
 * The browser's mirror of functions/src/lib/agent-content/agent-keys.js:
 * agentKeys.test.js fails when the two lists differ. A key's `id` is both
 * its agent id and its Agents tab id.
 *
 * `switchesOnWhenMade` is the server's: the capability ids a new key starts
 * with on (and what a switch its record never stored reads as). Koda's lists
 * the nine capabilities that existed before the Cloudflare switches.
 *
 * The rest is the browser's own words:
 *   job          what the key is for, in one sentence, on the Agents page's
 *                Overview table
 *   description  the tab's opening sentence, for a key other than Koda's
 *                (Koda's tab keeps its own sentences)
 *   secureField  where the owner pastes the key, for a key other than Koda's
 */
export const AGENT_KEY_TABS = Object.freeze(
  [
    {
      id: 'koda',
      displayName: 'Koda',
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
      job: 'The content agent, run by the Muse service: it drafts and reviews posts and reads the admin sections its switches open.',
    },
    {
      id: 'claude',
      displayName: 'Claude Publisher',
      switchesOnWhenMade: Object.freeze(['drafts.read', 'drafts.write']),
      job: 'A draft creator: it writes and edits drafts on the Drafts page, and a person publishes them.',
      description:
        'Claude Publisher is a draft creator. It writes and edits drafts on the Drafts page through the key below. It cannot publish, schedule or delete, and it reaches nothing more unless you turn on another switch.',
      secureField: 'the secure field Claude Publisher asks for',
    },
    {
      id: 'claude-network',
      displayName: 'Claude Network Guy',
      switchesOnWhenMade: Object.freeze(['admin.cloudflare']),
      job: 'Looks after the site’s Cloudflare zone: it reads the settings, DNS records, rules and cache, and changes only what its switches allow.',
      description:
        'Claude Network Guy looks after the site’s Cloudflare zone through the key below, using the same routes as the Cloudflare page. A new key can only read; changing zone settings and the cache, DNS records, or rules is a separate switch each. It can never delete a DNS record, and the records and rules that keep the site running are locked against it.',
      secureField: 'the secure field Claude Network Guy asks for',
    },
  ].map(Object.freeze)
);

/** Koda's, the first key, which every older caller means. */
export const [KODA_KEY_TAB] = AGENT_KEY_TABS;

/** The tab entry for an agent id, or null. */
export function agentKeyTab(id) {
  return AGENT_KEY_TABS.find((entry) => entry.id === id) || null;
}

/**
 * The agent keys the site can hold, as the AI Engine shows them: one tab per
 * key, each drawn by the same component (KodaTab.jsx) over that key's own
 * record, switches and audit trail on the server.
 *
 * The browser's mirror of functions/src/lib/agent-content/agent-keys.js:
 * agentKeys.test.js fails when the two lists differ. A key's `id` is both
 * its agent id and its AI Engine tab id (tabs.js).
 *
 * `switchesOnWhenMade` is the server's: `true` (Koda's key starts with every
 * switch on) or the capability ids a new key starts with (Claude's: reading
 * and writing drafts). `description` and `secureField` are the tab's own
 * words for a key other than Koda's, whose tab keeps its own sentences.
 */
export const AGENT_KEY_TABS = Object.freeze(
  [
    { id: 'koda', displayName: 'Koda', switchesOnWhenMade: true },
    {
      id: 'claude',
      displayName: 'Claude',
      switchesOnWhenMade: Object.freeze(['drafts.read', 'drafts.write']),
      description:
        'Claude is a draft creator. It writes and edits drafts on the Drafts page through the key below. It cannot publish, schedule or delete, and it reaches nothing more unless you turn on another switch.',
      secureField: 'the secure field Claude asks for',
    },
  ].map(Object.freeze)
);

/** Koda's, the first key, which every older caller means. */
export const [KODA_KEY_TAB] = AGENT_KEY_TABS;

/** The tab entry for an agent id, or null. */
export function agentKeyTab(id) {
  return AGENT_KEY_TABS.find((entry) => entry.id === id) || null;
}

/**
 * The browser's list of agent keys (agentKeys.js) is the server's
 * (functions/src/lib/agent-content/agent-keys.js), and each key has its
 * own tab on the Agents page.
 */
import { describe, it, expect } from 'vitest';
import { AGENT_KEYS } from '../../../../../functions/src/lib/agent-content/agent-keys.js';
import { AGENT_KEY_TABS, KODA_KEY_TAB, agentKeyTab } from './agentKeys';
import { TABS, resolveTab } from '../agents/tabs';

describe('the agent key tabs', () => {
  it('mirror the server’s list of agent keys, in its order', () => {
    expect(
      AGENT_KEY_TABS.map(({ id, displayName, switchesOnWhenMade }) => ({
        id,
        displayName,
        switchesOnWhenMade,
      }))
    ).toEqual(
      AGENT_KEYS.map(({ id, displayName, switchesOnWhenMade }) => ({
        id,
        displayName,
        switchesOnWhenMade,
      }))
    );
    expect(KODA_KEY_TAB.id).toBe('koda');
  });

  it('give every key its own Agents tab, named after it', () => {
    for (const key of AGENT_KEY_TABS) {
      expect(TABS.find((tab) => tab.id === key.id)?.label, key.id).toBe(key.displayName);
      expect(resolveTab(key.id)).toBe(key.id);
    }
  });

  it('say every key’s job in one sentence for the Overview', () => {
    for (const key of AGENT_KEY_TABS) {
      expect(key.job, key.id).toMatch(/^\S.{30,}\.$/);
    }
  });

  it('describe every key but Koda’s in its own words, with where its key is pasted', () => {
    for (const key of AGENT_KEY_TABS.slice(1)) {
      expect(key.description, key.id).toMatch(/\w.{40,}/);
      expect(key.secureField, key.id).toMatch(/secure field/);
    }
    expect(agentKeyTab('claude').description).toMatch(/draft creator/);
    expect(agentKeyTab('claude').description).toMatch(/cannot publish, schedule or delete/);
    expect(agentKeyTab('claude-network').description).toMatch(/Cloudflare/);
    expect(agentKeyTab('claude-network').description).toMatch(/never delete/);
  });

  it('find a key by id and nothing else', () => {
    expect(agentKeyTab('claude')?.displayName).toBe('Claude Publisher');
    expect(agentKeyTab('claude-network')?.displayName).toBe('Claude Network Guy');
    expect(agentKeyTab('constructor')).toBeNull();
    expect(agentKeyTab(undefined)).toBeNull();
  });
});

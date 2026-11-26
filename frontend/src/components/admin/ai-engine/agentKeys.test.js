/**
 * The browser's list of agent keys (agentKeys.js) is the server's
 * (functions/src/lib/agent-content/agent-keys.js), and each key has its
 * own AI Engine tab.
 */
import { describe, it, expect } from 'vitest';
import { AGENT_KEYS } from '../../../../../functions/src/lib/agent-content/agent-keys.js';
import { AGENT_KEY_TABS, KODA_KEY_TAB, agentKeyTab } from './agentKeys';
import { TABS, resolveTab } from './tabs';

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

  it('give every key its own AI Engine tab, named after it', () => {
    for (const key of AGENT_KEY_TABS) {
      expect(TABS.find((tab) => tab.id === key.id)?.label, key.id).toBe(key.displayName);
      expect(resolveTab(key.id)).toBe(key.id);
    }
  });

  it('describe every key but Koda’s in its own words, with where its key is pasted', () => {
    for (const key of AGENT_KEY_TABS.slice(1)) {
      expect(key.description, key.id).toMatch(/\w.{40,}/);
      expect(key.secureField, key.id).toMatch(/secure field/);
    }
    expect(agentKeyTab('claude').description).toMatch(/draft creator/);
    expect(agentKeyTab('claude').description).toMatch(/cannot publish, schedule or delete/);
  });

  it('find a key by id and nothing else', () => {
    expect(agentKeyTab('claude')?.displayName).toBe('Claude');
    expect(agentKeyTab('constructor')).toBeNull();
    expect(agentKeyTab(undefined)).toBeNull();
  });
});

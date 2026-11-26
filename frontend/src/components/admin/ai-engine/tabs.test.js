/**
 * The AI Engine's tab resolver — the shared contract (tabContract.js) plus
 * the addresses that matter here: the retired Site Services placeholder
 * lands on the Tasks tab (id `routing`, which it kept from ADR 0033 so every
 * written-down link still opens it), and `tasks` is its alias. The agent key
 * tabs moved to the Agents page (#1905), and their old addresses redirect.
 */
import { describe, expect, it } from 'vitest';
import * as tabs from './tabs';
import { describeTabResolver } from '../tabContract';
import { AGENT_KEY_TABS } from './agentKeys';

describeTabResolver(tabs, {
  route: '/admin/ai-engine',
  redirects: {
    siteservices: 'routing',
    'site-services': 'routing',
    tasks: 'routing',
    features: 'services',
    priority: 'services',
    cost: 'usage',
    servers: 'mcp',
    developer: 'developer-api',
    'organizer-keys': 'developer-api',
  },
});

describe('the agent key tabs moved to the Agents page', () => {
  it('no longer offers a tab for any agent key here', () => {
    for (const agent of AGENT_KEY_TABS) {
      expect(tabs.TABS.map((tab) => tab.id)).not.toContain(agent.id);
    }
  });

  it('sends every old agent key address to the matching Agents tab', () => {
    expect(tabs.agentsPageRedirect('koda')).toBe('/admin/agents?tab=koda');
    expect(tabs.agentsPageRedirect('claude')).toBe('/admin/agents?tab=claude');
    expect(tabs.agentsPageRedirect('claude-network')).toBe('/admin/agents?tab=claude-network');
    for (const old of ['agent', 'muse', 'agent-content']) {
      expect(tabs.agentsPageRedirect(old), old).toBe('/admin/agents?tab=koda');
    }
    expect(tabs.agentsPageRedirect('agents')).toBe('/admin/agents?tab=overview');
  });

  it('leaves the AI Engine’s own tabs, unknown ids and prototype names alone', () => {
    for (const id of ['services', 'mcp', 'nope', '', null, undefined, 'constructor', '__proto__']) {
      expect(tabs.agentsPageRedirect(id), String(id)).toBeNull();
    }
  });
});

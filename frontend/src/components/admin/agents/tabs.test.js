/**
 * The Agents page's tab resolver (#1905): the shared contract, one tab per
 * agent key after the Overview, and the route read from the nav registry.
 */
import { describe, expect, it } from 'vitest';
import * as tabs from './tabs';
import { describeTabResolver } from '../tabContract';
import { AGENT_KEY_TABS } from '../ai-engine/agentKeys';
import { navItemById } from '@/config/adminNav';

describeTabResolver(tabs, {
  route: '/admin/agents',
  redirects: {
    agent: 'koda',
    muse: 'koda',
    'agent-content': 'koda',
    publisher: 'claude',
    network: 'claude-network',
  },
});

describe('the Agents tabs', () => {
  it('open with the Overview, then one tab per agent key, named after it, in the key list’s order', () => {
    expect(tabs.TABS[0]).toEqual({ id: 'overview', label: 'Overview' });
    expect(tabs.TABS.slice(1)).toEqual(
      AGENT_KEY_TABS.map((agent) => ({ id: agent.id, label: agent.displayName }))
    );
  });

  it('take the page’s route from the nav registry', () => {
    expect(tabs.AGENTS_PATH).toBe(navItemById('agents').to);
    expect(tabs.agentKeyTabHref('claude-network')).toBe('/admin/agents?tab=claude-network');
  });
});

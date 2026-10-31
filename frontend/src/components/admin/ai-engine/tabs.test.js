/**
 * The AI Engine's tab resolver — the shared contract (tabContract.js) plus
 * the addresses that matter here: the retired Site Services placeholder
 * lands on the Tasks tab (id `routing`, which it kept from ADR 0033 so every
 * written-down link still opens it), and `tasks` is its alias.
 */
import * as tabs from './tabs';
import { describeTabResolver } from '../tabContract';

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
    agent: 'koda',
    muse: 'koda',
  },
});

/**
 * The tab resolver, which is the only thing standing between a `?tab=` value
 * and the page picking a panel out of an object.
 *
 * The assertions are the shared contract (../tabContract.js). What is specific
 * to Linkie is the route and the two old ids: `connection` was the third tab's
 * name before the Newsletter Hub standard moved the connection test onto
 * Settings, and `stats` was an alias for the analytics view.
 */
import * as tabs from './tabs';
import { describeTabResolver } from '../tabContract';

describeTabResolver(tabs, {
  route: '/admin/linkie-hub',
  redirects: { connection: 'settings', stats: 'analytics' },
});

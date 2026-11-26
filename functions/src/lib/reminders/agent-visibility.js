/**
 * Which kept reminder rows an agent key may not see (#1886). A provider's
 * rows name records on the Page they come from (an Ambassador row names a
 * program and its dates), so they are shown to a key only while its own
 * switch for that Page is on (each key's switches are on its own record), the same rule the Pipeline uses for `originRef`
 * (page-links/origin-ref.js). A person is not asked: the route's own role
 * check covers them. A missing key record, or an agent id that is not on the
 * list of keys, fails closed (every provider row hidden).
 */
import { isAgentUser } from '../agent-content/keys.js';
import { agentSwitchesOn } from '../agent-content/agent-switches.js';
import { PROVIDED_ROWS } from './settings.js';
import { REMINDER_SOURCE_PREFIX } from '../timers/reminders.js';

/** The id prefixes of the rows this caller may not see; none for a person. */
export async function hiddenReminderPrefixes(store, user) {
  if (!isAgentUser(user)) return [];
  const on = await agentSwitchesOn(store, user.agent);
  return PROVIDED_ROWS.filter(({ agentSection }) => !on.includes(agentSection)).map(({ prefix }) => prefix);
}

/** Whether a row id starts with one of `prefixes`. */
export const isHiddenReminderId = (id, prefixes) =>
  prefixes.length > 0 && typeof id === 'string' && prefixes.some((prefix) => id.startsWith(prefix));

/** An alert-log entry sent for a hidden row (its source is `reminder:<row id>`). */
export const isHiddenReminderAlert = (alert, prefixes) =>
  typeof alert?.source === 'string' &&
  alert.source.startsWith(REMINDER_SOURCE_PREFIX) &&
  isHiddenReminderId(alert.source.slice(REMINDER_SOURCE_PREFIX.length), prefixes);

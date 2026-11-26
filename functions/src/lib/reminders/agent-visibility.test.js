/**
 * The agent key does not see kept reminder rows (or the alerts sent for
 * them) from a Page whose switch is off on it; a person sees them all
 * (#1886). The same rule as `originRef` in the Pipeline.
 */
import { describe, it, expect, vi } from 'vitest';
import { AGENT_USER, KEY_RECORD_ID } from '../agent-content/keys.js';
import { hiddenReminderPrefixes, isHiddenReminderAlert, isHiddenReminderId } from './agent-visibility.js';

const keyWith = (capabilities) => ({
  readDoc: vi.fn(async () => (capabilities ? { id: KEY_RECORD_ID, capabilities } : null)),
});

describe('hiddenReminderPrefixes', () => {
  it('hides a provider whose switch is off from the agent key only', async () => {
    const off = keyWith({ 'admin.spotlight': false, 'admin.platform': true });
    expect(await hiddenReminderPrefixes(off, AGENT_USER)).toEqual(['ambassador-']);
    expect(await hiddenReminderPrefixes(off, { oid: 'person' })).toEqual([]);
    expect(off.readDoc).toHaveBeenCalledTimes(1);
    const on = keyWith({ 'admin.spotlight': true, 'admin.platform': true });
    expect(await hiddenReminderPrefixes(on, AGENT_USER)).toEqual([]);
  });

  it('hides every provider when the key record is missing', async () => {
    expect((await hiddenReminderPrefixes(keyWith(null), AGENT_USER)).sort()).toEqual(['ambassador-', 'credential-']);
  });
});

describe('isHiddenReminderId and isHiddenReminderAlert', () => {
  const hidden = ['ambassador-'];
  it('match a row id and the alert sent for it, and nothing else', () => {
    expect(isHiddenReminderId('ambassador-0123456789ab', hidden)).toBe(true);
    expect(isHiddenReminderId('my-own-row', hidden)).toBe(false);
    expect(isHiddenReminderId('ambassador-0123456789ab', [])).toBe(false);
    expect(isHiddenReminderAlert({ source: 'reminder:ambassador-0123456789ab' }, hidden)).toBe(true);
    expect(isHiddenReminderAlert({ source: 'reminder:my-own-row' }, hidden)).toBe(false);
    expect(isHiddenReminderAlert({ source: 'ambassador-0123456789ab' }, hidden)).toBe(false);
  });
});

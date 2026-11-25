/**
 * The rows other parts of the platform keep on the reminders sheet are listed
 * twice: on the server, which keeps them whatever a save sends
 * (functions/src/lib/reminders/settings.js PROVIDED_ROWS), and here, where the
 * tab shows them read-only. A provider added to one and not the other would
 * be editable here and silently undone there (#1886).
 */
import { describe, it, expect } from 'vitest';
import { PROVIDED_ROWS } from '../../../../../functions/src/lib/reminders/settings.js';
import { ROW_KEEPERS, isRegisterRow, keeperOf } from './RemindersTab';

describe('the kept rows on the reminders sheet', () => {
  it('are the same prefixes on the server and here', () => {
    expect(ROW_KEEPERS.map((k) => k.prefix).sort()).toEqual(
      PROVIDED_ROWS.map((p) => p.prefix).sort()
    );
  });

  it('name who keeps each row, and leave the owner’s own rows editable', () => {
    expect(keeperOf({ id: 'credential-kv-anthropic-api-key' }).label).toBe(
      'Integrations → Credentials'
    );
    expect(keeperOf({ id: 'ambassador-0123456789ab' }).label).toBe('Ambassador');
    expect(isRegisterRow({ id: 'my-own-row' })).toBe(false);
    expect(isRegisterRow({})).toBe(false);
  });
});

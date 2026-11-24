import { describe, expect, it } from 'vitest';
import { jsonForLog, STORED_ID_NAME } from './log-json.js';

describe('jsonForLog', () => {
  it('leaves out every field named like a stored id, at any depth', () => {
    const summary = {
      id: 'a1',
      attempted: 2,
      failures: [{ contentId: 'c-9', error: 'HTTP_503' }],
      nested: { jobId: 'j-1', refusedIds: ['x'], oid: 'person', ok: true },
    };
    expect(jsonForLog(summary)).toBe('{"attempted":2,"failures":[{"error":"HTTP_503"}],"nested":{"ok":true}}');
    expect(jsonForLog([{ id: 'a', mirrored: 'skipped' }])).toBe('[{"mirrored":"skipped"}]');
  });

  it('keeps the run reference numbers, and a field the caller names', () => {
    expect(jsonForLog({ invocationId: 'i', correlationId: 'c', runId: '2026-01-01' })).toBe(
      '{"invocationId":"i","correlationId":"c"}'
    );
    expect(jsonForLog({ runId: '2026-01-01', docId: 'd' }, { keep: ['runId'] })).toBe('{"runId":"2026-01-01"}');
  });

  it('answers as JSON.stringify does for a value with no ids, and for nothing', () => {
    expect(jsonForLog({ processed: 3, skipped: 'gone' })).toBe('{"processed":3,"skipped":"gone"}');
    expect(jsonForLog(undefined)).toBeUndefined();
    expect(jsonForLog('plain')).toBe('"plain"');
  });

  it('names what an id is by its name only', () => {
    for (const name of ['id', 'ids', '_id', 'oid', 'sub', 'uid', 'contentId', 'jobIds', 'tenantID']) {
      expect(STORED_ID_NAME.test(name), name).toBe(true);
    }
    for (const name of ['valid', 'paid', 'width', 'idle', 'kind', 'subject', 'identity']) {
      expect(STORED_ID_NAME.test(name), name).toBe(false);
    }
  });
});

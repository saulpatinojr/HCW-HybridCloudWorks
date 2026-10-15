import { describe, it, expect, vi } from 'vitest';
import {
  AuthoredError,
  authoredDetails,
  authoredMessage,
  errorCode,
  errorResponse,
  failureFields,
  getCorrelationId,
  isAuthoredError,
  logFailure,
} from './error-response.js';

describe('errorResponse (AP-B10)', () => {
  it('extracts invocationId as correlation ID and logs content-free, leaking nothing', () => {
    const context = {
      invocationId: 'inv-12345',
      error: vi.fn(),
    };
    const internalErr = new Error('Database password failed at localhost:5432');
    internalErr.stack = 'Error: Database password failed\n    at internal/secret.js:10:15';

    const res = errorResponse(context, 'Internal Server Error', internalErr, 500);

    expect(res.status).toBe(500);
    expect(res.headers['Content-Type']).toBe('application/json');
    expect(res.headers['X-Correlation-ID']).toBe('inv-12345');

    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({
      ok: false,
      error: 'Internal Server Error',
      correlationId: 'inv-12345',
    });
    // Crucial: no stack or internal error message in response body
    expect(res.body).not.toContain('localhost:5432');
    expect(res.body).not.toContain('internal/secret.js');

    // The log keeps the correlation id and the error's code, never its
    // message or stack: telemetry is content-free (#945).
    expect(context.error).toHaveBeenCalledWith('[inv-12345] Internal Server Error (Error)');
    expect(JSON.stringify(context.error.mock.calls)).not.toContain('localhost');
  });

  it('answers with the safe sentence even for an authored error', () => {
    const res = errorResponse({ warn: vi.fn() }, 'Failed to save', new AuthoredError('title is required'));
    expect(JSON.parse(res.body).error).toBe('Failed to save');
  });

  it('extracts correlation id from traceparent header if invocationId is missing', () => {
    const context = {
      traceContext: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      error: vi.fn(),
    };
    const res = errorResponse(context, 'Failed to save', new Error('err'));
    expect(JSON.parse(res.body).correlationId).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
    );
  });

  it('generates a uuid when context has no invocationId or traceContext', () => {
    const res = errorResponse({}, 'Failed', null, 500);
    const parsed = JSON.parse(res.body);
    expect(parsed.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  describe('getCorrelationId helper', () => {
    it('returns invocationId when present', () => {
      expect(getCorrelationId({ invocationId: 'custom-inv' })).toBe('custom-inv');
    });

    it('returns traceparent when invocationId is missing', () => {
      expect(getCorrelationId({ traceContext: { traceparent: 'tp-abc' } })).toBe('tp-abc');
    });

    it('generates uuid when context is empty or undefined', () => {
      expect(getCorrelationId(null)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });
});

describe('the door: authored text passes, anything else is replaced (#945)', () => {
  class FieldRefusal extends AuthoredError {}

  it('passes an AuthoredError and its subclasses, with their code and status', () => {
    const refusal = new FieldRefusal('title is required', { code: 'BAD_INPUT', status: 400 });
    expect(isAuthoredError(refusal)).toBe(true);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.name).toBe('FieldRefusal');
    expect(refusal).toMatchObject({ code: 'BAD_INPUT', status: 400 });
    expect(authoredMessage(refusal, 'fallback')).toBe('title is required');
  });

  it.each([
    ['a Cosmos error', Object.assign(new Error('Entity with the specified id does not exist. ActivityId: 9f'), { code: 404 })],
    ['a provider error', Object.assign(new Error('429 Rate limit reached for org-abc'), { status: 429 })],
    ['a socket error', Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })],
    ['a string', 'boom'],
    ['an error dressed as authored', { message: 'raw', name: 'AuthoredError' }],
    ['nothing', undefined],
  ])('replaces %s with the safe sentence', (_, error) => {
    expect(isAuthoredError(error)).toBe(false);
    expect(authoredMessage(error, 'The save failed.')).toBe('The save failed.');
  });

  it('replaces an authored error whose message is blank', () => {
    expect(authoredMessage(new AuthoredError('  '), 'The save failed.')).toBe('The save failed.');
  });

  it('carries details only for an authored error', () => {
    expect(authoredDetails(Object.assign(new AuthoredError('x'), { details: { id: 1 } }))).toEqual({ id: 1 });
    expect(authoredDetails(Object.assign(new Error('x'), { details: { secret: 1 } }))).toBeUndefined();
  });

  it('keeps a cause for the log without exposing it', () => {
    const cause = new Error('inner');
    expect(new AuthoredError('outer', { cause }).cause).toBe(cause);
    expect(new AuthoredError('outer').cause).toBeUndefined();
  });
});

describe('errorCode: a content-free name for a log line', () => {
  it.each([
    [{ code: 'ECONNRESET' }, 'ECONNRESET'],
    [{ code: 409 }, '409'],
    [{ status: 503 }, 'HTTP_503'],
    [{ statusCode: 404 }, 'HTTP_404'],
    [new TypeError('x'), 'TypeError'],
    [{ code: 'a sentence with spaces', name: 'Error' }, 'Error'],
    [{ code: 'x'.repeat(65) }, 'UNKNOWN'],
    [null, 'UNKNOWN'],
  ])('%j → %s', (error, code) => {
    expect(errorCode(error)).toBe(code);
  });
});

describe('logFailure and failureFields', () => {
  it('logs the sentence, the code and the id; an authored refusal as a warning', () => {
    const context = { invocationId: 'inv-9', error: vi.fn(), warn: vi.fn() };
    expect(logFailure(context, 'Save failed', new Error('secret text'))).toBe('inv-9');
    expect(context.error).toHaveBeenCalledWith('[inv-9] Save failed (Error)');
    logFailure(context, 'Save refused', new AuthoredError('title is required', { code: 'BAD_INPUT' }));
    expect(context.warn).toHaveBeenCalledWith('[inv-9] Save refused (BAD_INPUT)');
    expect(JSON.stringify([context.error.mock.calls, context.warn.mock.calls])).not.toMatch(
      /secret text|title is required/
    );
  });

  it('builds the failure fields: the door sentence and the correlation id', () => {
    const context = { invocationId: 'inv-7', error: vi.fn(), warn: vi.fn() };
    expect(failureFields(context, 'The brief could not be saved.', new Error('Cosmos 503'))).toEqual({
      ok: false,
      error: 'The brief could not be saved.',
      correlationId: 'inv-7',
    });
    expect(failureFields(context, 'x', new AuthoredError('The draft changed in another tab.'))).toEqual({
      ok: false,
      error: 'The draft changed in another tab.',
      correlationId: 'inv-7',
    });
  });

  it('takes a caller-supplied id from the request when the context has none', () => {
    const request = { headers: { get: (name) => (name === 'x-correlation-id' ? 'req-1' : null) } };
    expect(logFailure({ error: vi.fn() }, 'x', null, request)).toBe('req-1');
  });
});

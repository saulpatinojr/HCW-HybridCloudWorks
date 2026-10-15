import { describe, it, expect, vi } from 'vitest';
import {
  AuthoredError,
  authoredDetails,
  authoredMessage,
  codeShaped,
  errorCode,
  errorFacts,
  errorResponse,
  failureFields,
  getCorrelationId,
  isAuthoredError,
  logFailure,
  ownFrames,
  recordedFailure,
  storedFailure,
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
    expect(context.error).toHaveBeenCalledWith('[inv-12345] Internal Server Error (name=Error)');
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

    it("reads the v4 worker's traceContext.traceParent, and still the v3 spelling", () => {
      const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
      expect(getCorrelationId({ traceContext: { traceParent: tp } })).toBe(tp);
      expect(getCorrelationId({ traceContext: { traceparent: tp } })).toBe(tp);
    });

    it("uses a caller's header only when it has the id shape (#1200 review L4)", () => {
      /** A request whose headers are these values. */
      const headers = (values) => ({ headers: { get: (name) => values[name] ?? null } });
      expect(getCorrelationId({}, headers({ 'x-correlation-id': 'req-42' }))).toBe('req-42');
      expect(getCorrelationId({}, headers({ 'x-request-id': 'abc.123:x' }))).toBe('abc.123:x');
      for (const bad of ['two words', 'line\nbreak', '<script>x</script>', 'a'.repeat(129), '']) {
        const id = getCorrelationId({}, headers({ 'x-correlation-id': bad, 'x-request-id': bad }));
        expect(id).not.toBe(bad);
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      }
      // A bad first header falls through to a good second one.
      expect(getCorrelationId({}, headers({ 'x-correlation-id': 'not ok', 'x-request-id': 'req-7' }))).toBe('req-7');
      // An invocation id that is not one is passed over as well.
      expect(getCorrelationId({ invocationId: 'x y' }, headers({ 'x-request-id': 'req-8' }))).toBe('req-8');
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

describe('ownFrames: where in our own code, and nothing else (#1200 review L3)', () => {
  /** An error whose stack is exactly these lines. */
  const thrown = (...lines) => Object.assign(new Error('secret text'), { stack: lines.join('\n') });

  it('names our own frames as repo-relative path:line, from any host layout', () => {
    const error = thrown(
      'TypeError: Cannot read properties of undefined (reading "id") for ana@example.com',
      '    at runJob (C:\\Users\\someone\\HCW\\functions\\src\\lib\\jobs.js:657:12)',
      '    at async Promise.all (index 0)',
      '    at handler (/home/site/wwwroot/src/functions/jobs-http.js:41:9)',
      '    at file:///home/site/wwwroot/src/lib/job-context.js:90:21',
      '    at Object.other (/home/site/wwwroot/src/lib/fourth.js:1:1)'
    );
    expect(ownFrames(error)).toEqual([
      'src/lib/jobs.js:657',
      'src/functions/jobs-http.js:41',
      'src/lib/job-context.js:90',
    ]);
    expect(errorFacts(Object.assign(error, { name: 'TypeError' }))).toBe(
      'name=TypeError at=src/lib/jobs.js:657,src/functions/jobs-http.js:41,src/lib/job-context.js:90'
    );
  });

  it('skips dependencies, tests, Node internals, paths outside src/ and anything not frame-shaped', () => {
    const error = thrown(
      'Error: at fake (src/lib/injected.js:1:1) sent by the caller',
      '    at x (/home/site/wwwroot/node_modules/@azure/cosmos/dist/index.js:10:5)',
      '    at y (/repo/functions/src/lib/jobs.test.js:12:3)',
      '    at z (node:internal/process/task_queues:95:5)',
      '    at w (/repo/functions/scripts/run.js:3:1)',
      '    at v (/repo/functions/src/lib/has space/x.js:3:1)',
      '    at u (/repo/functions/src/lib/real.js:7:2)',
      '    at u (/repo/functions/src/lib/real.js:7:9)'
    );
    expect(ownFrames(error)).toEqual(['src/lib/real.js:7']);
    expect(errorFacts(error)).not.toMatch(/secret|injected|node_modules|internal|scripts|repo/);
  });

  it('gives nothing for an error with no stack, or for a non-error', () => {
    expect(ownFrames(Object.assign(new Error('x'), { stack: undefined }))).toEqual([]);
    expect(ownFrames('a string')).toEqual([]);
    expect(ownFrames(null)).toEqual([]);
  });
});

describe('errorFacts: what an operator diagnoses by, and nothing else', () => {
  it.each([
    ['a plain error', new Error('Entity rid=9f not found'), 'name=Error'],
    [
      'a Cosmos throttle',
      Object.assign(new Error('Request rate is large. ActivityId: 9f'), { code: 429, substatus: 3200 }),
      'name=Error code=429 substatus=3200',
    ],
    [
      "a provider's HTTP refusal",
      Object.assign(new Error('429 quota for org-abc'), { status: 429, code: 'rate_limit_exceeded' }),
      'name=Error code=rate_limit_exceeded status=429',
    ],
    [
      "undici's fetch failed, with the socket code on its cause",
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect 10.0.0.5:443' } }),
      'name=TypeError cause=ECONNREFUSED',
    ],
    ['an authored refusal', new AuthoredError('title is required', { code: 'BAD_INPUT', status: 400 }), 'name=AuthoredError code=BAD_INPUT status=400'],
    ['a code that is a sentence', { name: 'Error', code: 'a sentence with spaces' }, 'name=Error'],
    ['a string', 'boom', 'type=string'],
    ['nothing', null, 'type=null'],
  ])('%s', (_, error, facts) => {
    expect(errorFacts(error)).toBe(facts);
  });
});

describe('logFailure and failureFields', () => {
  it('logs the sentence, the content-free facts and the id; an authored refusal as a warning', () => {
    const context = { invocationId: 'inv-9', error: vi.fn(), warn: vi.fn() };
    expect(logFailure(context, 'Save failed', new Error('secret text'))).toBe('inv-9');
    expect(context.error).toHaveBeenCalledWith('[inv-9] Save failed (name=Error)');
    logFailure(context, 'Save refused', new AuthoredError('title is required', { code: 'BAD_INPUT' }));
    expect(context.warn).toHaveBeenCalledWith('[inv-9] Save refused (name=AuthoredError code=BAD_INPUT)');
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

describe('codeShaped: a provider value a sentence may carry (#945)', () => {
  it.each([
    ['an OAuth code', 'invalid_grant', 'invalid_grant'],
    ['a socket code', 'ENOTFOUND', 'ENOTFOUND'],
    ['a JSON-RPC number', -32603, '-32603'],
    ['a status', 429, '429'],
    ['surrounding space', '  quota_exceeded ', 'quota_exceeded'],
    ['a sentence', 'The grant type is unauthorized for this client_id', ''],
    ['echoed request data', 'GET /v1/voices?xi-api-key=sk_abc', ''],
    ['markup', '<script>alert(1)</script>', ''],
    ['a URL', 'https://attacker.example/x', ''],
    ['an object', { code: 'x' }, ''],
    ['a fraction', 1.5, ''],
    ['too long', 'a'.repeat(65), ''],
    ['nothing', undefined, ''],
  ])('%s', (_, value, expected) => {
    expect(codeShaped(value)).toBe(expected);
  });
});

describe('storedFailure and recordedFailure: what a document keeps (#945 step 2)', () => {
  it('stores an authored sentence as written', () => {
    expect(storedFailure(new AuthoredError('Choose the podcast voices first.'), 'The audio failed.')).toBe(
      'Choose the podcast voices first.'
    );
  });

  it("stores the caller's sentence with the code and the reference for anything else", () => {
    const socket = Object.assign(new Error('connect ECONNREFUSED 10.0.0.4:443'), { code: 'ECONNREFUSED' });
    expect(storedFailure(socket, 'The feed could not be read.', { correlationId: 'inv-3' })).toBe(
      'The feed could not be read (ECONNREFUSED; reference inv-3).'
    );
    expect(storedFailure(Object.assign(new Error('Request rate is large'), { code: 429 }), 'Saved nothing.')).toBe(
      'Saved nothing (429).'
    );
    expect(storedFailure('a bare string', 'The step failed')).toBe('The step failed (no code).');
  });

  it('never stores a reference shaped like a sentence', () => {
    expect(storedFailure(new Error('x'), 'The job failed.', { correlationId: 'not an id; see body' })).toBe(
      'The job failed (Error).'
    );
  });

  it('logs content-free and stores the same reference as the line', () => {
    const context = { invocationId: 'inv-5', error: vi.fn(), warn: vi.fn() };
    const stored = recordedFailure(context, 'The cover could not be generated.', new Error('Replicate said: prompt'));
    expect(stored).toBe('The cover could not be generated (Error; reference inv-5).');
    expect(context.error).toHaveBeenCalledWith('[inv-5] The cover could not be generated (name=Error)');
    expect(JSON.stringify([stored, context.error.mock.calls])).not.toContain('Replicate said');
    expect(recordedFailure(context, 'x', new AuthoredError('The key is not set.'))).toBe('The key is not set.');
  });
});

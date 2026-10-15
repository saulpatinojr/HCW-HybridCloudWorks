import { describe, it, expect, vi } from 'vitest';
import { errorResponse, getCorrelationId } from './error-response.js';

describe('errorResponse (AP-B10)', () => {
  it('extracts invocationId as correlation ID and logs full error without leaking it', () => {
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

    // Context logger received the internal error with correlation ID
    expect(context.error).toHaveBeenCalledWith(
      '[inv-12345] Internal Server Error:',
      internalErr
    );
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
});

/**
 * admin-responses.js — what a Resend refusal may say (#945).
 *
 * The owner sees the status and Resend's error name; a name that is not a
 * machine code (a sentence, an echo of the broadcast) is left out.
 */
import { describe, it, expect } from 'vitest';
import { describeForLog, describeForOwner } from './admin-responses.js';

describe('describing a Resend refusal', () => {
  it('names the status and a machine-code error name', () => {
    expect(describeForOwner({ status: 422, data: { name: 'validation_error', message: 'Subject: Hi Ana' } })).toBe(
      'HTTP 422 validation_error'
    );
    expect(describeForLog({ status: 429, data: { name: 'rate_limit_exceeded' } })).toBe('HTTP 429 rate_limit_exceeded');
  });

  it('names the status alone when the name is not a code', () => {
    for (const name of ['The broadcast "Weekly: Ana\'s notes" is invalid', '<b>x</b>', { code: 'x' }, 42.5]) {
      expect(describeForOwner({ status: 422, data: { name } })).toBe('HTTP 422');
    }
    expect(describeForOwner({})).toBe('HTTP 0');
  });
});

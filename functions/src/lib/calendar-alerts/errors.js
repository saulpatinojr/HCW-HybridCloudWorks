/**
 * calendar-alerts/errors.js — the refusals the calendar alerts throw. Each
 * is an authored error: the handler answers with its own sentence (#945).
 * Re-exported by model.js.
 */
import { AuthoredError } from '../http/error-response.js';

/** Thrown by a check here; the handler turns it into a 400 (authored, #945). */
export class CalendarAlertValidationError extends AuthoredError {
  /** @param {string} message - the refusal, naming the field */
  constructor(message) {
    super(message, { code: 'INVALID_ALERT', status: 400 });
  }
}

/** Thrown when an id names no alert. */
export class CalendarAlertNotFoundError extends AuthoredError {
  constructor() {
    super('That alert no longer exists. Reload the page to see the current list.', {
      code: 'ALERT_NOT_FOUND',
      status: 404,
    });
  }
}

/** Thrown when a request body is bigger than any alert could need. */
export class CalendarAlertTooLargeError extends AuthoredError {
  constructor() {
    super('The request is too large to be a calendar alert.', { code: 'TOO_LARGE', status: 413 });
  }
}

/** Throw a CalendarAlertValidationError with this sentence. */
export const fail = (message) => {
  throw new CalendarAlertValidationError(message);
};

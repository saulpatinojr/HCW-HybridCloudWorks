// The interview limits, shared by interviewModel.js, interviewForm.js and
// interviewQa.js without any of them importing another.

/** The limits `normalizeInterview` and the server schema share. */
export const LIMITS = Object.freeze({
  MAX_TITLE: 160,
  MAX_SHORT: 240,
  MAX_ANSWER: 6000,
  MAX_QA: 40,
  MAX_TAGS: 20,
  MAX_TRANSCRIPT: 400_000,
});

/** Lower-case words joined by hyphens, the shape the server keeps a tag in. */
export const TAG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

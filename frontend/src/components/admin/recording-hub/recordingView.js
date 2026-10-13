/**
 * The Recording Hub's pure helpers (#576).
 *
 * Everything here is a function of its arguments — no React, no fetch — so a
 * tab can be read for what it renders rather than for how it derives it.
 *
 * `fmtDate` is one function now. PlaudTab and PodcastTab each had their own,
 * identical except that only PodcastTab's guarded `Number.isNaN`; the Plaud
 * copy rendered "Invalid Date" for a malformed stamp. The guarding one wins.
 */

/** Where the Plaud "Script this" queue puts its result, named as a tab id. */
export const SCRIPT_QUEUED_TOAST = 'Queued. It appears on the Transcripts tab when generated.';

/** Accepted by the upload route; mirrors ACCEPTED_AUDIO_EXTENSIONS server-side. */
export const AUDIO_ACCEPT = '.mp3,.m4a,.wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/x-wav';
export const MAX_AUDIO_UPLOAD_BYTES = 40 * 1024 * 1024;

const STAMP = Object.freeze({
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

export function fmtDuration(ms) {
  if (!ms) return '';
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

export function fmtDate(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, STAMP);
}

/**
 * A moment, from either shape the Plaud document stores it in (#358).
 *
 * `lastTokenRefresh` is an ISO string and `oauthExpiresAt` is epoch
 * milliseconds, because the timer writes them from `now().toISOString()` and
 * `now().getTime() + expiresInSec * 1000` respectively. One formatter takes
 * both rather than making the caller remember which is which.
 *
 * Returns '' for anything unparseable, so a malformed field renders as absent
 * rather than as "Invalid Date" — a token page is the wrong place to make
 * someone wonder whether the date or the token is broken.
 */
export function fmtWhen(value) {
  if (value === null || value === undefined || value === '') return '';
  const d = new Date(typeof value === 'number' ? value : String(value));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, STAMP);
}

/**
 * What to say about the last rotation, in the three states that genuinely differ.
 *
 * The middle case is the one worth the function. A field that is PRESENT but
 * unparseable has to say something other than "not since this token was
 * stored", because that sentence is a claim about the timer and the timer did
 * run — we merely cannot read when. Collapsing the two would be the same
 * defect this whole panel exists to remove, one level down.
 */
export function describeLastRefresh(value) {
  if (value === null || value === undefined || value === '') {
    return 'not since this token was stored';
  }
  return fmtWhen(value) || 'recorded, but its timestamp could not be read';
}

/** A File as the base64 the upload route reads, without the data-URL prefix. */
export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Could not read the file'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Readable fallbacks for the skip codes `publish-transcript.js` records
 * (`HOST_SKIP`), used only when the record carries no `reason` sentence.
 */
export const SKIP_PHRASES = Object.freeze({
  not_configured:
    'Podbean is not configured (PODBEAN_CLIENT_ID / PODBEAN_CLIENT_SECRET are not seeded), so nothing was sent',
  no_audio: 'the transcript has no audio, so nothing was sent to Podbean',
  not_published: 'the transcript was returned to draft before the publish ran',
  // ElevenLabs free-plan audio has no commercial licence (owner decision
  // 2026-09-26, ADR 0029 §2a). Approval refuses it with 409 before a job is
  // queued; this is the job's own skip, for a document published otherwise.
  free_plan_licence:
    'the audio was rendered on the ElevenLabs free plan, which has no commercial licence, so nothing was sent to Podbean',
});

/**
 * The sentence for a skipped host publish. The backend stores the code in
 * `skipped` and the human sentence beside it in `reason`; the sentence is what
 * a reviewer needs, the code is the fallback of last resort.
 */
export function describeSkip(host) {
  if (!host || typeof host !== 'object') return '';
  const reason = typeof host.reason === 'string' ? host.reason.trim() : '';
  if (reason) return reason;
  const code = typeof host.skipped === 'string' ? host.skipped : host.skipped?.reason;
  return SKIP_PHRASES[code] || String(code || 'skipped');
}

/**
 * Which of the four host states a transcript is in, as one word.
 *
 * Distribution groups by this and HostLine renders by it, so the order below
 * is the one order — not two `if` chains that could drift apart. A table
 * rather than that chain because the chain was six returns, over the budget
 * `qlty:return-statements` enforces, and because the order being data is what
 * makes "the same order in both places" checkable.
 *
 * `pending` outranks `episodeId`: a re-publish sets pending on a record that
 * already carries the previous episode's id, and reporting that as published
 * would hide the run in flight. `none` means nothing has tried to publish it.
 */
const HOST_STATES = Object.freeze([
  ['pending', (host) => Boolean(host.pending)],
  ['published', (host) => Boolean(host.episodeId)],
  ['error', (host) => Boolean(host.error)],
  ['skipped', (host) => Boolean(host.skipped)],
]);

export function hostState(item) {
  const host = item?.host?.podbean;
  if (!host || typeof host !== 'object') return 'none';
  return HOST_STATES.find(([, holds]) => holds(host))?.[0] ?? 'none';
}

/** The host error as a sentence; the record stores a string or an Error shape. */
export function hostErrorMessage(host) {
  if (!host?.error) return '';
  return typeof host.error === 'string' ? host.error : host.error.message || 'publish failed';
}

/** How a stored recording got into the `recordings` container. */
export function sourceLabel(source) {
  if (source === 'plaud-embedded') return 'Plaud Embedded';
  if (source === 'plaud_mcp') return 'Plaud copy';
  if (source === 'manual_upload') return 'Pasted';
  return source || 'stored';
}

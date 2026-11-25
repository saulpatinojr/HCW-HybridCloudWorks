/**
 * replicate-prediction.js — one Replicate prediction: asking for it, waiting
 * for it to settle, and reading the image address it gives back, for the AI
 * cover generator (ai-cover.js, which exports CoverGenerationError again).
 */
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import { AuthoredError } from '../http/error-response.js';

// Deadlines for the Replicate calls (T-712). This runs inside a change-feed
// handler, so a hung socket does not just fail one cover — it holds the lease
// and queues every subsequent change behind it.
const REPLICATE_POST_TIMEOUT_MS = 90_000; // clears the `Prefer: wait=60` hold
const REPLICATE_POLL_TIMEOUT_MS = 30_000;
const REPLICATE_POLL_BUDGET_MS = 5 * 60 * 1000; // wall clock for the whole poll loop

/**
 * A cover generation this module refuses or gives up on, in its own
 * sentence: an unset key, a task with no image model, a status from
 * Replicate, a generation that is not an image. Authored (#945): the
 * document's altCoverImageError and the manual image routes carry it as
 * written. Replicate's own error text never goes in one.
 */
export class CoverGenerationError extends AuthoredError {}

const RETRYABLE_STATUSES = [429, 503, 502, 504];
const PREDICTION_SETTLED = ['succeeded', 'failed', 'canceled'];

/** POST the prediction, retrying the transient statuses with backoff. */
export async function createPrediction(fetchImpl, { model, headers, input, sleep }) {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetchWithTimeout(
      fetchImpl,
      `https://api.replicate.com/v1/models/${model}/predictions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ input }),
        // `Prefer: wait=60` asks Replicate to hold the connection for up to
        // 60s, so the deadline has to clear that plus slack — otherwise the
        // timeout would fire on the happy path (T-712).
        timeoutMs: REPLICATE_POST_TIMEOUT_MS,
      }
    );
    if (response.ok) return response.json();
    lastStatus = response.status;
    if (!RETRYABLE_STATUSES.includes(response.status) || attempt === 3) break;
    await sleep(2 ** attempt * 1000);
  }
  throw new CoverGenerationError(`Replicate HTTP ${lastStatus}`, { status: lastStatus });
}

/**
 * Poll until the prediction settles. Prefer: wait returns a completed
 * prediction in the common case; this is the otherwise. An iteration count
 * alone does not bound wall-clock time: each iteration sleeps 2s AND makes
 * a request, so a run of slow-but-not-timing-out polls could sit here far
 * longer than the arithmetic suggests. The deadline is the real bound
 * (T-712).
 */
export async function awaitPrediction(fetchImpl, prediction, { authorization, sleep }) {
  const pollDeadline = Date.now() + REPLICATE_POLL_BUDGET_MS;
  let current = prediction;
  for (let poll = 0; poll < 60 && !PREDICTION_SETTLED.includes(current.status); poll += 1) {
    if (Date.now() > pollDeadline) {
      throw new CoverGenerationError(
        `Replicate prediction still ${current.status} after ${Math.round(REPLICATE_POLL_BUDGET_MS / 1000)}s`
      );
    }
    await sleep(2000);
    const response = await fetchWithTimeout(
      fetchImpl,
      current.urls?.get || `https://api.replicate.com/v1/predictions/${current.id}`,
      { headers: { Authorization: authorization }, timeoutMs: REPLICATE_POLL_TIMEOUT_MS }
    );
    if (!response.ok) {
      throw new CoverGenerationError(`Replicate poll HTTP ${response.status}`, {
        status: response.status,
      });
    }
    current = await response.json();
  }
  return current;
}

/** The image URL a settled prediction carries, in any of its output shapes. */
export function predictionImageUrl(prediction) {
  if (prediction.status !== 'succeeded') {
    // The prediction's own error text is Replicate's (and can quote the
    // prompt), so the stored sentence names the status only (#945).
    throw new CoverGenerationError(`Replicate prediction ${prediction.status}`);
  }
  const output = prediction.output;
  const imageUrl =
    typeof output === 'string' ? output : Array.isArray(output) ? output[0] : output?.url;
  if (!imageUrl) throw new CoverGenerationError('No image URL returned from Replicate API');
  return imageUrl;
}


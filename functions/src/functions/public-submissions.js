/**
 * POST /api/public/submissions — the anonymous submission endpoint.
 *
 * Replaces the four pages/submissions/*.jsx browser writes into Firestore.
 * See lib/submissions.js for the contract; this file is transport only:
 * CORS, method, identity, quota, then compose-and-store.
 *
 * Identity fails CLOSED in production (client-identity.js): without the
 * Cloudflare origin secret the request is rejected rather than rate-limited
 * on a spoofable header. That is DECISION 6 doing its job — do not soften it
 * here.
 */
import { httpRoute } from '../lib/auth/http-route.js';
import { authoredMessage } from '../lib/http/error-response.js';
import { createClientIdentity } from '../lib/auth/client-identity.js';
import {
  createDoc,
  incrementIf,
  readDoc,
  replaceDocIfMatch,
  upsertDoc,
} from '../lib/cosmos-client.js';
import {
  validateSubmission,
  composeSubmissionDoc,
  enforceSubmissionQuota,
} from '../lib/submissions.js';

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/**
 * @param {object} [deps] test seam; production uses the real modules
 */
export function createSubmissionsHandler({
  identity = createClientIdentity(),
  // `upsertDoc` writes the submission itself; the other three are the quota's,
  // and it needs all three because a correct counter needs operations that can
  // fail — see enforceSubmissionQuota (T-204).
  store = { readDoc, upsertDoc, incrementIf, createDoc, replaceDocIfMatch },
  now = Date.now,
} = {}) {
  return async function handleSubmission(request, context) {
    // CORS — origin allowlisting, the 403, and the preflight — is applied by
    // httpRoute before this runs, and its headers are merged onto whatever is
    // returned here. Evaluating it a second time would reintroduce exactly the
    // two-allowlist hazard that cors.js DECISION 7 exists to avoid.
    if (String(request.method).toUpperCase() !== 'POST') {
      return json(405, { ok: false, error: 'POST only' });
    }

    let clientKey;
    try {
      clientKey = identity.anonymousKey(request).key;
    } catch {
      // Origin not verifiably Cloudflare and not in dev: refuse, and say why
      // in the log but not to the caller.
      context.warn('submission rejected: unverified origin');
      return json(403, { ok: false, error: 'Forbidden' });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json(400, { ok: false, error: 'Body must be valid JSON' });
    }

    const validated = validateSubmission(body);
    if (validated.error) {
      return json(400, { ok: false, error: validated.error });
    }

    try {
      await enforceSubmissionQuota(store, clientKey, { now: now() });
    } catch (err) {
      if (err.code === 'SUBMISSION_RATE_LIMIT') {
        return json(
          429,
          { ok: false, error: authoredMessage(err, 'Too many submissions — try again later.') },
          { 'Retry-After': '3600' }
        );
      }
      throw err;
    }

    const doc = composeSubmissionDoc(validated.value, {
      nowIso: new Date(now()).toISOString(),
    });
    await store.upsertDoc('content', doc);

    context.log(`submission accepted: type=${doc.type} id=${doc.id}`);
    return json(201, { ok: true, id: doc.id });
  };
}

httpRoute('publicSubmitContent', {
  methods: ['POST', 'OPTIONS'],
  authLevel: 'anonymous',
  route: 'public/submissions',
  handler: createSubmissionsHandler(),
});

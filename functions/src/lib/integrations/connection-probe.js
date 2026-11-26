/**
 * connection-probe.js — "does this credential work?" for the services a
 * browser cannot ask (#483).
 *
 * Telegram, Podbean, YouTube and Resend hold credentials that are only ever
 * read on the server, so the Integrations page had no beaker for them: testing from the
 * browser would mean sending a Key Vault secret to a browser, which that page
 * will not do. #481 made their globes point at the page where each credential
 * is minted, which is the best a card with no test can do. This module is the
 * test, so the globe stops being the only answer.
 *
 * ## Why this is not another rest-proxy integration
 *
 * `rest-proxy.js` takes `{ path, method, body }` from the caller. It spends a
 * long header explaining why that is a confused deputy — whoever controls the
 * path controls where the credential goes — and `assertSafePath` is the
 * boundary that makes it safe. It is a real boundary and it holds, but it is a
 * DENYLIST: it enumerates the shapes that could redirect a credential and
 * refuses those.
 *
 * Nothing here needs that latitude. The page asks one question, "is this
 * credential live", and there is exactly one call per service that answers it.
 * So the caller sends a NAME — `{ probe: 'telegram' }` — and the URL, method
 * and headers are built here from a frozen table. There is no caller-supplied
 * component in the outbound request at all, which is a stronger property than
 * any validator can give: not "the path was checked", but "the caller never
 * supplied one".
 *
 * ## Three of these put a credential in the URL
 *
 * Telegram authenticates in the PATH (`/bot<token>/getMe`), YouTube in the
 * QUERY (`?key=<key>`), and Podbean in the query too (`?access_token=…`, a
 * token minted from the client credentials for this one call). That makes the
 * usual habit of quoting a failed URL back into an error message a credential
 * leak, and it is the kind that ends up in a screenshot on the Integrations
 * page or in Application Insights forever.
 *
 * So: the built URL is never returned and never logged, and the upstream's
 * response is passed through `redactSecrets` BEFORE it is parsed — one choke
 * point, so every string derived from it downstream is already safe. That is
 * belt and braces on top of not interpolating the URL, because the interesting
 * leak is the one nobody wrote on purpose: an undici transport error whose
 * `cause` quotes the request target, or a provider that echoes the request
 * line back in its own error body. The second of those is not hypothetical —
 * the first draft redacted the error string and the log and passed the parsed
 * body through untouched, and its own test caught the token sitting in it.
 *
 * ## What reports a key verdict, and what deliberately does not
 *
 * Only Telegram. It answers 401 for a bad token, its `getMe` call takes no
 * other credential, and so a rejection blames exactly one setting.
 *
 * Podbean, YouTube and Resend stay silent, and that is a decision rather than
 * an omission. #358 cost two days because a verdict was split across two settings
 * on Publer's DOCUMENTED semantics, which turned out to be the reverse of its
 * measured ones. Podbean's refusals have not been measured here, and its token
 * exchange takes two settings, so a refusal could blame either. YouTube is
 * worse: the Data API answers 403 for a disabled API, for an exceeded quota and
 * for a referrer-restricted key, and only some of those mean "the key is
 * wrong". A light that goes red on a quota day would send the owner to remint a
 * key that is fine, which is the exact failure #358 was. Resend refuses a wrong
 * key and a real key minted with sending access only, its documented statuses
 * for the two have not been measured here, and only the first means "remint".
 * Measure first, then wire it; until then the beaker
 * still reports the failure to the operator who pressed it, which is the point
 * of the button.
 */
import { createKeyVerdictReporter } from '../key-verdict.js';
import { AuthoredError, authoredMessage, errorCode } from '../http/error-response.js';
import { PROBE_TIMEOUT_MS, redactSecrets, runProbe, unreachableAnswer } from './probe-answer.js';

export { PROBE_FAILURE_FIELDS, PROBE_TIMEOUT_MS, probeFailure, redactSecrets } from './probe-answer.js';
import { API_KEY_SETTING as COMMUNITY_DAYS_KEY_SETTING, PROBE_URL as COMMUNITY_DAYS_PROBE_URL, sentenceForStatus as communityDaysSentence } from '../community-days/api.js';

/**
 * The Cloudflare probe's address and settings (#1905). Written here rather
 * than imported from cloudflare/client.js, so this module (which a frontend
 * test reaches) does not pull in the Cloudflare client; connection-probe.test.js
 * holds the two copies equal.
 */
export const CLOUDFLARE_PROBE = Object.freeze({
  apiBase: 'https://api.cloudflare.com/client/v4',
  tokenSetting: 'CLOUDFLARE_ADMIN_TOKEN',
  zoneSetting: 'CF_ZONE_ID',
});
const CLOUDFLARE_API_BASE = CLOUDFLARE_PROBE.apiBase;
const CLOUDFLARE_TOKEN_SETTING = CLOUDFLARE_PROBE.tokenSetting;
const CLOUDFLARE_ZONE_SETTING = CLOUDFLARE_PROBE.zoneSetting;

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});



/**
 * Thrown when a credential could not be put in a URL without reshaping it.
 * The sentence is written here and never quotes the value (authored, #945).
 */
export class UnusableCredentialError extends AuthoredError {
  /** @param {string} message - what is wrong with the value, not the value */
  constructor(message) {
    super(message);
    this.name = 'UnusableCredentialError';
  }
}

/**
 * A credential that is about to become part of a URL path, unencoded.
 *
 * Telegram's token sits in the path and must keep its literal colon (see the
 * probe below), so it cannot be run through `encodeURIComponent`. This is the
 * other half of that trade: anything that could END the path segment or start
 * a query, a fragment or a new authority is refused outright.
 *
 * `%` IS IN THE LIST, and it is the least obvious member. Because the value
 * goes in unencoded, a token carrying its own percent-escape — `%2F` — is
 * decoded by the upstream server into the very delimiter this character class
 * just refused. Blocking the literal `/` while allowing the escape that
 * becomes one is a gap, not a boundary. No real Telegram token contains a
 * percent sign, so nothing valid is lost. (Copilot review of 89288f8a.)
 *
 * The value comes from Key Vault, not from the caller, so this is not a
 * defence against an attacker choosing it — it is a defence against a
 * mis-pasted secret quietly changing which URL gets called and turning the
 * result into a confusing 404. Whitespace is included because a trailing
 * newline in a pasted value is the single most common version of that.
 *
 * @throws {UnusableCredentialError}
 */
export function assertUrlSafe(value) {
  if (/[\s/?#\\%]/.test(value)) {
    throw new UnusableCredentialError('the value contains characters that cannot appear in a URL');
  }
  return value;
}

/**
 * One probe: the single read-only call that proves one service's credential.
 *
 * `buildRequest` returns the whole outbound request. It receives the resolved
 * credentials and returns `{ url, headers }`; there is no `method` because
 * every probe is a GET, and making that a field would invite a probe that is
 * not.
 *
 * `settings` is every app setting the probe needs, in the order the operator
 * should read them. The first is the one a rejection blames when
 * `reportsKeyVerdict` is on.
 *
 * `authenticate` is optional and narrow, and exists for a service whose
 * stored credentials are not what its read call takes: an OAuth 2 client
 * whose client id and secret must first be exchanged for an access token
 * (Podbean). It runs before the GET and receives the resolved credentials and
 * `exchange`, a function that performs AT MOST ONE request, always a POST,
 * under the probe's deadline. That request is the token exchange: a POST to
 * the provider's OAuth token endpoint with the client credentials, which
 * mints a short-lived token and creates nothing the service shows. It answers
 * `{ ok, status, data }`, parsed from text already redacted of the stored
 * credentials. `authenticate` returns `{ query, headers }` for the GET — the
 * handler adds both to what `buildRequest` built and redacts their values
 * from everything after — or throws `ProbeAuthenticationError` when the
 * exchange was refused. A second `exchange` call throws instead of sending,
 * so "one token exchange, then the GET" is enforced, not only described.
 */
export function createProbe({
  name,
  service,
  settings,
  buildRequest,
  authenticate = null,
  reportsKeyVerdict = false,
  notConfigured = null,
  failureSentence = null,
  summarize = null,
}) {
  return Object.freeze({
    name,
    service,
    settings,
    buildRequest,
    authenticate,
    reportsKeyVerdict,
    // Three optional refinements, for a probe that can say more than the
    // defaults (the Community Days probe is the first):
    //   notConfigured    the sentence for "the key is not set", in place of
    //                    the default that only names the setting
    //   failureSentence  (status) => this module's own sentence for a refusal
    //                    with that HTTP status, or null for the default
    //   summarize        (data) => the few fields a success relays to the
    //                    page, in place of the upstream's whole answer
    notConfigured,
    failureSentence,
    summarize,
  });
}

/**
 * A token exchange that was refused, or answered without a token. `status`
 * is the token endpoint's HTTP status (or null), and `detail` its own
 * sentence, built from text that was redacted before it was parsed. The
 * message is this module's (authored, #945); `detail` is the provider's and
 * stays out of the answer.
 */
export class ProbeAuthenticationError extends AuthoredError {
  /**
   * @param {string} message - the authored sentence
   * @param {{ status?: number|null, detail?: string }} [options] - the endpoint's status and words
   */
  constructor(message, { status = null, detail = '' } = {}) {
    super(message);
    this.name = 'ProbeAuthenticationError';
    this.status = status;
    this.detail = detail;
  }
}

/** Podbean's OAuth token endpoint — the one URL `podbean.authenticate` posts to. */
export const PODBEAN_TOKEN_URL = 'https://api.podbean.com/v1/oauth/token';

/**
 * The `exchange` an `authenticate` step is handed: one POST, then nothing.
 *
 * The method is fixed here rather than chosen by the probe, the URL must be
 * https, and a second call throws before anything is sent — so a probe with
 * an `authenticate` step makes exactly one token exchange and then its GET.
 * The answer is redacted of `secrets` (the stored credentials, plus any
 * `secrets` the step passes, such as the Basic header that encodes them)
 * BEFORE it is parsed, for the reason the GET's body is below. `secrets` is
 * the handler's own list, so what the step adds stays redacted afterwards.
 *
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {string[]} deps.secrets mutated: extra secrets are appended to it
 * @returns {(url: string, init?: { headers?: object, body?: string, secrets?: string[] }) =>
 *   Promise<{ ok: boolean, status: number, data: unknown }>}
 */
export function createTokenExchange({ fetch: fetchImpl, secrets }) {
  let exchanged = false;
  return async function exchange(url, { headers, body, secrets: extra = [] } = {}) {
    if (exchanged) throw new Error('a probe makes at most one token exchange');
    exchanged = true;
    if (!/^https:\/\//.test(String(url))) throw new Error('a token exchange must be https');
    for (const value of extra) secrets.push(value);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const safe = redactSecrets(await response.text(), secrets);
    let data = null;
    try {
      data = safe ? JSON.parse(safe) : null;
    } catch {
      data = { raw: safe.slice(0, 2000) };
    }
    return { ok: response.ok, status: response.status, data };
  };
}

/**
 * The closed set. A name not in this table is refused before anything is read
 * from the environment, so an unknown probe cannot even confirm which settings
 * exist.
 */
export const PROBES = Object.freeze({
  /**
   * `GET /bot<token>/getMe` — Telegram's own "is this token live" call. It
   * takes no chat id, which is why only the token is judged: a success here
   * says nothing about whether `TELEGRAM_CHAT_ID` names a real conversation,
   * and reporting one would put a green light on a value nothing tested.
   */
  telegram: createProbe({
    name: 'telegram',
    service: 'Telegram',
    settings: ['TELEGRAM_BOT_TOKEN'],
    buildRequest: ({ values }) => ({
      // The token is the path. Never quote this URL anywhere.
      //
      // NOT percent-encoded, deliberately. A bot token is `<digits>:<rest>`
      // and `encodeURIComponent` turns that colon into `%3A`, which Telegram
      // would have to decode before routing. If it ever did not, the probe
      // would answer 404 and the page would tell the owner their token is
      // bad — a wrong diagnosis about the one thing this button exists to
      // diagnose. `assertUrlSafe` below is what makes the unencoded form
      // safe: a value that could alter the request target is refused with a
      // sentence naming the setting, rather than silently reshaping the URL.
      url: `https://api.telegram.org/bot${assertUrlSafe(values.TELEGRAM_BOT_TOKEN)}/getMe`,
      headers: { Accept: 'application/json' },
    }),
    reportsKeyVerdict: true,
  }),

  /**
   * `GET /v1/podcast` — the show the app's token is for (ADR 0029 §1c). The
   * cheapest read Podbean has, and the same one `lib/podcast/podbean.js`
   * exposes as `getPodcast`.
   *
   * Podbean's read calls take an access token, not the client id and secret
   * that are stored, so this is the one probe with an `authenticate` step:
   * `POST /v1/oauth/token` with the client credentials as HTTP Basic auth
   * and `grant_type=client_credentials` (Podbean's documented exchange),
   * which mints a token and creates nothing on the show. The token then
   * travels as the `access_token` query parameter, as Podbean's own examples
   * send it — so it is added to the redaction list the moment it exists, and
   * the URL that carries it is never returned or logged.
   *
   * No key verdict: a refused exchange could be the id or the secret, and
   * Podbean's refusals have not been measured here.
   */
  podbean: createProbe({
    name: 'podbean',
    service: 'Podbean',
    settings: ['PODBEAN_CLIENT_ID', 'PODBEAN_CLIENT_SECRET'],
    authenticate: async ({ values, exchange }) => {
      const basic = Buffer.from(
        `${values.PODBEAN_CLIENT_ID}:${values.PODBEAN_CLIENT_SECRET}`,
        'utf8'
      ).toString('base64');
      const { ok, status, data } = await exchange(PODBEAN_TOKEN_URL, {
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: 'grant_type=client_credentials',
        // The Basic header is the secret in another encoding; redact it too.
        secrets: [basic],
      });
      const token = typeof data?.access_token === 'string' ? data.access_token.trim() : '';
      if (!ok || !token) {
        // OAuth's `{ error, error_description }`, both halves: `invalid_grant`
        // alone does not tell an operator which box to look in.
        const detail = [data?.error, data?.error_description]
          .filter((part) => typeof part === 'string' && part.trim())
          .join(': ');
        throw new ProbeAuthenticationError(
          ok
            ? 'Podbean answered the token request without an access token'
            : 'Podbean refused the client ID and secret',
          { status, detail }
        );
      }
      return { query: { access_token: token } };
    },
    buildRequest: () => ({
      url: 'https://api.podbean.com/v1/podcast',
      headers: { Accept: 'application/json' },
    }),
  }),

  /**
   * `GET /youtube/v3/search` with `maxResults=1`.
   *
   * COSTS ~100 OF 10,000 DAILY QUOTA UNITS, whatever `maxResults` says — the
   * Data API prices search.list per call, not per result. That is the reason
   * this is a button and must never be a timer or a page-load check: a probe
   * on every render would spend the day's quota that Listen & Learn needs for
   * real episodes. `lib/listen-and-learn/videos.js` carries the same
   * arithmetic for the generator's side of the budget.
   */
  youtube: createProbe({
    name: 'youtube',
    service: 'YouTube',
    settings: ['YOUTUBE_API_KEY'],
    buildRequest: ({ values }) => {
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      // A fixed query, not a caller's. The result is discarded; only the
      // status matters.
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('type', 'video');
      url.searchParams.set('q', 'cloud');
      url.searchParams.set('maxResults', '1');
      url.searchParams.set('key', values.YOUTUBE_API_KEY);
      return { url: url.toString(), headers: { Accept: 'application/json' } };
    },
  }),

  /**
   * `GET /domains` — the sending domains the key can see (ADR 0030).
   *
   * Chosen over any send-shaped call because it is read-only and costs nothing
   * against either Resend meter. It also answers the question that matters
   * before anything is built on the key: a key minted with SENDING ACCESS ONLY
   * is refused here with Resend's own `restricted_api_key` sentence, and that
   * key could never manage contacts or broadcasts. A pass here means the key
   * is full-access, and the count says whether a domain has been added yet.
   */
  resend: createProbe({
    name: 'resend',
    service: 'Resend',
    settings: ['RESEND_API_KEY'],
    buildRequest: ({ values }) => ({
      url: 'https://api.resend.com/domains',
      headers: {
        Authorization: `Bearer ${values.RESEND_API_KEY}`,
        Accept: 'application/json',
      },
    }),
  }),

  /**
   * `GET /user` — Qlty's "who does this token belong to" (#569). Read-only
   * and project-independent, so a pass says the token is live without also
   * depending on the project's visibility. No key verdict: a 403 could be a
   * token scope rather than a dead token.
   */
  qlty: createProbe({
    name: 'qlty',
    service: 'Qlty',
    settings: ['QLTY_API_TOKEN'],
    buildRequest: ({ values }) => ({
      url: 'https://api.qlty.sh/user',
      headers: {
        Authorization: `Bearer ${values.QLTY_API_TOKEN}`,
        Accept: 'application/json',
      },
    }),
  }),

  /**
   * `GET /v1/account` — whose Replicate account the token belongs to
   * (ADR 0033 Platform: a card for every AI key). Read-only and free; the
   * cover generator (triggers/ai-cover.js) spends the same token on
   * predictions, and this proves the token without starting one. No key
   * verdict: Replicate's 401/403 split has not been measured here.
   */
  replicate: createProbe({
    name: 'replicate',
    service: 'Replicate',
    settings: ['REPLICATE_API_KEY'],
    buildRequest: ({ values }) => ({
      url: 'https://api.replicate.com/v1/account',
      headers: {
        Authorization: `Bearer ${values.REPLICATE_API_KEY}`,
        Accept: 'application/json',
      },
    }),
  }),

  /**
   * `GET /v2/team/credit-usage` — the team's remaining Firecrawl credits
   * (ADR 0033 Platform). Read-only and free, where a scrape would spend a
   * credit on a page nobody asked for; the count also tells the operator how
   * close the blog listings timer is to running dry. No key verdict, same
   * reason.
   *
   * Version 2 of the API since #1848; version 1 stops answering on
   * 2026-12-10 (https://docs.firecrawl.dev/migrate-to-v2). The answer's
   * fields are spelled differently in v2: `data.remainingCredits`, where v1
   * said `data.remaining_credits`
   * (https://docs.firecrawl.dev/api-reference/endpoint/credit-usage). The
   * body is passed through as it is, so the card's test reads the new name.
   */
  firecrawl: createProbe({
    name: 'firecrawl',
    service: 'Firecrawl',
    settings: ['FIRECRAWL_API_KEY'],
    buildRequest: ({ values }) => ({
      url: 'https://api.firecrawl.dev/v2/team/credit-usage',
      headers: {
        Authorization: `Bearer ${values.FIRECRAWL_API_KEY}`,
        Accept: 'application/json',
      },
    }),
  }),

  /**
   * `GET /published-events?per_page=1` — one public event from Community
   * Days (#1823, ADR 0045), the cheapest read that needs the key. The URL is
   * the client module's own constant, so the API's host is written in one
   * file only and only-read-calls.test.js can hold the site to its two reads.
   *
   * The key can do far more than read (it can change the owner's events and
   * profile at the vendor), which is why this probe, like the client, sends
   * GET and nothing else.
   *
   * Three answers get their own sentence, from the vendor's documented
   * statuses: 401 the key is missing, wrong, deleted or expired; 403 API
   * access is not approved for the account yet; 429 too many requests. A
   * success relays only how many events are published, never an event's text.
   *
   * No key verdict: a 403 here means "not approved yet", not "wrong key", so
   * a light that went red on it would send the owner to remint a good key.
   */
  communityDays: createProbe({
    name: 'communityDays',
    service: 'Community Days',
    settings: [COMMUNITY_DAYS_KEY_SETTING],
    buildRequest: ({ values }) => ({
      url: COMMUNITY_DAYS_PROBE_URL,
      headers: {
        Authorization: `Bearer ${values[COMMUNITY_DAYS_KEY_SETTING]}`,
        Accept: 'application/json',
      },
    }),
    notConfigured:
      'No key yet: the Community Days key has not been pasted on the Keys tab. Community Days must approve API access first; then paste the key there and press Test again',
    failureSentence: (status) => ([401, 403, 429].includes(status) ? communityDaysSentence(status) : null),
    summarize: (data) => ({ total: Number.isInteger(data?.total) ? data.total : null }),
  }),

  /**
   * `GET /zones/{CF_ZONE_ID}` — the site's zone, read with the Cloudflare
   * admin token the Cloudflare page uses (#1905). Read-only and free. A
   * pass says the token is live and can read this one zone; it does not
   * say which kinds of change the token may make (the Cloudflare page's
   * Overview tab reads each one). The zone id is a plain setting from
   * Terraform, not a secret, and goes in the path; the token goes in the
   * header. A success relays the zone's name, status and plan only.
   *
   * No key verdict: Cloudflare answers 403 both for a wrong token and for
   * a good token without Zone Read on this zone, so a red light would not
   * say which to fix.
   */
  cloudflare: createProbe({
    name: 'cloudflare',
    service: 'Cloudflare',
    settings: [CLOUDFLARE_TOKEN_SETTING, CLOUDFLARE_ZONE_SETTING],
    buildRequest: ({ values }) => ({
      url: `${CLOUDFLARE_API_BASE}/zones/${assertUrlSafe(values[CLOUDFLARE_ZONE_SETTING])}`,
      headers: {
        Authorization: `Bearer ${values[CLOUDFLARE_TOKEN_SETTING]}`,
        Accept: 'application/json',
      },
    }),
    notConfigured:
      'No token yet: the Cloudflare admin token has not been pasted on the Keys tab (CLOUDFLARE-ADMIN-TOKEN). Make it in the Cloudflare dashboard for this one zone, paste it there and press Test again',
    failureSentence: (status) => {
      if (status === 400) return 'Cloudflare did not accept the zone id (CF_ZONE_ID, set by Terraform). Check the cloudflare_zone_id workspace variable';
      if (status === 401 || status === 403) {
        return 'Cloudflare refused the token: it is wrong, expired, or cannot read this zone. Make a new one with Zone Read on this zone and paste it on the Keys tab';
      }
      if (status === 404) return 'Cloudflare has no zone with that id (CF_ZONE_ID, set by Terraform)';
      return null;
    },
    summarize: (data) => ({
      name: typeof data?.result?.name === 'string' ? data.result.name : null,
      status: typeof data?.result?.status === 'string' ? data.result.status : null,
      plan: typeof data?.result?.plan?.name === 'string' ? data.result.plan.name : null,
    }),
  }),
});

export const PROBE_NAMES = Object.freeze(Object.keys(PROBES));

/**
 * Run a probe's `authenticate` step, if it has one. Answers `{ minted }` —
 * the query and headers the GET adds, whose values have already joined
 * `secrets` — or `{ refused }`, the `ProbeAuthenticationError` the step
 * threw. Anything else it throws (a transport failure, a second exchange) is
 * the caller's to report as unreachable.
 */
async function authenticateProbe({ probe, values, fetchImpl, secrets }) {
  if (typeof probe.authenticate !== 'function') return { minted: { query: {}, headers: {} } };
  const exchange = createTokenExchange({ fetch: fetchImpl, secrets });
  let result;
  try {
    result = await probe.authenticate({ values, exchange });
  } catch (error) {
    if (error instanceof ProbeAuthenticationError) return { refused: error };
    throw error;
  }
  const minted = { query: { ...result?.query }, headers: { ...result?.headers } };
  for (const value of [...Object.values(minted.query), ...Object.values(minted.headers)]) {
    secrets.push(String(value));
  }
  return { minted };
}

/** Run `authenticateProbe`; a step that could not reach the token endpoint is the unreachable answer. */
async function probeStep(args, request, context) {
  try {
    return await authenticateProbe(args);
  } catch (error) {
    return { answer: unreachableAnswer(context, request, args.probe, error) };
  }
}

/**
 * The probe asked for and the values of its settings: `{ probe, values }`,
 * or `{ answer }` for an unknown probe (400) or a setting that is not set.
 */
function probeAndValues(body, env, readKey) {
  const requested = String(body?.probe ?? '');
  // `Object.hasOwn`, not `PROBES[requested]`: a caller asking for
  // `constructor` or `__proto__` would otherwise reach an inherited member
  // and get something that is not a probe at all.
  if (!Object.hasOwn(PROBES, requested)) {
    return {
      answer: json(400, {
        ok: false,
        error: `probe must be one of ${PROBE_NAMES.join(', ')}`,
      }),
    };
  }
  const probe = PROBES[requested];
  /** @type {Record<string,string>} */
  const values = {};
  for (const setting of probe.settings) {
    const value = readKey(env, setting);
    if (!value) return { answer: notConfigured(probe, setting) };
    values[setting] = value;
  }
  return { probe, values };
}

/**
 * 200 with ok:false, like the proxies: an unseeded key is a configuration
 * state the page renders as "not connected", not a fault to page anyone about.
 */
const notConfigured = (probe, setting) =>
  json(200, {
    ok: false,
    error: probe.notConfigured ? `${probe.notConfigured}.` : `${probe.service} is not configured: ${setting} is not set`,
    code: 'INTEGRATION_NOT_CONFIGURED',
  });

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {Record<string,string|undefined>} [deps.env]
 * @param {typeof fetch} [deps.fetch]
 * @param {(env: Record<string,string|undefined>, name: string) => string} deps.readKey
 * @param {Function|null} [deps.onKeyVerdict] The API-keys page's verdict writer.
 *   Consulted only for a probe that declared `reportsKeyVerdict`.
 * @returns {(request: object, context: object) => Promise<object>}
 */
export function createConnectionProbe({
  guard,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  readKey,
  onKeyVerdict = null,
}) {
  return async function handler(request, context) {
    const auth = await guard.requireRole(request, 'editor');
    if (auth.error) return auth.error;

    const chosen = probeAndValues(await request.json().catch(() => null), env, readKey);
    if (chosen.answer) return chosen.answer;
    const { probe, values } = chosen;

    // Per request, so a failed verdict write warns into this invocation's log.
    const reportVerdict = createKeyVerdictReporter({
      onKeyVerdict: probe.reportsKeyVerdict ? onKeyVerdict : null,
      log: context,
      source: `${probe.name}Probe`,
    });
    const secrets = Object.values(values);

    let request_;
    try {
      request_ = probe.buildRequest({ values });
    } catch (error) {
      // A credential that cannot go in a URL is a configuration state, not a
      // fault: 200 with ok:false, and a sentence that names the setting so the
      // operator knows which box to look in. The value itself is never quoted.
      const setting = probe.settings[0];
      context.warn?.(`${probe.name}Probe refused ${setting} (${errorCode(error)})`);
      return json(200, {
        ok: false,
        error: `${probe.service} cannot be tested: ${setting} ${authoredMessage(error, 'cannot be used in the request')}`,
        code: 'INTEGRATION_NOT_CONFIGURED',
      });
    }

    // The token exchange, for the one kind of probe that needs it (see
    // `createProbe`). What it mints joins the request built above, and its
    // values join the redaction list before anything else is sent or said.
    const step = await probeStep({ probe, values, fetchImpl, secrets }, request, context);
    if (step.refused) {
      // A refused exchange is a credential state, not a fault: 200 with
      // ok:false, like a refused GET, so the page renders "not connected"
      // with the provider's own sentence. No `data`: nothing past this point
      // needs the token endpoint's body.
      // The sentence is this module's; the token endpoint's own words
      // (`detail`) are the provider's and stay out of the answer (#945).
      const { refused } = step;
      context.warn?.(`${probe.name}Probe: token exchange refused (${refused.status ?? 'no status'})`);
      return json(200, {
        ok: false,
        ...(refused.status ? { status: refused.status } : {}),
        error: `${authoredMessage(refused, 'The token exchange was refused')}.`,
      });
    }
    return runProbe({ probe, request_, step, secrets, fetchImpl, reportVerdict }, request, context);
  };
}

/** Reading each publisher's newest release, with retries when a read fails for a reason that may pass (lab-pins-upstream.mjs). */
import { coreVersion, isStable, newest } from './lab-pins-versions.mjs';

const USER_AGENT =
  'HCW-HybridCloudWorks lab-pins-upstream (+https://github.com/saulpatinojr/HCW-HybridCloudWorks)';

// ── Upstream readers ───────────────────────────────────────────────────────

/**
 * The pauses before each second and third try of a read that failed in a way
 * a moment's wait can cure (#1447). A publisher behind a CDN can answer one
 * request with a 5xx or a 406 and the next with the file: on 2026-10-27 a
 * local run read Vault's index as HTTP 406 while the same address answered
 * 200 to every later request, and the product dropped out of that run.
 */
export const RETRY_DELAYS_MS = [2000, 5000];

/** A status worth asking again for, unchanged: a server error, or a 406 a different edge may not give. */
export const retryableStatus = (status) => status >= 500 || status === 406;

/**
 * The Accept header every JSON read sends: JSON first, anything else after
 * it. A 406 means "I cannot give you any type you said you accept".
 * releases.hashicorp.com serves its indexes as
 * `application/vnd+hashicorp.releases-api.v0+json`, and some of its edges
 * (the content-delivery network's servers) refuse a request that accepts
 * `application/json` alone: on 2026-11-10 at 23:59 UTC all three tries of
 * Vault's index got 406 and a run of the weekly check went red, while the
 * header below answered 200 (#1677). The
 * retries above stay for the other causes; this removes the reason to need
 * them here. The body is still parsed and checked as JSON (parseJsonFrom),
 * so accepting any type loosens nothing.
 */
export const JSON_ACCEPT = 'application/json, */*;q=0.8';

/**
 * How long one try may take, the answer's body included, and how long one
 * read may take over all its tries and pauses. Node's own fetch has no limit
 * short of about five minutes, so a publisher that stops answering would
 * otherwise hold a try that long, and three of them would outlast the
 * `propose` job's 15 minutes on their own.
 */
export const TRY_TIMEOUT_MS = 30_000;
export const READ_BUDGET_MS = 60_000;

/** Wait `ms`, or less if `signal` aborts first: a caller that stops does not sit out the pause. */
export const pause = (ms, signal) =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/** Why a try got no answer, in words: a timeout says so, a network error keeps its code (ECONNRESET). */
function noAnswer(error, timeoutMs) {
  if (error?.name === 'TimeoutError') return `no answer within ${Math.round(timeoutMs / 1000)} s`;
  const code = error?.cause?.code;
  return `${error?.message || String(error)}${code ? ` (${code})` : ''}`;
}

/** Let go of an answer whose body is not going to be read, so its connection is freed. */
export const release = (response) => Promise.resolve(response?.body?.cancel?.()).catch(() => {});

/**
 * One read, tried again after each pause in `delays` when it fails with a
 * retryable status or gets no answer: a reset connection, a DNS failure, no
 * reply within TRY_TIMEOUT_MS, or a connection dropped while the body was
 * coming in. `read` takes the body (text, bytes) inside the try, so that last
 * case is tried again too. The request is the same every time, address and
 * headers alike: a retry that changed it would read something other than what
 * the pin rests on. Any other status fails at once, no try starts once
 * READ_BUDGET_MS is spent (checked again after each pause, which can end
 * late), and the last failure names the address, the status or the reason,
 * and how many tries it had. A caller's own `init.signal` still cancels,
 * during a try or a pause, and its reason is thrown without another try. `sleep`, `now` and `deadline` (the
 * timeout signal for one try) are injectable so the tests do not wait.
 */
export async function fetchRetrying(
  fetchImpl,
  url,
  init = {},
  {
    delays = RETRY_DELAYS_MS,
    sleep = pause,
    timeoutMs = TRY_TIMEOUT_MS,
    budgetMs = READ_BUDGET_MS,
    now = Date.now,
    deadline = (ms) => AbortSignal.timeout(ms),
    read = (response) => response,
  } = {}
) {
  const started = now();
  const elapsed = () => now() - started;
  for (let attempt = 1; ; attempt += 1) {
    const limit = Math.min(timeoutMs, Math.max(budgetMs - elapsed(), 1));
    const outcome = await tryOnce(fetchImpl, url, init, { limit, deadline, read });
    if ('value' in outcome) return outcome.value;
    const { failure } = outcome;
    const giveUp = () => new Error(attempt > 1 ? `${failure} (tried ${attempt} times)` : failure);
    const wait = delays[attempt - 1];
    if (!mayTryAgain(outcome.status, wait, elapsed, budgetMs)) throw giveUp();
    await pauseUnlessCancelled(sleep, wait, init.signal);
    if (elapsed() >= budgetMs) throw giveUp();
  }
}

/**
 * One try of fetchRetrying: `{ value }` when it answered OK and its body was
 * read, else `{ failure, status }` (status null when nothing answered). The
 * caller's own cancellation is thrown as it is.
 */
async function tryOnce(fetchImpl, url, init, { limit, deadline, read }) {
  const timeout = deadline(limit);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let response = null;
  let status = null;
  let failure;
  try {
    response = await fetchImpl(url, { ...init, signal });
    if (response.ok) return { value: await read(response) };
    status = response.status;
    failure = `${url}: HTTP ${status}`;
  } catch (error) {
    if (init.signal?.aborted) throw error;
    failure = `${url}: ${noAnswer(error, limit)}`;
  }
  await release(response);
  return { failure, status };
}

/** Whether a failed try is worth another: a retryable status (or none), a pause left, and the budget not spent by it. */
function mayTryAgain(status, wait, elapsed, budgetMs) {
  if (status !== null && !retryableStatus(status)) return false;
  return wait !== undefined && elapsed() + wait < budgetMs;
}

/** The pause between tries; the caller's cancellation, before or during it, is thrown. */
async function pauseUnlessCancelled(sleep, wait, signal) {
  if (signal?.aborted) throw signal.reason;
  await sleep(wait, signal);
  if (signal?.aborted) throw signal.reason;
}

/** A JSON body, or an error that names where it came from. */
export function parseJsonFrom(url, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${url}: the answer is not JSON (${error.message})`);
  }
}

/** The plain readers behind `sources`: text and JSON, each through fetchRetrying, the body read inside it. */
export function makeFetchers({ fetchImpl = fetch, retry } = {}) {
  const fetchText = (url, headers = {}) =>
    fetchRetrying(fetchImpl, url, { headers: { 'User-Agent': USER_AGENT, ...headers } }, { ...retry, read: (r) => r.text() });
  const fetchJson = async (url, headers = {}) => parseJsonFrom(url, await fetchText(url, { Accept: JSON_ACCEPT, ...headers }));
  return { fetchText, fetchJson };
}

/** A string as a regular-expression literal: every metacharacter escaped. */
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Newest stable version in a Debian Packages index for one package name. */
export function newestAptVersion(packagesText, packageName) {
  const versions = [];
  // The name is a literal (`containerd.io`), so its dot is escaped: unescaped
  // it would match any character, `containerdXio` included (CodeQL
  // js/regex/missing-regexp-anchor on #899).
  const header = new RegExp(`^Package: ${escapeRegExp(packageName)}$`, 'm');
  for (const stanza of packagesText.split(/\n\n+/)) {
    if (!header.test(stanza)) continue;
    const v = coreVersion(stanza.match(/^Version: (.+)$/m)?.[1]);
    if (v) versions.push(v);
  }
  return newest(versions);
}

/** Newest stable tag from a GitHub releases listing (prereleases and drafts skipped). */
export function newestGitHubRelease(releases) {
  const versions = releases
    .filter((r) => !r.prerelease && !r.draft)
    .map((r) => coreVersion(r.tag_name))
    .filter((v) => v && isStable(v));
  return newest(versions);
}

/** Newest stable tag from a GitHub tags listing (for a repository that tags but publishes no releases). */
export function newestGitHubTag(tags) {
  const versions = tags.map((t) => coreVersion(t.name)).filter((v) => v && isStable(v));
  return newest(versions);
}

/** Newest stable version from releases.hashicorp.com/<product>/index.json. */
export function newestHashicorp(index) {
  return newest(Object.keys(index.versions ?? {}).filter(isStable));
}

/** Newest tag in a Docker Hub tag listing that starts with `line.` (e.g. `18.` → 18.x). */
export function newestDockerHubTag(results, line) {
  const versions = results
    .map((t) => t.name)
    .filter((name) => new RegExp(`^${line.replace('.', '\\.')}\\.\\d+$`).test(name));
  return newest(versions);
}

/** Newest release in one major line from nodejs.org/dist/index.json. */
export function newestNodeLine(index, major) {
  const versions = index
    .map((e) => coreVersion(e.version))
    .filter((v) => v && v.startsWith(`${major}.`));
  return newest(versions);
}

export function githubHeaders(env) {
  return env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {};
}

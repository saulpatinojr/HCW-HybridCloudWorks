/**
 * The one-shot behind bin/report-coder-automation.js: the lab host's Coder
 * upkeep hands its report, and a renewed status token when it has one, to
 * the site (2026-10-08).
 *
 * The host cannot write the token to Key Vault, by design: the vault's
 * firewall denies it, and the agent's certificate is the one credential the
 * host holds. So the token travels the way everything else the host tells
 * the site travels, through the agent's API client (lib/api.js): the same
 * certificate, the same scope, the same timeout, the same error shape, and
 * agentId from the same configuration (lib/config.js). The server verifies
 * the token against Coder before it stores it
 * (functions/src/lib/labs/coder-automation.js).
 *
 * THE CONTRACT WITH THE CALLER
 *
 *   stdin   ONE JSON object: `{ statusToken?, report }`, the route's body
 *           without agentId, which comes from LABS_AGENT_ID (or the
 *           hostname) like every other call this agent makes. Any other key,
 *           agentId included, is refused here before anything is sent.
 *   stdout  `{"ok":true,"stored":<bool>}` and a newline, exit 0, when the
 *           site recorded the report; `stored` says whether it took a token.
 *   stderr  On any failure, ONE line: the error's class and nothing else
 *           (lib/log.js errorClass), exit 1. `HTTP 422` is a token that
 *           failed one of the site's checks (it works, it is the status
 *           user's, it can only read), `HTTP 400` a report the site would
 *           not read (a host clock more than ten minutes fast among them),
 *           `HTTP 403` an agent the registry does not know or has
 *           deactivated. After a 422 the site's sentence is the report's
 *           `lastError` on the Integrations card, never this output; a 400
 *           records nothing.
 *           `INVALID_INPUT`, `INPUT_TOO_LARGE` and `MISSING_CONFIG` are this
 *           side's own; `UNEXPECTED_ANSWER` a 2xx that did not say ok.
 *
 * THE TOKEN IS NEVER WRITTEN ANYWHERE BUT THE REQUEST. Not on stdout, which
 * carries two fixed fields; not on stderr, which carries a class, never a
 * message, because a server refusal or a fetch error may quote what it was
 * sent; and not in an argument, because it arrives on stdin, where a process
 * listing cannot see it. lib/report-coder-automation.test.js feeds a token
 * through every path and looks for it in everything written.
 */
import { createApiClient } from './api.js';
import { missingConfig, readApiConfig } from './config.js';
import { errorClass } from './log.js';

/** A report is a few hundred bytes; anything near this is not one. */
export const MAX_INPUT_BYTES = 16 * 1024;

/** The keys stdin may carry: the route's body without agentId. */
export const INPUT_FIELDS = Object.freeze(['statusToken', 'report']);

/**
 * A failure named by its code, which is also its whole message: there is
 * nothing else to say. Exported since 2026-10-19 for report-host-check.js,
 * the host checks' one-shot (#1282), which fails in the same words.
 */
export const failure = (code) => Object.assign(new Error(code), { code });

/** All of `stream`, as UTF-8, refusing more than `limit` bytes. */
export async function readInput(stream, limit = MAX_INPUT_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw failure('INPUT_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The one object stdin holds, as the API method takes it: exactly the keys
 * in `fields`, each present or undefined, in that order. The report's own
 * fields are the server's to judge: it answers 400 with a sentence, and a
 * second copy of those rules here would only drift from the first.
 *
 * `fields` defaults to this one-shot's own; report-host-check.js passes its
 * own list (2026-10-19, #1282), so the two one-shots refuse input by one
 * rule rather than two copies of it.
 */
export function parseInput(text, fields = INPUT_FIELDS) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw failure('INVALID_INPUT');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('INVALID_INPUT');
  }
  if (Object.keys(value).some((key) => !fields.includes(key))) throw failure('INVALID_INPUT');
  return Object.fromEntries(fields.map((key) => [key, value[key]]));
}

/**
 * Write and wait for it to be flushed, so the caller may exit straight
 * after. Exported for report-host-check.js (2026-10-19, #1282).
 */
export const write = (stream, text) =>
  new Promise((resolve) => {
    stream.write(text, () => resolve());
  });

/**
 * Read stdin, send the report, say how it went. Resolves to the exit code;
 * never rejects.
 *
 * @param {object} io
 * @param {AsyncIterable<Buffer|string>} io.stdin
 * @param {{ write: Function }} io.stdout
 * @param {{ write: Function }} io.stderr
 * @param {Record<string, string|undefined>} [io.env]
 * @param {(config: object) => { reportCoderAutomation: Function }} [io.createClient]
 * @param {() => string} [io.hostname]
 * @returns {Promise<0|1>}
 */
export async function runReportCoderAutomation({
  stdin,
  stdout,
  stderr,
  env = process.env,
  createClient = createApiClient,
  hostname,
}) {
  try {
    const input = parseInput(await readInput(stdin));
    const config = readApiConfig(env, hostname);
    if (missingConfig(config).length > 0) throw failure('MISSING_CONFIG');
    const answer = await createClient(config).reportCoderAutomation(input);
    if (answer?.ok !== true) throw failure('UNEXPECTED_ANSWER');
    await write(stdout, `${JSON.stringify({ ok: true, stored: answer.stored === true })}\n`);
    return 0;
  } catch (err) {
    await write(stderr, `${errorClass(err)}\n`);
    return 1;
  }
}

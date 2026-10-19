/**
 * The one-shot behind bin/report-host-check.js: a check the lab host runs on
 * itself hands its report to the site (2026-10-19, #1282).
 *
 * The first such check is hcw-portainer-check (lab-host/ansible/roles/
 * portainer): every fifteen minutes it reads Portainer on the host's
 * loopback with the owner's token and reports what it saw, as counts and
 * states, never names. The host has one way of telling the site anything,
 * the agent's API client (lib/api.js), and this is one more call through it:
 * the same certificate, the same scope, the same timeout, the same error
 * shape, and agentId from the same configuration (lib/config.js), exactly as
 * report-coder-automation.js does for the Coder upkeep. The server checks the
 * report field by field and records it under admin_config/host_checks
 * (functions/src/lib/labs/host-checks.js); the Health Hub's Portainer card
 * and the Labs snapshot read it from there (labs/lab-checks.js).
 *
 * THE CONTRACT WITH THE CALLER
 *
 *   stdin   ONE JSON object: `{ check, report }`, the route's body without
 *           agentId, which comes from LABS_AGENT_ID (or the hostname) like
 *           every other call this agent makes. `check` names the check
 *           ('portainer' today) and `report` is its reading; the server owns
 *           the rules for both. Any other key, agentId included, is refused
 *           here before anything is sent.
 *   stdout  `{"ok":true}` and a newline, exit 0, when the site recorded the
 *           report.
 *   stderr  On any failure, ONE line: the error's class and nothing else
 *           (lib/log.js errorClass), exit 1. `HTTP 400` is a report the site
 *           would not read (a field missing or of the wrong shape, a host
 *           clock more than ten minutes off the site's), `HTTP 403` an agent
 *           the registry does not know or has deactivated, `HTTP 500` a
 *           report the site could not write. `INVALID_INPUT`,
 *           `INPUT_TOO_LARGE` and `MISSING_CONFIG` are this side's own;
 *           `UNEXPECTED_ANSWER` a 2xx that did not say ok.
 *
 * NOTHING IN THE REPORT IS A SECRET, AND STILL NOTHING IT CARRIES IS WRITTEN
 * HERE. The Portainer token stays on the host, in a root-only file the check
 * reads through a systemd credential, and the report is counts and states.
 * Even so stdout carries one fixed field and stderr a class, never a
 * message, because a server refusal or a fetch error may quote what it was
 * sent, and what a check sends may change. The reading helpers are
 * report-coder-automation.js's own, imported rather than copied, so the two
 * one-shots cannot drift apart in what they refuse.
 */
import { createApiClient } from './api.js';
import { missingConfig, readApiConfig } from './config.js';
import { errorClass } from './log.js';
import { failure, parseInput, readInput, write } from './report-coder-automation.js';

/** The keys stdin may carry: the route's body without agentId. */
export const INPUT_FIELDS = Object.freeze(['check', 'report']);

/**
 * Read stdin, send the report, say how it went. Resolves to the exit code;
 * never rejects.
 *
 * @param {object} io
 * @param {AsyncIterable<Buffer|string>} io.stdin
 * @param {{ write: Function }} io.stdout
 * @param {{ write: Function }} io.stderr
 * @param {Record<string, string|undefined>} [io.env]
 * @param {(config: object) => { reportHostCheck: Function }} [io.createClient]
 * @param {() => string} [io.hostname]
 * @returns {Promise<0|1>}
 */
export async function runReportHostCheck({
  stdin,
  stdout,
  stderr,
  env = process.env,
  createClient = createApiClient,
  hostname,
}) {
  try {
    const input = parseInput(await readInput(stdin), INPUT_FIELDS);
    const config = readApiConfig(env, hostname);
    if (missingConfig(config).length > 0) throw failure('MISSING_CONFIG');
    const answer = await createClient(config).reportHostCheck(input);
    if (answer?.ok !== true) throw failure('UNEXPECTED_ANSWER');
    await write(stdout, `${JSON.stringify({ ok: true })}\n`);
    return 0;
  } catch (err) {
    await write(stderr, `${errorClass(err)}\n`);
    return 1;
  }
}

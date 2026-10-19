#!/usr/bin/env node
/**
 * Hand a lab host check's report to the site through the agent's API
 * credential (2026-10-19, #1282). The first caller is hcw-portainer-check,
 * the portainer role's fifteen-minute read of Portainer on the loopback.
 *
 * Usage, as the agent's user with the agent's environment file loaded
 * (labs-agent.env; LABS_AGENT_API_BASE, LABS_AGENT_TENANT_ID,
 * LABS_AGENT_CLIENT_ID, LABS_AGENT_CERT_PATH, LABS_AGENT_API_SCOPE,
 * LABS_AGENT_ID), bash:
 *
 *   printf '%s' '{"check":"portainer","report":{...}}' | node bin/report-host-check.js
 *
 * One JSON object on stdin: the body of POST /api/agent/reportHostCheck
 * without agentId. Stdin rather than an argument for the same reason as
 * report-coder-automation.js: a process listing shows arguments, and what a
 * check reports is the server's to judge, not the shell's to carry. Success
 * prints {"ok":true} and exits 0; failure prints the error's class alone on
 * stderr and exits 1. Everything else is in lib/report-host-check.js.
 */
import { runReportHostCheck } from '../lib/report-host-check.js';

const code = await runReportHostCheck({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
});

// Exit now rather than when the event loop drains: the answer is written and
// flushed, and an idle keep-alive socket in fetch or the Entra credential
// must not hold a one-shot open.
process.exit(code);

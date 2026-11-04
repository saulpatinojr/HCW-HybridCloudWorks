/**
 * Remove the per-run `ci-*` firewall windows a dead run left open, and put
 * the host storage firewall back to Deny. (#1463)
 *
 * ## Why
 *
 * Two workflows let their own runner through an Azure firewall for a few
 * minutes (a "window") and close it again in an `always()` step:
 *
 *   - `deploy-functions.yml`: one IP rule on the host storage account, with
 *     the account's default action flipped to Allow for the upload;
 *     `ci-deploy-scm-<run id>` on the Function App's SCM site; and
 *     `ci-smoke-<run id>` on the Function App itself.
 *   - `publish-content-manifest.yml`: `ci-manifest-<run id>` on the Function
 *     App.
 *
 * An `always()` step does not run when the runner is lost, when GitHub has an
 * infrastructure failure or when the job is force-terminated, so a window can
 * outlive its run. The hourly `monitor-functions-registered.yml` finds such a
 * window with `scripts/check-ci-access-windows.mjs` and emails the owner
 * (#1050), and until #1463 a person removed it by hand. This script is what
 * removes it: `remove-ci-access-windows.yml` runs it every hour.
 *
 * ## What it decides
 *
 * The detection is `check-ci-access-windows.mjs`'s, imported rather than
 * copied: a `ci-*` rule belongs to the run whose id its name ends in, and the
 * Actions API says whether that run has finished. Then, per rule:
 *
 *   - its run is still live (queued, waiting, pending, requested or in
 *     progress): LEFT ALONE. The run will close it.
 *   - its run has finished, or no longer exists: REMOVED. Nothing else will.
 *   - it names no run at all: LEFT ALONE AND REPORTED. No run opened it, so
 *     a person placed it, and a person decides.
 *
 * The storage account's IP rules carry no names, so they cannot be matched
 * to a run. The account is "open" when its default action is not Deny or any
 * IP rule exists (the steady state in `infra/variables.tf` is none). An open
 * account is RESTORED (default action Deny, every IP rule removed) only when
 * no `deploy-functions.yml` run is in progress, read from the Actions API
 * immediately before the first write. A deploy that has reached its open
 * step has been in progress for at least the checkout, Node setup and Azure
 * login before it, so that read catches it. The Deny goes first, as the
 * deploy's own close step does: it is the part that matters if a later call
 * fails.
 *
 * Every Azure write is tried up to three times with a pause between, for
 * the 409 Resource Manager answers while an earlier update to the same
 * resource is still running (`scripts/lib/window-retry.sh` says why).
 *
 * ## Logging
 *
 * Rule names, run ids and counts only. No rule's address, no account key,
 * nothing a `show` returned beyond what the decision needs.
 *
 * ## Usage
 *
 *     APP=func-site-prod-cus-01 RG=rg-web-site-prod-cus STOR=stsiteprodcus01 \
 *       GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo \
 *       node scripts/remove-ci-access-windows.mjs
 *
 * `DRY_RUN=1` prints every decision and writes nothing. `STOR` may be left
 * unset to skip the storage account.
 *
 * Prints a short verdict on the first line, then one Markdown line per rule
 * and per storage decision, ready for a job summary. Exit 0 when nothing was
 * left open or everything left open was put back; 1 when a removal or the
 * storage restore failed (named); 2 when the check could not run, which says
 * nothing about the windows.
 */
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { LIVE_STATUSES, orphanReason, parseWindows, readRun } from './check-ci-access-windows.mjs';
import { findDeploysInProgress } from './check-functions-deploy-in-progress.mjs';

const execFileAsync = promisify(execFile);

/** Pauses, in milliseconds, before the second and third try of an Azure write. */
export const WRITE_PAUSES_MS = Object.freeze([5000, 20000]);

/** How long one `az` call may take before it is abandoned. */
export const AZ_TIMEOUT_MS = 120000;

/** Markdown inline code for a rule name: no backtick can end it early. */
const code = (value) => {
  const text = String(value);
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  if (longest === 0) return `\`${text}\``;
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${text} ${fence}`;
};

/**
 * What to do with one `ci-*` window, given its run as the Actions API
 * reports it (`readRun`'s shape; ignored when the window names no run).
 *
 * @returns {{ action: 'keep'|'remove'|'report', reason: string }}
 */
export function decideWindow(window, run) {
  if (window.runId === null) {
    return {
      action: 'report',
      reason: 'it names no run, in its name or its description, so no run opened it; left for a person to read',
    };
  }
  if (LIVE_STATUSES.includes(run?.status)) {
    return { action: 'keep', reason: `run ${window.runId} is ${run.status.replace('_', ' ')} and will close it` };
  }
  return { action: 'remove', reason: orphanReason(window, run) };
}

/**
 * What to do with the host storage account's firewall.
 *
 * @param {{ defaultAction: string, ipRules: Array<{ ipAddressOrRange?: string }> }} network
 *   the account's `networkRuleSet`
 * @param {Array<object>} deploys the `deploy-functions.yml` runs in progress
 * @returns {{ action: 'keep'|'restore', reason: string, setDeny: boolean, removeAddresses: string[] }}
 */
export function decideStorage(network, deploys) {
  const defaultAction = String(network?.defaultAction ?? '');
  const ipRules = Array.isArray(network?.ipRules) ? network.ipRules : [];
  const addresses = ipRules.map((rule) => String(rule?.ipAddressOrRange ?? '')).filter(Boolean);
  const setDeny = defaultAction !== 'Deny';
  const base = { setDeny, removeAddresses: addresses };
  if (!setDeny && addresses.length === 0) {
    return { action: 'keep', reason: 'default action Deny and no IP rules; nothing is open', ...base };
  }
  const open = [setDeny ? `default action ${defaultAction || 'unreadable'}` : null, addresses.length ? `${addresses.length} IP rule(s)` : null]
    .filter(Boolean)
    .join(' and ');
  if (deploys.length > 0) {
    const label = deploys[0].run_number ? `deploy run #${deploys[0].run_number}` : `deploy run ${deploys[0].id}`;
    const more = deploys.length > 1 ? ` and ${deploys.length - 1} more` : '';
    return { action: 'keep', reason: `${open}, held by ${label}${more} in progress; that run closes its own window`, ...base };
  }
  return { action: 'restore', reason: `${open} with no functions deploy in progress`, ...base };
}

/**
 * The firewall state of the storage account, from `az storage account show`.
 * @throws {Error} when the output is not an account's `networkRuleSet`
 */
export function parseNetworkRuleSet(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('the storage account answer is not JSON. Expected `az storage account show --query networkRuleSet -o json`.');
  }
  if (!doc || typeof doc !== 'object' || typeof doc.defaultAction !== 'string' || !Array.isArray(doc.ipRules)) {
    throw new Error(
      'the storage account answer has no `defaultAction` string or no `ipRules` list, so the firewall was not read. ' +
        'Expected `az storage account show --query networkRuleSet -o json`.'
    );
  }
  return doc;
}

/** The verdict when the check itself could not run. */
export function formatUnreadable(reason) {
  return {
    code: 2,
    lines: ['unreadable', `This run could not judge the access windows, which says nothing about them: ${reason}`],
  };
}

/** Runs `az` with these arguments (no shell) and returns its stdout. */
export async function runAz(args) {
  const { stdout } = await execFileAsync('az', args, { timeout: AZ_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

/** One write, tried once more after each pause when it fails. */
async function withRetry(write, { pauses = WRITE_PAUSES_MS, sleep }) {
  let last;
  for (let attempt = 0; attempt <= pauses.length; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      last = error;
      if (attempt < pauses.length) await sleep(pauses[attempt]);
    }
  }
  throw last;
}

/** The first line of an error, which is where `az` puts the code and message. */
const firstLine = (error) => String(error?.stderr || error?.message || error).split('\n').find((line) => line.trim()) ?? 'unknown error';

/**
 * Everything but the process: environment, `az`, the Actions API and the
 * clock in; exit code and stdout lines out.
 */
export async function run({ env = {}, az = runAz, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauses = WRITE_PAUSES_MS }) {
  const { APP: app, RG: resourceGroup, STOR: storage } = env;
  const dryRun = env.DRY_RUN === '1' || env.DRY_RUN === 'true';
  const token = env.GITHUB_TOKEN;
  const [owner, repo] = String(env.GITHUB_REPOSITORY ?? '').split('/');
  if (!app || !resourceGroup) return formatUnreadable('it needs APP and RG (the Function App and its resource group).');
  if (!token || !owner || !repo) return formatUnreadable('it needs GITHUB_TOKEN and GITHUB_REPOSITORY (owner/repo) to read the runs.');

  const lines = [];
  let removed = 0;
  let kept = 0;
  let reported = 0;
  let failed = 0;
  const did = dryRun ? 'would remove' : 'removed';

  // 1. The Function App's two rule lists.
  let windows;
  try {
    windows = parseWindows(await az(['functionapp', 'config', 'access-restriction', 'show', '-n', app, '-g', resourceGroup, '-o', 'json', '--only-show-errors']));
  } catch (error) {
    return formatUnreadable(`the Function App's access restrictions could not be read: ${firstLine(error)}`);
  }

  for (const window of windows) {
    let runInfo = { status: 'unknown', conclusion: null, url: null };
    if (window.runId !== null) {
      try {
        runInfo = await readRun({ runId: window.runId, token, owner, repo, fetchImpl });
      } catch (error) {
        return formatUnreadable(`the run behind ${code(window.name)} could not be read: ${error.message}`);
      }
    }
    const { action, reason } = decideWindow(window, runInfo);
    const where = `${code(window.name)} on the ${window.site}`;
    const link = runInfo.url ? ` (${runInfo.url})` : '';
    if (action === 'keep') {
      kept += 1;
      lines.push(`- ${where}: left alone, ${reason}${link}.`);
      continue;
    }
    if (action === 'report') {
      reported += 1;
      lines.push(`- ${where}: left alone, ${reason}.`);
      continue;
    }
    const args = ['functionapp', 'config', 'access-restriction', 'remove', '-g', resourceGroup, '-n', app, '--rule-name', window.name, '--output', 'none'];
    if (window.site === 'SCM site') args.push('--scm-site', 'true');
    try {
      if (!dryRun) await withRetry(() => az(args), { pauses, sleep });
      removed += 1;
      lines.push(`- ${where}: ${did}, ${reason}${link}.`);
    } catch (error) {
      failed += 1;
      lines.push(`- ${where}: NOT removed (${reason}${link}): ${firstLine(error)}`);
    }
  }

  // 2. The host storage account, when the job names one.
  if (storage) {
    let network;
    try {
      network = parseNetworkRuleSet(await az(['storage', 'account', 'show', '-n', storage, '-g', resourceGroup, '--query', 'networkRuleSet', '-o', 'json', '--only-show-errors']));
    } catch (error) {
      return formatUnreadable(`the storage account's firewall could not be read: ${firstLine(error)}`);
    }
    let deploys = [];
    const open = network.defaultAction !== 'Deny' || network.ipRules.length > 0;
    if (open) {
      try {
        deploys = await findDeploysInProgress({ token, owner, repo, fetchImpl });
      } catch (error) {
        return formatUnreadable(`whether a functions deploy is in progress could not be read, so the open storage firewall was left as it is: ${error.message}`);
      }
    }
    const decision = decideStorage(network, deploys);
    if (decision.action === 'keep') {
      if (open) {
        kept += 1;
        lines.push(`- storage account ${code(storage)}: left alone, ${decision.reason}.`);
      } else {
        lines.push(`- storage account ${code(storage)}: ${decision.reason}.`);
      }
    } else {
      const steps = [];
      if (decision.setDeny) {
        steps.push({
          label: 'default action set to Deny',
          args: ['storage', 'account', 'update', '-g', resourceGroup, '-n', storage, '--default-action', 'Deny', '--output', 'none'],
        });
      }
      decision.removeAddresses.forEach((address, i) => {
        steps.push({
          label: `IP rule ${i + 1} of ${decision.removeAddresses.length} removed`,
          args: ['storage', 'account', 'network-rule', 'remove', '-g', resourceGroup, '--account-name', storage, '--ip-address', address, '--output', 'none'],
        });
      });
      const done = [];
      let failure = null;
      for (const step of steps) {
        try {
          if (!dryRun) await withRetry(() => az(step.args), { pauses, sleep });
          done.push(step.label);
        } catch (caught) {
          failure = { step, caught };
          break;
        }
      }
      if (failure) {
        failed += 1;
        const got = done.length ? ` after ${done.join(', ')}` : '';
        lines.push(`- storage account ${code(storage)}: NOT fully restored (${decision.reason}): "${failure.step.label}" failed${got}: ${firstLine(failure.caught)}`);
      } else {
        removed += 1;
        lines.push(`- storage account ${code(storage)}: ${dryRun ? 'would be restored' : 'restored'} (${done.join(', ')}), ${decision.reason}.`);
      }
    }
  }

  const parts = [];
  if (removed) parts.push(`${removed} ${did}`);
  if (kept) parts.push(`${kept} left alone (run in progress)`);
  if (reported) parts.push(`${reported} left for a person`);
  if (failed) parts.push(`${failed} FAILED`);
  const head = parts.length ? parts.join(', ') : 'nothing left open';
  return { code: failed ? 1 : 0, lines: [dryRun ? `dry run: ${head}` : head, ...lines] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ env: process.env })
    .then(({ code, lines }) => {
      process.stdout.write(`${lines.join('\n')}\n`);
      process.exitCode = code;
    })
    .catch((error) => {
      process.stdout.write(`${formatUnreadable(error?.message || String(error)).lines.join('\n')}\n`);
      process.exitCode = 2;
    });
}

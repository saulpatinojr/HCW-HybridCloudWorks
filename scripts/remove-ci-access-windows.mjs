/**
 * Remove the per-run `ci-*` firewall windows a dead run left open, and put
 * the host storage firewall back the way that run's close step would have.
 * (#1463)
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
 * ## What it decides, on the Function App
 *
 * The detection is `check-ci-access-windows.mjs`'s, imported rather than
 * copied: a `ci-*` rule belongs to the run whose id its name ends in, and the
 * Actions API says whether that run has finished. Then, per rule:
 *
 *   - its name is not one of the three the workflows write
 *     (`ci-deploy-scm-<id>`, `ci-smoke-<id>`, `ci-manifest-<id>`): LEFT
 *     ALONE AND REPORTED. No workflow opened it, so a person placed it, and a
 *     person decides. That covers a rule with no run id and a hand-made
 *     `ci-*` rule whose name happens to end in digits.
 *   - its run is still live (queued, waiting, pending, requested or in
 *     progress): LEFT ALONE. The run will close it. A re-run keeps its id,
 *     reopens the same window and is in progress again, so it is left alone
 *     too.
 *   - its run has finished, or no longer exists: REMOVED. Nothing else will.
 *
 * ## What it decides, on the storage account
 *
 * The account's IP rules carry no names, and Terraform declares two states
 * of its own that look exactly like a leftover window: an operator's own
 * address in `functions_storage_admin_ip_rules`, and `Allow` as the
 * documented rollback default action (`infra/variables.tf`). So "anything
 * not Deny" is not a window. What is a window is named: the open step of
 * `deploy-functions.yml` writes the tag `ciwindow` = `<run id> <runner ip>`
 * on the account before it adds the rule, and its close step clears the tag
 * last. Then:
 *
 *   - no tag: nothing to do. An open firewall with no tag is REPORTED, not
 *     touched: it is the operator's, or a window opened before #1463.
 *   - a tag naming a run that is still live: LEFT ALONE.
 *   - a tag naming a run that has finished or no longer exists: RESTORED,
 *     which is exactly what that run's close step does: default action
 *     Deny first (the close step sets Deny whatever Terraform declares, so
 *     this does too), then that one address removed if it is still there,
 *     then the tag cleared. Nothing else on the account is read or written.
 *
 * A deploy that starts while this runs writes its own tag first, so the tag
 * is read again immediately before every write and the restore stops the
 * moment it names a different run: that run owns the window now. The reads
 * and writes go to Resource Manager, which serialises updates to one
 * account, so a stopped restore leaves the new run's window as that run
 * wrote it.
 *
 * Every Azure write is tried up to three times with a pause between, for
 * the 409 Resource Manager answers while an earlier update to the same
 * resource is still running (`scripts/lib/window-retry.sh` says why). An
 * authorization refusal is not retried: it will not change in twenty
 * seconds.
 *
 * ## Logging
 *
 * Rule names, run ids and counts only, plus the first line of what `az`
 * reported when a call failed. No rule's address, no account key, nothing a
 * `show` returned beyond what the decision needs.
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
 * and for the storage account, ready for a job summary. Exit 0 when nothing
 * was left open or everything left open was put back; 1 when a removal or
 * the storage restore failed (named); 2 when the check could not run, which
 * says nothing about the windows.
 */
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { LIVE_STATUSES, orphanReason, parseWindows, readRun } from './check-ci-access-windows.mjs';

const execFileAsync = promisify(execFile);

/** Pauses, in milliseconds, before the second and third try of an Azure write. */
export const WRITE_PAUSES_MS = Object.freeze([5000, 20000]);

/** How long one `az` call may take before it is abandoned. */
export const AZ_TIMEOUT_MS = 120000;

/** The tag `deploy-functions.yml` writes on the host storage account while its window is open. */
export const WINDOW_TAG = 'ciwindow';

/** The three rule names the workflows write, and nothing else is removed. */
export const WORKFLOW_RULE = /^ci-(?:deploy-scm|smoke|manifest)-\d+$/;

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
 * reports it (`readRun`'s shape; ignored when the rule is not a workflow's).
 *
 * @returns {{ action: 'keep'|'remove'|'report', reason: string }}
 */
export function decideWindow(window, run) {
  if (!WORKFLOW_RULE.test(String(window?.name ?? '')) || window.runId === null) {
    return {
      action: 'report',
      reason: 'its name is not one a workflow writes (ci-deploy-scm-, ci-smoke- or ci-manifest- and a run id), so a person placed it; left for a person to read',
    };
  }
  if (LIVE_STATUSES.includes(run?.status)) {
    return { action: 'keep', reason: `run ${window.runId} is ${run.status.replace('_', ' ')} and will close it` };
  }
  return { action: 'remove', reason: orphanReason(window, run) };
}

/**
 * The window tag's parts: the run that wrote it and the runner's address.
 * Null when there is no tag or it is not `<run id> <IPv4>`.
 */
export function parseWindowTag(value) {
  const found = /^(\d+) (\d{1,3}(?:\.\d{1,3}){3})$/.exec(String(value ?? '').trim());
  return found ? { runId: found[1], address: found[2] } : null;
}

/**
 * What to do with the host storage account's firewall.
 *
 * @param {{ defaultAction: string, ipRules: Array<{ ipAddressOrRange?: string }>, window: string|null }} account
 *   the account as `readStorage` returns it
 * @param {{ status: string }|null} run the tagged run, as `readRun` reports it; null without a tag
 * @returns {{ action: 'keep'|'restore'|'report', reason: string, setDeny: boolean, removeAddress: string|null }}
 */
export function decideStorage(account, run) {
  const defaultAction = String(account?.defaultAction ?? '');
  const addresses = (Array.isArray(account?.ipRules) ? account.ipRules : []).map((rule) => String(rule?.ipAddressOrRange ?? ''));
  const tag = parseWindowTag(account?.window);
  const none = { setDeny: false, removeAddress: null };
  const open = [defaultAction !== 'Deny' ? `default action ${defaultAction || 'unreadable'}` : null, addresses.length ? `${addresses.length} IP rule(s)` : null]
    .filter(Boolean)
    .join(' and ');
  if (!tag) {
    if (account?.window) {
      return { action: 'report', reason: `its ${WINDOW_TAG} tag is not "<run id> <address>"; left for a person to read`, ...none };
    }
    if (!open) return { action: 'keep', reason: 'default action Deny, no IP rules and no window tag; nothing is open', ...none };
    return {
      action: 'report',
      reason: `${open} and no ${WINDOW_TAG} tag, so no deploy run opened it: an operator window (functions_storage_admin_ip_rules) or the rollback default action in infra/variables.tf; left for a person to read`,
      ...none,
    };
  }
  if (LIVE_STATUSES.includes(run?.status)) {
    return { action: 'keep', reason: `its window is run ${tag.runId}'s, which is ${run.status.replace('_', ' ')} and will close it`, ...none };
  }
  const ended = run?.status === 'missing' ? `run ${tag.runId} does not exist in this repository` : `run ${tag.runId} has ended (${run?.status ?? 'unknown'}${run?.conclusion ? `, ${run.conclusion}` : ''})`;
  return {
    action: 'restore',
    reason: `its window is run ${tag.runId}'s and ${ended}${open ? `; ${open}` : ''}`,
    setDeny: defaultAction !== 'Deny',
    removeAddress: addresses.includes(tag.address) ? tag.address : null,
  };
}

/**
 * The account's firewall and window tag, from `az storage account show`.
 * @throws {Error} when the output is not that document
 */
export function parseStorage(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('the storage account answer is not JSON. Expected `az storage account show -o json` with the firewall and tag query.');
  }
  if (!doc || typeof doc !== 'object' || typeof doc.defaultAction !== 'string' || !Array.isArray(doc.ipRules)) {
    throw new Error(
      'the storage account answer has no `defaultAction` string or no `ipRules` list, so the firewall was not read. ' +
        'Expected `az storage account show -o json` with the firewall and tag query.'
    );
  }
  return { defaultAction: doc.defaultAction, ipRules: doc.ipRules, window: doc.window == null ? null : String(doc.window) };
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

/** The first line of an error, which is where `az` puts the code and message. */
const firstLine = (error) => String(error?.stderr || error?.message || error).split('\n').find((line) => line.trim()) ?? 'unknown error';

/** Worth trying again: anything but a refusal of the identity's authority. */
const retryable = (error) => !/AuthorizationFailed|Forbidden/i.test(String(error?.stderr || error?.message || ''));

/** One write, tried once more after each pause when it fails for a reason that may pass. */
async function withRetry(write, { pauses, sleep }) {
  let last;
  for (let attempt = 0; attempt <= pauses.length; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      last = error;
      if (!retryable(error) || attempt >= pauses.length) break;
      await sleep(pauses[attempt]);
    }
  }
  throw last;
}

const STORAGE_QUERY = `{defaultAction: networkRuleSet.defaultAction, ipRules: networkRuleSet.ipRules, window: tags.${WINDOW_TAG}}`;

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
  const counts = { removed: 0, kept: 0, reported: 0, failed: 0 };
  const did = dryRun ? 'would remove' : 'removed';
  const retry = (write) => (dryRun ? Promise.resolve('') : withRetry(write, { pauses, sleep }));

  // 1. The Function App's two rule lists.
  let windows;
  try {
    windows = parseWindows(await az(['functionapp', 'config', 'access-restriction', 'show', '-n', app, '-g', resourceGroup, '-o', 'json', '--only-show-errors']));
  } catch (error) {
    return formatUnreadable(`the Function App's access restrictions could not be read: ${firstLine(error)}`);
  }

  for (const window of windows) {
    let runInfo = { status: 'unknown', conclusion: null, url: null };
    if (WORKFLOW_RULE.test(window.name) && window.runId !== null) {
      try {
        runInfo = await readRun({ runId: window.runId, token, owner, repo, fetchImpl });
      } catch (error) {
        return formatUnreadable(`the run behind ${code(window.name)} could not be read: ${error.message}`);
      }
    }
    const { action, reason } = decideWindow(window, runInfo);
    const where = `${code(window.name)} on the ${window.site}`;
    const link = runInfo.url ? ` (${runInfo.url})` : '';
    if (action !== 'remove') {
      counts[action === 'keep' ? 'kept' : 'reported'] += 1;
      lines.push(`- ${where}: left alone, ${reason}${link}.`);
      continue;
    }
    const args = ['functionapp', 'config', 'access-restriction', 'remove', '-g', resourceGroup, '-n', app, '--rule-name', window.name, '--output', 'none'];
    if (window.site === 'SCM site') args.push('--scm-site', 'true');
    try {
      await retry(() => az(args));
      counts.removed += 1;
      lines.push(`- ${where}: ${did}, ${reason}${link}.`);
    } catch (error) {
      counts.failed += 1;
      lines.push(`- ${where}: NOT removed (${reason}${link}): ${firstLine(error)}`);
    }
  }

  // 2. The host storage account, when the job names one.
  if (storage) {
    const readStorage = async () => parseStorage(await az(['storage', 'account', 'show', '-n', storage, '-g', resourceGroup, '--query', STORAGE_QUERY, '-o', 'json', '--only-show-errors']));
    let account;
    try {
      account = await readStorage();
    } catch (error) {
      return formatUnreadable(`the storage account's firewall could not be read: ${firstLine(error)}`);
    }
    const tag = parseWindowTag(account.window);
    let runInfo = null;
    if (tag) {
      try {
        runInfo = await readRun({ runId: tag.runId, token, owner, repo, fetchImpl });
      } catch (error) {
        return formatUnreadable(`the deploy run behind the storage account's window tag could not be read: ${error.message}`);
      }
    }
    const decision = decideStorage(account, runInfo);
    const where = `storage account ${code(storage)}`;
    const link = runInfo?.url ? ` (${runInfo.url})` : '';
    if (decision.action !== 'restore') {
      if (decision.action === 'report' || (decision.action === 'keep' && tag)) counts[decision.action === 'keep' ? 'kept' : 'reported'] += 1;
      lines.push(`- ${where}: ${decision.action === 'keep' && !tag ? '' : 'left alone, '}${decision.reason}${link}.`);
    } else {
      // The close step's own order: Deny, the address, the tag. The tag is
      // read again before each write; a different value means a new deploy
      // owns the window now, and this stops.
      const steps = [];
      if (decision.setDeny) steps.push({ label: 'default action set to Deny', args: ['storage', 'account', 'update', '-g', resourceGroup, '-n', storage, '--default-action', 'Deny', '--output', 'none'] });
      if (decision.removeAddress) steps.push({ label: "the run's IP rule removed", args: ['storage', 'account', 'network-rule', 'remove', '-g', resourceGroup, '--account-name', storage, '--ip-address', decision.removeAddress, '--output', 'none'] });
      steps.push({ label: 'tag cleared', args: ['storage', 'account', 'update', '-g', resourceGroup, '-n', storage, '--remove', `tags.${WINDOW_TAG}`, '--output', 'none'] });
      const done = [];
      let outcome = null;
      for (const step of steps) {
        if (!dryRun && done.length > 0) {
          let now;
          try {
            now = await readStorage();
          } catch (error) {
            outcome = { kind: 'failed', text: `"${step.label}" was not tried: the account could not be read again first: ${firstLine(error)}` };
            break;
          }
          if (now.window !== account.window) {
            outcome = { kind: 'taken', text: `stopped before "${step.label}": the ${WINDOW_TAG} tag changed, so a new deploy run owns the window now and closes it itself` };
            break;
          }
        }
        try {
          await retry(() => az(step.args));
          done.push(step.label);
        } catch (error) {
          outcome = { kind: 'failed', text: `"${step.label}" failed: ${firstLine(error)}` };
          break;
        }
      }
      const got = done.length ? `${done.join(', ')}` : 'nothing';
      if (!outcome) {
        counts.removed += 1;
        lines.push(`- ${where}: ${dryRun ? 'would be restored' : 'restored'} (${got}), ${decision.reason}${link}.`);
      } else if (outcome.kind === 'taken') {
        counts.kept += 1;
        lines.push(`- ${where}: ${outcome.text} (${got} done first), ${decision.reason}${link}.`);
      } else {
        counts.failed += 1;
        lines.push(`- ${where}: NOT fully restored (${decision.reason}${link}): ${outcome.text}; done before that: ${got}`);
      }
    }
  }

  const parts = [];
  if (counts.removed) parts.push(`${counts.removed} ${did}`);
  if (counts.kept) parts.push(`${counts.kept} left alone (run in progress)`);
  if (counts.reported) parts.push(`${counts.reported} left for a person`);
  if (counts.failed) parts.push(`${counts.failed} FAILED`);
  const head = parts.length ? parts.join(', ') : 'nothing left open';
  return { code: counts.failed ? 1 : 0, lines: [dryRun ? `dry run: ${head}` : head, ...lines] };
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

/** Deciding what to do with each CI access window from what Azure reports (remove-ci-access-windows.mjs). */
import { LIVE_STATUSES, orphanReason } from '../check-ci-access-windows.mjs';

/** Pauses, in milliseconds, before the second and third try of an Azure write. */
export const WRITE_PAUSES_MS = Object.freeze([5000, 20000]);

/** How long one `az` call may take before it is abandoned. */
export const AZ_TIMEOUT_MS = 120000;

/** The tag `deploy-functions.yml` writes on the host storage account while its window is open. */
export const WINDOW_TAG = 'ciwindow';

/** The three rule names the workflows write, and nothing else is removed. */
export const WORKFLOW_RULE = /^ci-(?:deploy-scm|smoke|manifest)-\d+$/;

/** Markdown inline code for a rule name: no backtick can end it early. */
export const code = (value) => {
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

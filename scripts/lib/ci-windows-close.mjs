/** Closing the CI access windows on the function apps and the storage account (remove-ci-access-windows.mjs). */
import { code, decideStorage, decideWindow, parseStorage, parseWindowTag, WORKFLOW_RULE } from './ci-windows-decide.mjs';
import { firstLine, readOrStop, STORAGE_QUERY } from './ci-windows-az.mjs';
import { restoreStorage } from './ci-windows-restore.mjs';
import { parseWindows, readRun } from '../check-ci-access-windows.mjs';
import { findDeploysInProgress } from '../check-functions-deploy-in-progress.mjs';

/** The run a window or a tag names, from the Actions API. */
const readRunOf = (runId, { token, owner, repo, fetchImpl }) => readRun({ runId, token, owner, repo, fetchImpl });

/** The Function App's two rule lists: each window removed, kept or reported. */
export async function closeAppWindows(ctx) {
  const { app, resourceGroup, az } = ctx;
  const windows = await readOrStop(
    async () => parseWindows(await az(['functionapp', 'config', 'access-restriction', 'show', '-n', app, '-g', resourceGroup, '-o', 'json', '--only-show-errors'])),
    (error) => `the Function App's access restrictions could not be read: ${firstLine(error)}`
  );
  for (const window of windows) await closeAppWindow(ctx, window);
}

async function closeAppWindow(ctx, window) {
  const { app, resourceGroup, az, lines, counts, did, retry } = ctx;
  let runInfo = { status: 'unknown', conclusion: null, url: null };
  if (WORKFLOW_RULE.test(window.name) && window.runId !== null) {
    runInfo = await readOrStop(
      () => readRunOf(window.runId, ctx.github),
      (error) => `the run behind ${code(window.name)} could not be read: ${error.message}`
    );
  }
  const { action, reason } = decideWindow(window, runInfo);
  const where = `${code(window.name)} on the ${window.site}`;
  const link = runInfo.url ? ` (${runInfo.url})` : '';
  if (action !== 'remove') {
    counts[action === 'keep' ? 'kept' : 'reported'] += 1;
    lines.push(`- ${where}: left alone, ${reason}${link}.`);
    return;
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

/** The host storage account's firewall: restored, kept or reported. */
export async function closeStorageWindow(ctx) {
  const { storage, resourceGroup, az, lines, counts } = ctx;
  const readStorage = async () => parseStorage(await az(['storage', 'account', 'show', '-n', storage, '-g', resourceGroup, '--query', STORAGE_QUERY, '-o', 'json', '--only-show-errors']));
  const account = await readOrStop(readStorage, (error) => `the storage account's firewall could not be read: ${firstLine(error)}`);
  const tag = parseWindowTag(account.window);
  const runInfo = tag
    ? await readOrStop(
        () => readRunOf(tag.runId, ctx.github),
        (error) => `the deploy run behind the storage account's window tag could not be read: ${error.message}`
      )
    : null;
  const decision = decideStorage(account, runInfo);
  const where = `storage account ${code(storage)}`;
  const link = runInfo?.url ? ` (${runInfo.url})` : '';
  if (decision.action !== 'restore') {
    if (decision.action === 'report' || (decision.action === 'keep' && tag)) counts[decision.action === 'keep' ? 'kept' : 'reported'] += 1;
    lines.push(`- ${where}: ${decision.action === 'keep' && !tag ? '' : 'left alone, '}${decision.reason}${link}.`);
    return;
  }
  if (await deployInProgress(ctx, { where, decision, link })) return;
  await restoreStorage(ctx, { account, decision, readStorage, where, link });
}

/**
 * A deploy in progress right now may be about to open its own window
 * (or already has, and its tag is seconds away); the restore waits for
 * the next hour rather than race it. Returns whether one is in progress,
 * after noting it.
 */
async function deployInProgress(ctx, { where, decision, link }) {
  const deploys = await readOrStop(
    () => findDeploysInProgress(ctx.github),
    (error) => `whether a functions deploy is in progress could not be read, so the storage window was left as it is: ${error.message}`
  );
  if (deploys.length === 0) return false;
  const label = deploys[0].run_number ? `deploy run #${deploys[0].run_number}` : `deploy run ${deploys[0].id}`;
  ctx.counts.kept += 1;
  ctx.lines.push(`- ${where}: left alone this hour, ${label} is in progress${deploys.length > 1 ? ` (and ${deploys.length - 1} more)` : ''} and may be opening its own window; ${decision.reason}${link}.`);
  return true;
}

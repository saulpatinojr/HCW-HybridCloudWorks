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
 * is read again immediately before every write, the first included, and the
 * restore stops the moment it names a different run: that run owns the
 * window now. Before the first write the Actions API is also asked whether
 * any `deploy-functions.yml` run is in progress, and a restore waits for the
 * next hour if one is: a deploy reaches its open step only after its
 * checkout, Node setup and Azure login, so it has been in progress for well
 * over the seconds between that read and the write. The remover does not
 * share the deploy's concurrency group for this: GitHub keeps one pending
 * run per group and cancels the earlier one when another arrives, so an
 * hourly run in that group could cancel a deploy waiting its turn
 * (monitor-functions-registered.yml records the same reasoning). The reads
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
import { pathToFileURL } from 'node:url';
import { formatUnreadable, WRITE_PAUSES_MS } from './lib/ci-windows-decide.mjs';
import { runAz, Unreadable, withRetry } from './lib/ci-windows-az.mjs';
import { closeAppWindows, closeStorageWindow } from './lib/ci-windows-close.mjs';
// The parts below now live in their own files; they are exported from here too, so callers keep their imports.
export { WRITE_PAUSES_MS, AZ_TIMEOUT_MS, WINDOW_TAG, WORKFLOW_RULE, decideWindow, parseWindowTag, decideStorage, parseStorage, formatUnreadable } from './lib/ci-windows-decide.mjs';
export { runAz, WindowTaken } from './lib/ci-windows-az.mjs';

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

  const ctx = {
    app,
    resourceGroup,
    storage,
    az,
    dryRun,
    github: { token, owner, repo, fetchImpl },
    lines: [],
    counts: { removed: 0, kept: 0, reported: 0, failed: 0 },
    did: dryRun ? 'would remove' : 'removed',
    retry: (write) => (dryRun ? Promise.resolve('') : withRetry(write, { pauses, sleep })),
  };
  try {
    // 1. The Function App's two rule lists.
    await closeAppWindows(ctx);
    // 2. The host storage account, when the job names one.
    if (storage) await closeStorageWindow(ctx);
  } catch (error) {
    if (error instanceof Unreadable) return formatUnreadable(error.message);
    throw error;
  }
  return summary(ctx);
}

/** The report: a first line that counts what happened, then a line per window. */
function summary({ counts, did, dryRun, lines }) {
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

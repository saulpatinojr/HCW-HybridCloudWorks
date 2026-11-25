/** Putting storage access back the way it was when closing a window fails part-way (remove-ci-access-windows.mjs). */
import { WINDOW_TAG } from './ci-windows-decide.mjs';
import { firstLine, WindowTaken } from './ci-windows-az.mjs';

/** The writes that close the storage window, in the close step's own order: Deny, the address, the tag. */
function restoreSteps({ resourceGroup, storage }, decision) {
  const steps = [];
  if (decision.setDeny) steps.push({ label: 'default action set to Deny', args: ['storage', 'account', 'update', '-g', resourceGroup, '-n', storage, '--default-action', 'Deny', '--output', 'none'] });
  if (decision.removeAddress) steps.push({ label: "the run's IP rule removed", args: ['storage', 'account', 'network-rule', 'remove', '-g', resourceGroup, '--account-name', storage, '--ip-address', decision.removeAddress, '--output', 'none'] });
  steps.push({ label: 'tag cleared', args: ['storage', 'account', 'update', '-g', resourceGroup, '-n', storage, '--remove', `tags.${WINDOW_TAG}`, '--output', 'none'] });
  return steps;
}

/**
 * Run the restore's writes in order until one fails. The tag is
 * read again inside every try of every write, the first included, so a
 * retry after a pause cannot act on a stale read either; a different
 * value means a new deploy owns the window now, and this stops
 * (CodeRabbit on #1536). Returns the steps done, and how it stopped (null when it did not).
 */
async function runRestoreSteps(ctx, { account, decision, readStorage }) {
  const done = [];
  for (const step of restoreSteps(ctx, decision)) {
    const ownedWrite = async () => {
      const now = await readStorage();
      if (now.window !== account.window) throw new WindowTaken(step.label);
      return ctx.az(step.args);
    };
    try {
      await ctx.retry(ownedWrite);
      done.push(step.label);
    } catch (error) {
      const outcome = error instanceof WindowTaken ? { kind: 'taken', text: error.message } : { kind: 'failed', text: `"${step.label}" failed: ${firstLine(error)}` };
      return { done, outcome };
    }
  }
  return { done, outcome: null };
}

export async function restoreStorage(ctx, { account, decision, readStorage, where, link }) {
  const { lines, counts, dryRun } = ctx;
  // The close step's own order: Deny, the address, the tag.
  const { done, outcome } = await runRestoreSteps(ctx, { account, decision, readStorage });
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

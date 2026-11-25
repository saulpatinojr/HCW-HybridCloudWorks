/** The Markdown report check-workflow-health.mjs prints, and the key its findings are filed under. */
import { FAILING_SCHEDULED_RUNS, FINDING_VERDICTS } from './workflow-health-assess.mjs';

/**
 * Markdown for the job summary. Kept pure so the tests can read it.
 *
 * `absent` is the listed workflows whose file is not on the default branch
 * (#1564). They are not in `results`, so nothing below can call one broken;
 * they get one line of their own, after the verdicts, so a reader who
 * remembers the row knows why it is gone rather than wondering whether the
 * check stopped looking.
 *
 * @param {Array} results the verdicts, from `assessAll`
 * @param {{staleDays: number, absent?: Array<{path: string}>, defaultBranch?: string}} options
 */
export function renderReport(results, { staleDays, absent = [], defaultBranch = 'main' }) {
  const lines = ['## Workflow health', '', ...findingLines(results)];

  // A workflow that would have been `failing` but was set aside: the one
  // running this check, a disabled one, or one with no schedule any more. Not
  // a finding (see `assessWorkflow`), but not hidden either.
  for (const r of results.filter((x) => x.setAside)) {
    lines.push('', `Not judged as failing: \`${r.path}\` — ${r.setAside.why}. Set aside because ${r.setAside.reason}.`);
  }

  lines.push(...unprovenLines(results.filter((r) => r.verdict === 'unproven'), staleDays));

  if (absent.length > 0) {
    lines.push(
      '',
      `Not on \`${defaultBranch}\`, run history only, not assessed: ` +
        absent.map((w) => `\`${w.path}\``).join(', ') +
        '. GitHub lists a workflow while it has runs, even when its file was only ever on a branch or has since been deleted.'
    );
  }

  const key = findingsKey(results);
  if (key) lines.push('', key);

  return lines.join('\n');
}

/** The headline, and the `broken` and `failing` sections. */
function findingLines(results) {
  const broken = results.filter((r) => r.verdict === 'broken');
  const failing = results.filter((r) => r.verdict === 'failing');
  const lines = [];
  // The headline speaks only for the `broken` and `failing` sets, because
  // those are the only sets it counts. Claiming "every workflow succeeded
  // recently or is inside the window" contradicted the stalled section printed
  // below it the moment that section existed — a summary arguing with its own
  // body. Introduced by the stalled split and caught in review on PR #426. For
  // the same reason it is not printed above a `failing` section (#1661).
  if (broken.length === 0 && failing.length === 0) {
    lines.push('**No workflow is failing-and-abandoned.**');
  }
  if (broken.length > 0) {
    lines.push(
      `**${broken.length} workflow(s) have never succeeded in the sampled window and nobody has been back.**`,
      '',
      'A workflow that cannot succeed teaches everyone to ignore a red X. Fix it or delete it.',
      ''
    );
    for (const r of broken) lines.push(`- \`${r.path}\` — ${r.why}`);
  }
  if (failing.length > 0) {
    if (broken.length > 0) lines.push('');
    lines.push(
      `**${failing.length} scheduled workflow(s) failed their last ${FAILING_SCHEDULED_RUNS} scheduled runs in a row.**`,
      '',
      'A scheduled job that keeps failing at its own pace is one nobody is fixing. Open the newest failed run, fix the cause, and the next green scheduled run clears it.',
      ''
    );
    for (const r of failing) lines.push(`- \`${r.path}\` — ${r.why}`);
  }
  return lines;
}

/**
 * The `unproven` verdicts. An unproven verdict is not a failure and never exits
 * non-zero — nothing was measured, so nothing is claimed. But one that has been
 * unproven for longer than the staleness window is the case this audit existed
 * to surface, and burying it in a collapsed block is how it stays buried.
 * Split, not reclassified.
 */
function unprovenLines(unproven, staleDays) {
  const lines = [];
  const stalled = unproven.filter((r) => Number.isFinite(r.ageDays) && r.ageDays >= staleDays);
  const recent = unproven.filter((r) => !stalled.includes(r));

  if (stalled.length > 0) {
    lines.push(
      '',
      `**${stalled.length} workflow(s) have concluded nothing either way for over ${staleDays} days.**`,
      '',
      'Not a failure — but nothing here is evidence it still works. Confirm or delete.',
      ''
    );
    for (const r of stalled)
      lines.push(`- \`${r.path}\` — ${r.why}, newest ${r.ageDays.toFixed(1)}d ago`);
  }

  if (recent.length > 0) {
    lines.push('', '<details><summary>Not concluded either way</summary>', '');
    for (const r of recent) lines.push(`- \`${r.path}\` — ${r.why}`);
    lines.push('', '</details>');
  }
  return lines;
}

/**
 * One hidden line that names the findings and nothing that changes between
 * checks, or '' when there are none.
 *
 * The monitor runs every four hours and keeps one issue open while a finding
 * stands. It compares this line with the newest text in the issue that
 * carries one, and comments only when it differs: a comment means the SET of
 * findings changed (a workflow was added, or moved from one verdict to the
 * other). Each finding is keyed `path:verdict` and nothing more. Not the
 * `broken` line's age, which grows every day, and not the newest failed run:
 * an hourly monitor (`monitor-functions-registered.yml`) fails again every
 * hour while it is red, which would have meant a comment at every check. It
 * is an HTML comment, so neither the job summary nor the issue shows it.
 */
export function findingsKey(results) {
  const keys = results
    .filter((r) => FINDING_VERDICTS.has(r.verdict))
    .map((r) => `${r.path}:${r.verdict}`)
    .sort();
  return keys.length ? `<!-- workflow-health findings: ${keys.join(' ')} -->` : '';
}

/* c8 ignore start — the network half, exercised by running it */

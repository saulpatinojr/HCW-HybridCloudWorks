/** The report verify-alert-state.mjs writes: the summary, the table of rules and the inventory. */
import { UNREADABLE } from './alert-state-expected.mjs';
import { FAILING, FAILING_GROUP, NOT_READ } from './alert-state-compare.mjs';
import { shortName } from './alert-declarations.mjs';

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * Text made safe for one cell of a Markdown table (code scanning, #1051).
 *
 * A pipe ends the cell, so it is escaped as `\|`; and because that escape is
 * a backslash, a backslash already in the text is escaped first, or `\|` in
 * an ARM error message would arrive as an escaped backslash and a bare pipe.
 * Line breaks end the row, so they become spaces.
 */
export function tableCell(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** A value shown in code style, or a dash for nothing. */
const cell = (value) => (value === undefined || value === null || value === '' ? '—' : `\`${tableCell(value)}\``);

/** How many rules and action groups the run could not read, as recorded. */
export function unreadCounts(verdicts, groups) {
  return {
    rules: verdicts.filter((v) => v.state === 'UNREADABLE').length,
    groups: groups.filter((g) => g.state === 'UNREADABLE').length,
  };
}

/**
 * The closing lines: what the states mean, then the verdict in one sentence,
 * always last (review of #1051: the runbook's success test reads the last
 * line, and a notice printed after the verdict made a healthy run read as
 * unclear).
 */
function summaryLines(verdicts, groups, stale) {
  const failing =
    verdicts.filter((v) => FAILING.has(v.state)).length +
    groups.filter((g) => FAILING_GROUP.has(g.state)).length +
    stale.length;
  const unread = unreadCounts(verdicts, groups);
  const lines = [];
  if (verdicts.some((v) => v.state === 'NOT AUTHORIZED') || groups.some((g) => g.state === 'NOT AUTHORIZED')) {
    lines.push(
      '',
      '`NOT AUTHORIZED` means this identity could not read that resource group, so the state of the rules in it ' +
        'is unknown; it is not the same finding as `MISSING`. The Detail column says why, and `infra/oidc.tf` ' +
        'holds the grants of `github_reader`, the identity this workflow signs in as.'
    );
  }
  if (verdicts.some((v) => v.state === 'UNHEALTHY')) {
    lines.push(
      '',
      '`UNHEALTHY` means Azure Monitor reports the rule cannot evaluate: its Resource Health is Unavailable or ' +
        'Degraded, with Azure\'s title first in the Detail column. A rule in that state pages nobody, whatever it is ' +
        'meant to catch, however live and wired it is. `Semantic error` and `Syntax error` mean the query itself; run ' +
        'it under the rule\'s scope → **Logs** to see the error.'
    );
  }
  if (verdicts.some((v) => v.state === 'HEALTH UNREADABLE' || healthUnread(v))) {
    lines.push(
      '',
      '`HEALTH UNREADABLE` means the rule was read and its Resource Health was not, so whether it can evaluate is ' +
        '**unknown**, never healthy. The Detail column says why; the one-time owner steps (registering ' +
        '`Microsoft.ResourceHealth`, updating *HCW Alert Rule Reader*) are under "Resource Health" in ' +
        '`docs/runbooks/alerting-and-support.md`.'
    );
  }
  for (const subscription of stale) {
    lines.push(
      '',
      `**STALE RECORD: \`${subscription}\` is readable by this workflow now**, so its \`UNREADABLE\` entry in ` +
        '`scripts/verify-alert-state.mjs` no longer describes it. This fails the run until the entry is deleted, ' +
        'so the exception cannot outlive the gap it recorded and quietly excuse a later refusal.'
    );
  }
  lines.push('', verdictLine(failing, unread, verdicts.filter((v) => v.state === 'ABSENT').length));
  return lines;
}

/**
 * The verdict sentence. "Every expected rule" only when nothing is unknown:
 * an UNREADABLE rule or group, and an ABSENT rule whose gate GATES does not
 * record, are each named instead (review of #1051), because "not a finding"
 * and "known to be fine" are different results.
 */
export function verdictLine(failing, unread, absent) {
  if (failing > 0) return `**${failing} finding(s).** Each is named in the State column or the paragraphs above.`;
  if (unread.rules + unread.groups + absent === 0) {
    return '**Every expected rule is live, enabled and wired to its action group.**';
  }
  const unknown = [];
  if (unread.rules + unread.groups > 0) {
    unknown.push(
      `${unread.rules} rule(s) and ${unread.groups} action group(s) are in a subscription it cannot read yet, ` +
        'recorded in `UNREADABLE`'
    );
  }
  if (absent > 0) {
    unknown.push(`${absent} rule(s) are absent behind a \`count\` gate \`GATES\` does not record, so whether they should exist is unknown`);
  }
  return `**Every rule this identity can read and judge is live, enabled and wired.** ${unknown.join('; ')}: their state is **unknown**, not healthy.`;
}

/** The job-summary report: one row per rule, one per action group, then the verdict. */
export function renderReport({ rules, verdicts, extra, groups, when, subscriptionsRead, stale = [] }) {
  const lines = ['## Alert rule state', ''];
  const where = new Set(rules.map((r) => `\`${r.resourceGroup}\` (${r.subscription})`));
  lines.push(
    `Read ${when}. ${rules.length} rules are declared in \`infra/\`, across ${[...where].join(' and ')}. ` +
      'The list is derived from the configuration on every run, so a rule added there is checked here from the commit that adds it.',
    ''
  );
  if (subscriptionsRead && subscriptionsRead.status !== 'ok') {
    lines.push(`**The subscription list could not be read** (${subscriptionsRead.reason}), so nothing below is known.`, '');
  } else if (subscriptionsRead?.namedOnly) {
    lines.push(
      `The subscription list could not be read (${subscriptionsRead.reason}). The subscriptions were taken from ` +
        '`ALERT_SUBSCRIPTION_IDS`, and each rule below is judged on its own read.',
      ''
    );
  }
  lines.push('| Rule | Resource group | State | Enabled | autoMitigate | Every | Window | Sev | Health | Detail |');
  lines.push('| --- | --- | --- | :---: | :---: | --- | --- | :---: | --- | --- |');
  for (const v of verdicts) {
    const l = v.live ?? {};
    const detail = tableCell([...v.problems, ...v.notes].join('; '));
    lines.push(
      `| \`${v.rule.name}\` | \`${v.rule.resourceGroup}\` | **${v.state}** | ${cell(l.enabled)} | ${cell(l.autoMitigate)} | ` +
        `${cell(l.evaluationFrequency)} | ${cell(l.windowSize)} | ${cell(l.severity)} | ${cell(v.health)} | ${detail || ''} |`
    );
  }
  lines.push('', '### Action groups', '', '| Action group | Resource group | State | Receivers | Detail |', '| --- | --- | --- | --- | --- |');
  for (const g of groups) {
    const receivers = g.read?.receivers?.map((r) => `${r.kind} \`${tableCell(r.name)}\` ${tableCell(r.status)}`).join(', ') ?? '—';
    lines.push(`| \`${g.group.name}\` | \`${g.group.resourceGroup}\` | **${g.state}** | ${receivers} | ${tableCell(g.problems.join('; '))} |`);
  }
  if (extra.length > 0) {
    lines.push('', '### Live rules no declaration names', '');
    lines.push('These page if they fire, and nothing in `infra/` manages them. Not a failure; delete or declare them.', '');
    for (const { rule } of extra) lines.push(`- \`${rule.name}\` (${rule.armType}, enabled ${rule.enabled})`);
  }
  lines.push(...summaryLines(verdicts, groups, stale));
  return `${lines.join('\n')}\n`;
}

/**
 * Whether a run with these verdicts fails. UNREADABLE and gated-off rules do
 * not; a stale UNREADABLE entry does, so it is deleted with the grant.
 */
export function runFails(verdicts, groups, subscriptionsRead, stale = []) {
  if (subscriptionsRead?.status !== 'ok') return true;
  if (stale.length > 0) return true;
  return verdicts.some((v) => FAILING.has(v.state)) || groups.some((g) => FAILING_GROUP.has(g.state));
}

/**
 * The `coverage` step output for automated consumers: `complete` when every
 * declared rule and action group was read, `partial` when any was not
 * (UNREADABLE, NOT AUTHORIZED, READ FAILED or HEALTH UNREADABLE).
 * A green run with partial coverage is not the same result as a green run
 * with complete coverage, and a reader of the run's outcome alone cannot tell.
 */
export function coverageOf(verdicts, groups) {
  // Any rule or group not actually read is partial coverage, recorded or not
  // (review of #1051): a failing run that read half the estate must not say
  // `complete` to a consumer that reads only this output.
  const unread = (state) => NOT_READ.has(state);
  // A rule's health is read apart from the rule, and the state shows only the
  // first finding, so a DISABLED rule whose health was not read would
  // otherwise count as read (CodeRabbit on #1195).
  return verdicts.some((v) => unread(v.state) || healthUnread(v)) || groups.some((g) => unread(g.state))
    ? 'partial'
    : 'complete';
}

/** True when the rule was read and its Resource Health was not, whatever finding the state shows first. */
function healthUnread(verdict) {
  return verdict.health === 'unread';
}

/**
 * GitHub Actions warning annotations, one per subscription recorded as
 * unreadable, so a green run still shows the gap on its summary page.
 */
export function unreadableWarnings(verdicts, groups, unreadable = UNREADABLE) {
  const bySubscription = new Map();
  for (const v of verdicts.filter((x) => x.state === 'UNREADABLE')) {
    bySubscription.set(v.rule.subscription, (bySubscription.get(v.rule.subscription) ?? 0) + 1);
  }
  for (const g of groups.filter((x) => x.state === 'UNREADABLE')) {
    if (!bySubscription.has(g.group.subscription)) bySubscription.set(g.group.subscription, 0);
  }
  return [...bySubscription].map(
    ([subscription, count]) =>
      `::warning title=Alert rules not readable::${count} declared rule(s) in ${subscription} were not read: ` +
      `${unreadable[subscription]?.record ?? 'not recorded'}. Their state is unknown.`
  );
}

/** The declared inventory as a table, for --list. */
export function renderInventory(rules, suffix) {
  const lines = ['| Rule | Kind | Resource group | Subscription | Gate | Action group |', '| --- | --- | --- | --- | --- | --- |'];
  for (const r of rules) {
    const gate = r.gate ? (r.gate.variable ? `var.${r.gate.variable}` : r.gate.expression) : '';
    lines.push(
      `| \`${shortName(r, suffix)}\` | ${r.kind} | \`${r.resourceGroup}\` | \`${r.subscription}\` | ${gate} | ` +
        `${r.actionGroups.map((g) => `\`${g.name}\``).join(', ')} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

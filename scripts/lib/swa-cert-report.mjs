/**
 * The words of scripts/check-swa-certificates.mjs (#1929): the console
 * lines, the Markdown report for the job summary and the issue, and the
 * hidden state line the workflow compares.
 *
 * A verdict carries fixed reason codes (REASONS below), never text from the
 * certificate, so the state line is the script's own words. The only far-end
 * text in the report (the issuer, the names a certificate covers, a network
 * error) goes through `quoted`, which cleans it and puts it in a code span.
 */

export const WARN_DAYS = 30;
export const ACT_DAYS = 14;
export const RUNBOOK_URL =
  'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/proxy-site-hosts.md';
/** The runbook section that says what to do; a test holds it to a real heading. */
export const GOING_BACK_URL = `${RUNBOOK_URL}#going-back`;

/**
 * Text that came from the far end, made safe for one Markdown table cell in
 * a public issue: no line breaks, pipes, backticks or angle brackets, and
 * none of the characters GitHub turns into a link, an image, a mention or an
 * issue reference (`@ [ ] ( ) ! #`, and `\`, which escapes), at most 200
 * characters. No cleaned value can start a line, so nothing the certificate
 * says can pose as the state line.
 */
export function clean(value) {
  const text = String(value ?? '')
    .replace(/[\r\n\t|`<>@[\]()!#\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/**
 * Far-end text, cleaned and put in a code span, so GitHub shows it as it is
 * and makes no link of it (a bare `https://` address included). `clean`
 * removes backticks, so the text cannot close the span early. Empty is `—`.
 */
export function quoted(value) {
  const text = clean(value);
  return text ? `\`${text}\`` : '—';
}

/** Every reason code, with its plain words. `r` is the verdict, `w` the warning window in days. */
export const REASONS = Object.freeze({
  expiring: (r, w) => `it ends in ${r.daysLeft} day(s), within ${w}`,
  expired: () => 'it has expired',
  'not-yet-valid': () => 'it is not valid yet',
  'name-mismatch': (r) => `it does not cover ${r.name}`,
  untrusted: () => 'its chain does not lead to a trusted certificate authority',
  'bad-date': () => 'its end date could not be read',
  unreadable: (r) => `could not be read: ${quoted(r.detail)}`,
});

const VERDICT = { ok: 'good', action: 'NEEDS ACTION', unreadable: 'COULD NOT READ' };

/** The plain reasons of one verdict. */
export function problems(r, warnDays = WARN_DAYS) {
  return r.reasons.map((code) => REASONS[code](r, warnDays));
}

/**
 * The hidden last line of the report: each name with its stage, its reason
 * codes and its end date. The workflow comments on the open issue only when
 * this line differs from the last one it posted, so the same news is not
 * repeated, but a new stage, a new reason or a renewal is posted.
 */
export function stateLine(results) {
  const parts = results.map((r) => {
    const date = r.notAfter ? `:${r.notAfter.slice(0, 10)}` : '';
    return `${r.name}=${r.stage}/${r.reasons.join('+') || 'none'}${date}`;
  });
  return `<!-- swa-cert-check state: ${parts.join(' ')} -->`;
}

/** One line for the console per name. */
export function consoleLine(r, warnDays = WARN_DAYS) {
  const why = r.reasons.length ? ` (${problems(r, warnDays).join('; ')})` : '';
  if (!r.notAfter) return `${r.name}: ${VERDICT[r.status]}${why}`;
  return `${r.name}: ${VERDICT[r.status]}, issuer ${r.issuer || 'unknown'}, ends ${r.notAfter.slice(0, 10)}, ${r.daysLeft} day(s) left${why}`;
}

/** One table row. */
function row(r, warnDays) {
  const verdict = `${VERDICT[r.status]}${r.reasons.length ? `: ${problems(r, warnDays).join('; ')}` : ''}`;
  const covers = quoted((r.altNames ?? []).join(', ') || r.subject);
  const ends = r.notAfter ? r.notAfter.slice(0, 10) : '—';
  return `| ${r.name} | ${quoted(r.issuer)} | ${covers} | ${ends} | ${r.daysLeft ?? '—'} | ${verdict} |`;
}

const READY_CHECK =
  "check both names are **Ready** with the runbook's `az staticwebapp hostname list` line (Part 3, step 1, check 5)";

/** What to do, one paragraph per kind of problem, in this order. */
const STEPS = [
  {
    reasons: ['expiring', 'expired'],
    text: ({ warnDays }) =>
      `- **Ending within ${warnDays} days, or ended.** Azure renews these certificates by itself while the names point straight at it. If the names are proxied by Cloudflare (\`site_proxied_hosts\` is \`www\` or \`both\` in the [hcw-azure workspace variables](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables)), Azure may not renew them. At ${ACT_DAYS} days or less, or once one has ended, follow [Going back](${GOING_BACK_URL}) in the runbook: set \`site_proxied_hosts\` to \`none\`, wait until this check shows a new end date, then set it back. Each change is one checked Terraform run, as the runbook describes. If the names are not proxied, Azure should renew on its own; ${READY_CHECK}.`,
  },
  {
    reasons: ['name-mismatch'],
    text: () =>
      `- **Does not cover the name.** Azure answered with a certificate for another name, which usually means the custom name is no longer bound to the Static Web App; ${READY_CHECK}. Under Full (strict) Cloudflare refuses such a certificate with error 526.`,
  },
  {
    reasons: ['untrusted', 'not-yet-valid'],
    text: () =>
      "- **Not trusted, or not valid yet.** Cloudflare's Full (strict) would refuse it too (error 526). Give the run to a session.",
  },
  {
    reasons: ['unreadable', 'bad-date'],
    text: ({ host }) =>
      `- **Could not read.** Nothing was judged for that name. A one-off network failure clears on the next daily run. If it repeats, check that \`${host}\` is still the Static Web App's default host (Azure portal, the app's Overview page, URL); if it changed, set the \`STATIC_WEB_APP_DEFAULT_HOSTNAME\` repository variable to the new one.`,
  },
];

/** The "What to do" section for the results in hand. */
export function nextSteps(results, { host, warnDays = WARN_DAYS }) {
  const found = new Set(results.flatMap((r) => r.reasons));
  if (found.size === 0) return [`Both certificates are good for more than ${warnDays} days. Nothing to do.`];
  const steps = STEPS.filter((s) => s.reasons.some((code) => found.has(code))).map((s) => s.text({ host, warnDays }));
  return [
    '### What to do',
    '',
    ...steps,
    '',
    `Runbook: [Proxying the site's own names through Cloudflare](${RUNBOOK_URL}), Part 2 step 4 and "Going back".`,
  ];
}

/** The Markdown the workflow writes to the job summary and the issue. */
export function renderMarkdown(results, { host, now = Date.now(), warnDays = WARN_DAYS } = {}) {
  return [
    '## Static Web App certificates',
    '',
    `Read ${new Date(now).toISOString().slice(0, 16)}Z from \`${host}\` (Azure directly, not through Cloudflare), asking for each name, with the normal certificate checks on. Action is needed at ${warnDays} days or less, or when a certificate is refused; the runbook's going-back step is due at ${ACT_DAYS}.`,
    '',
    '| Name | Issuer | Names it covers | Ends (UTC) | Days left | Verdict |',
    '| --- | --- | --- | --- | --- | --- |',
    ...results.map((r) => row(r, warnDays)),
    '',
    ...nextSteps(results, { host, warnDays }),
    '',
    stateLine(results),
    '',
  ].join('\n');
}

/**
 * The offline half of the weekly AWS and Google Cloud module pin check
 * (#1869). Everything here is plain data in, plain data out: no network, no
 * files. check-cloud-module-pins.mjs does the fetching and hands the answers
 * to these functions, and check-cloud-module-pins.test.js tests them with
 * made-up registry answers.
 *
 * A "pin" is one entry of AWS_MODULES or GCP_MODULES: a registry source such
 * as `terraform-aws-modules/vpc/aws` and the exact release the Landing Zone
 * Builder writes into the Terraform it hands out.
 */

export * from './cloud-module-pins-versions.mjs';
/**
 * The exit code for a set of results: 1 when any pin is not a published
 * release, else 2 when any could not be checked, else 0. A newer release
 * is news, not a failure.
 */
export function exitCodeFor(results) {
  if (results.some((r) => r.status === 'missing')) return 1;
  if (results.some((r) => r.status === 'error')) return 2;
  return 0;
}

// Text from the registry and from a module's versions.tf goes into an issue
// body. Keep only what a version constraint or a source name can hold, so a
// backtick cannot break the formatting and an @name cannot notify anyone.
const clean = (value) => String(value).replace(/[^0-9A-Za-z .,<>=~!/:_-]/g, '');
const code = (value) => (value === null || value === undefined ? '(none)' : `\`${clean(value)}\``);

/** One line per pin, in plain words, for the log. */
export function logLines(results) {
  return results.map((r) => {
    const where = `${r.cloud} ${r.key} (${r.source} ${r.version})`;
    if (r.status === 'missing') return `FAIL  ${where}: ${r.message}`;
    if (r.status === 'error') return `ERROR ${where}: ${r.message}`;
    const notes = [...(r.warnings ?? [])];
    return notes.length ? `WARN  ${where}: ${notes.join(' ')}` : `OK    ${where}`;
  });
}

/**
 * The Markdown report the workflow puts in the run summary and, on a failed
 * scheduled run, in the issue.
 */
export function summarize(results, { checkedOn } = {}) {
  const exit = exitCodeFor(results);
  const headline = {
    0: 'Every AWS and Google Cloud module pin is a published release.',
    1: '**A pinned release is not published.** `terraform init` fails on the Terraform the builder hands out until the pin is fixed.',
    2: '**The check could not finish**, so some pins were not checked. This is not a verdict on the pins; see the lines below and run it again.',
  }[exit];
  const lines = [
    '## AWS and Google Cloud module pins',
    '',
    checkedOn ? `Checked against registry.terraform.io on ${checkedOn}.` : null,
    '',
    headline,
    '',
    '| Cloud | Pin | Source | Pinned | Newest | Result |',
    '| --- | --- | --- | --- | --- | --- |',
  ].filter((line) => line !== null);
  for (const r of results) {
    const result = {
      missing: `not published: ${r.message}`,
      error: `not checked: ${r.message}`,
      ok: r.newer ? 'published; a newer release exists' : 'published, newest',
    }[r.status];
    lines.push(
      `| ${r.cloud} | ${r.key} | \`${r.source}\` | ${code(r.version)} | ${code(r.newest)} | ${result} |`
    );
  }
  const warned = results.filter((r) => r.status === 'ok' && r.warnings?.length);
  if (warned.length) {
    lines.push('', '### Worth a look (not failures)', '');
    for (const r of warned) {
      for (const w of r.warnings) lines.push(`- **${r.cloud} ${r.key}:** ${w}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The warning text for a newer release, with what its versions.tf asks for. */
export function newerWarning({ version, newest, drift, unread }) {
  const base = `${newest} is newer than the pinned ${version}.`;
  if (unread) return `${base} ${unread}`;
  if (!drift.length) {
    return `${base} Its root versions.tf asks for the same as the recorded \`requires\`.`;
  }
  const parts = drift.map(
    (d) => `${d.what}: recorded ${code(d.recorded)}, ${newest} asks ${code(d.read)}`
  );
  return `${base} Its versions.tf differs from the recorded \`requires\` (${parts.join('; ')}). Read the release before moving the pin; the recorded value also counts the submodules it calls.`;
}

/**
 * Writes .github/lab-image-scan-waivers.yaml, the reviewed list of image findings the
 * weekly lab supply-chain scan sets aside until a date (#1650).
 *
 * WHY THIS EXISTS. The scan in .github/workflows/lab-supply-chain.yml fails
 * on any HIGH or CRITICAL vulnerability with a fix available. Most of what it
 * finds lives inside other people's software that the lab images carry: the
 * Go code compiled into a Terraform provider, helm or kubeconform, the Python
 * libraries the Azure CLI ships, a Debian package in the base image. When the
 * maker has not released a fixed build yet, there is nothing this repository
 * can change, and the report issue could never close. The owner decided on
 * 2026-11-12 (#1650) to set such findings aside for a fixed time, each with
 * the maker it waits on, rather than leave the issue open for ever.
 *
 * A waiver is one finding id in one place (a file path, or for a package with
 * no path, its package URL at that exact version), so a NEW finding, the same
 * finding in another place, or a newer provider (whose path carries its
 * version) is not covered and reopens the issue. Trivy stops applying an
 * entry from its `expired_at` date (00:00 UTC), so every waiver is looked at
 * again by then.
 *
 * It refuses a finding it cannot name a maker for: a waiver without a reason
 * is not written. Add a rule to MAKERS, with the reason, instead.
 *
 * Usage, from the repository root, with the Trivy JSON reports of the images
 * the workflow scans (the same flags as the workflow: --severity
 * HIGH,CRITICAL --ignore-unfixed --format json):
 *
 *   node scripts/lab/scan-waivers.mjs --checked "$(date -u +%F)" --expires "$(date -u -d '+30 days' +%F)" runner.json full.json sandbox.json > waivers.yaml
 *
 * Then read the diff before committing it: every line is a decision.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Who must ship the fix, by where the finding was found. First match wins. */
export const MAKERS = [
  {
    match: /^opt\/terraform\/mirror\/registry\.terraform\.io\/azure\/(alz|azapi|modtm)\/([^/]+)\//,
    reason: (m) => `Waits on Microsoft: Terraform provider Azure/${m[1]} ${m[2]} is its newest release and was built with these Go modules.`,
  },
  {
    match: /^opt\/terraform\/mirror\/registry\.terraform\.io\/hashicorp\/(azurerm|random|time)\/([^/]+)\//,
    reason: (m) => `Waits on HashiCorp: Terraform provider hashicorp/${m[1]} ${m[2]} is the newest release of its line and was built with these Go modules.`,
  },
  { match: /^usr\/local\/bin\/helm$/, reason: () => 'Waits on the Helm project: the pinned helm is its newest release and was built with these Go modules.' },
  { match: /^usr\/local\/bin\/kubeconform$/, reason: () => 'Waits on kubeconform: the pinned release is its newest and was built with these Go modules.' },
  { match: /^usr\/local\/bin\/kubectl$/, reason: () => 'Waits on the Kubernetes project: the pinned kubectl is its newest release and was built with these Go modules.' },
  {
    match: /^opt\/az\/lib\/python[^/]+\/site-packages\/(cryptography|oauthlib)-/,
    reason: (m) => `Waits on Microsoft: the Azure CLI ships ${m[1]} itself, its pinned version is the newest CLI, and lab-image/versions.env explains why ${m[1]} cannot be replaced on its own.`,
  },
  { match: /^pkg:pypi\/setuptools@/, reason: () => "Waits on pip: this setuptools is pip's own bundled copy, and no pip release newer than the pinned one carries a fixed copy yet." },
  {
    match: /^pkg:deb\/debian\/zlib1g@/,
    reason: () =>
      'Waits on Docker by choice: Debian has fixed zlib1g and the pinned python slim base has not been republished with it; the lab image could upgrade it itself, as the sandbox template does for four packages, and #1700 tracks doing that.',
  },
  {
    match: /^(usr\/bin\/(gh|pebble)|usr\/libexec\/docker\/cli-plugins\/docker-(buildx|compose))$/,
    reason: () => "Waits on Docker: this program comes with the docker/sandbox-templates base image of the sandbox template, and the pinned base digest is Docker's newest.",
  },
];

/** A package URL without its qualifiers (`?arch=…`), which vary by build and are not part of the identity. */
export const purlWithoutQualifiers = (purl) => String(purl ?? '').split('?')[0];

/**
 * Where a finding is: the file it was found in (a Go program's path, a Python
 * package's METADATA), or, for a package with no path, its package URL at its
 * exact version, so the waiver ends when the version changes.
 */
export function placeOf(result, vuln) {
  if (vuln.PkgPath) return { kind: 'paths', value: vuln.PkgPath };
  if (result.Type === 'gobinary') return { kind: 'paths', value: result.Target };
  const purl = purlWithoutQualifiers(vuln.PkgIdentifier?.PURL);
  if (!purl) throw new Error(`${vuln.VulnerabilityID} in ${result.Target} (${vuln.PkgName}) has neither a path nor a package URL`);
  return { kind: 'purls', value: purl };
}

/** The reason for one place, or null when no rule names a maker. */
export function reasonFor(place) {
  for (const rule of MAKERS) {
    const m = place.value.match(rule.match);
    if (m) return rule.reason(m);
  }
  return null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The waiver entries for the findings in these Trivy reports: one per finding
 * id and reason, listing every place it waits on that maker in. Throws on a
 * finding no rule explains.
 */
export function waiversFrom(reports, { expires, checked }) {
  if (!DATE.test(expires ?? '') || !DATE.test(checked ?? '')) throw new Error('--expires and --checked must be YYYY-MM-DD dates');
  const entries = new Map();
  const unexplained = new Set();
  for (const report of reports) {
    for (const result of report.Results ?? []) {
      for (const vuln of result.Vulnerabilities ?? []) {
        const place = placeOf(result, vuln);
        const reason = reasonFor(place);
        if (!reason) {
          unexplained.add(`${vuln.VulnerabilityID} in ${place.value}`);
          continue;
        }
        const statement = `${reason} Checked ${checked}.`;
        const key = `${vuln.VulnerabilityID}\u0000${statement}`;
        const entry = entries.get(key) ?? { id: vuln.VulnerabilityID, paths: new Set(), purls: new Set(), statement };
        entry[place.kind].add(place.value);
        entries.set(key, entry);
      }
    }
  }
  if (unexplained.size > 0) {
    throw new Error(`no maker is named for ${unexplained.size} finding(s); add a rule to MAKERS with its reason:\n  ${[...unexplained].sort().join('\n  ')}`);
  }
  return [...entries.values()]
    .map((e) => ({ id: e.id, paths: [...e.paths].sort(), purls: [...e.purls].sort(), statement: e.statement, expired_at: expires }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.statement.localeCompare(b.statement));
}

/** The YAML Trivy reads with --ignorefile. Strings are JSON-quoted, which YAML reads as double-quoted scalars. */
export function renderYaml(entries, { expires, checked }) {
  const q = (s) => JSON.stringify(s);
  const lines = [
    '# Reviewed waivers for the weekly lab image scan (.github/workflows/lab-supply-chain.yml, #1650).',
    '# Each entry sets aside one finding in the places listed, until expired_at, because the',
    "# fix waits on the software's maker (the statement names who). A new finding, the same",
    '# finding anywhere else, or a waiver past its date counts again and reopens the report issue.',
    `# Written by scripts/lab/scan-waivers.mjs on ${checked}; every entry expires ${expires}.`,
    '# Renew by rerunning it on fresh scans and reading the diff: docs/runbooks/labs-host.md,',
    '# "Image findings that wait on their maker".',
    'vulnerabilities:',
  ];
  for (const e of entries) {
    lines.push(`  - id: ${q(e.id)}`);
    for (const kind of ['paths', 'purls']) {
      if (e[kind].length === 0) continue;
      lines.push(`    ${kind}:`);
      for (const v of e[kind]) lines.push(`      - ${q(v)}`);
    }
    lines.push(`    statement: ${q(e.statement)}`);
    lines.push(`    expired_at: ${e.expired_at}`);
  }
  return `${lines.join('\n')}\n`;
}

export function parseArgs(argv) {
  const options = { expires: null, checked: null, files: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--expires') options.expires = argv[++i];
    else if (argv[i] === '--checked') options.checked = argv[++i];
    else options.files.push(argv[i]);
  }
  if (options.files.length === 0) throw new Error('give at least one Trivy JSON report');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const reports = options.files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
    process.stdout.write(renderYaml(waiversFrom(reports, options), options));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

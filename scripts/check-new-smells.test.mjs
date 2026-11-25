/**
 * The pull request smell check (#1845): scripts/check-new-smells.mjs and the [[triage]] reader it uses,
 * scripts/lib/qlty-triage.mjs. The workflow side (ci.yml's security-scan job) is held by ci-workflow-steps.test.mjs.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { annotation, newSmells, parseArgs, parseRenames, smellKey } from './check-new-smells.mjs';
import { globToRegExp, parseTriageBlocks, triage } from './lib/qlty-triage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-new-smells.mjs');
const QLTY_TOML = join(HERE, '..', '.qlty', 'qlty.toml');

/** A smell shaped like `qlty smells --json` prints one. */
function smell({ rule = 'function-complexity', path = 'src/a.js', message, line = 10, level = 'LEVEL_MEDIUM', others } = {}) {
  const duplication = rule === 'similar-code' || rule === 'identical-code';
  return {
    tool: 'qlty',
    driver: duplication ? 'duplication' : 'structure',
    ruleKey: rule,
    level,
    message: message || (duplication ? 'Found 20 lines of similar code in 2 locations (mass = 80)' : 'Function with high complexity (count = 20): doWork'),
    location: { path, range: { startLine: line, endLine: line + 20 } },
    ...(others ? { otherLocations: others.map((other) => ({ path: other, range: { startLine: 1, endLine: 20 } })) } : {}),
  };
}

describe('the [[triage]] reader', () => {
  const toml = [
    '# a comment with [[triage]] in it is not a block',
    '[[triage]]',
    'match.plugins = ["qlty"]',
    'match.rules = ["qlty:similar-code"]',
    'match.file_patterns = [',
    '  "data/table.js",',
    '  "pages/**/List.jsx",',
    ']',
    'set.ignored = true',
    '',
    '[[plugin]]',
    'name = "eslint"',
    '',
    '[[triage]]',
    'match.rules = ["qlty:function-complexity"]',
    'set.level = "low"',
  ].join('\n');
  const blocks = parseTriageBlocks(toml);

  it('reads each block, including an array that spans lines, and nothing from other tables', () => {
    expect(blocks).toEqual([
      {
        'match.plugins': ['qlty'],
        'match.rules': ['qlty:similar-code'],
        'match.file_patterns': ['data/table.js', 'pages/**/List.jsx'],
        'set.ignored': true,
      },
      { 'match.rules': ['qlty:function-complexity'], 'set.level': 'low' },
    ]);
  });

  it('ignores similar-code in a named file only', () => {
    expect(triage(blocks, smell({ rule: 'similar-code', path: 'data/table.js' })).ignored).toBe(true);
    expect(triage(blocks, smell({ rule: 'similar-code', path: 'data/other.js' })).ignored).toBe(false);
    expect(triage(blocks, smell({ rule: 'similar-code', path: 'data/table.jsx' })).ignored).toBe(false);
  });

  it('still reports every other smell in a named file', () => {
    expect(triage(blocks, smell({ rule: 'identical-code', path: 'data/table.js' })).ignored).toBe(false);
    expect(triage(blocks, smell({ rule: 'return-statements', path: 'data/table.js' }))).toEqual({
      ignored: false,
      level: 'medium',
    });
  });

  it('applies the first matching block, including a level change', () => {
    expect(triage(blocks, smell({ rule: 'function-complexity' }))).toEqual({ ignored: false, level: 'low' });
  });

  it('reads globs the way Qlty documents them', () => {
    expect(globToRegExp('pages/**/List.jsx').test('pages/List.jsx')).toBe(true);
    expect(globToRegExp('pages/**/List.jsx').test('pages/a/b/List.jsx')).toBe(true);
    expect(globToRegExp('*.js').test('a.js')).toBe(true);
    expect(globToRegExp('*.js').test('dir/a.js')).toBe(false);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});

describe('the data-table block in .qlty/qlty.toml (owner decision 2026-11-25, #1845)', () => {
  const blocks = parseTriageBlocks(readFileSync(QLTY_TOML, 'utf8'));
  const dataBlock = blocks.find((block) => (block['match.rules'] || []).includes('qlty:similar-code'));

  it('ignores similar-code only, in files named one by one', () => {
    expect(dataBlock, 'the data-table [[triage]] block is gone').toBeTruthy();
    expect(dataBlock['match.rules']).toEqual(['qlty:similar-code']);
    expect(dataBlock['set.ignored']).toBe(true);
    expect(dataBlock['match.file_patterns'].length).toBeGreaterThan(10);
    for (const pattern of dataBlock['match.file_patterns']) {
      expect(pattern, 'a wide glob would cover files nobody has looked at').not.toMatch(/[*?]/);
    }
  });

  it('leaves a logic smell in a named file, and similar code in an unnamed one, reported', () => {
    const named = dataBlock['match.file_patterns'][0];
    expect(triage(blocks, smell({ rule: 'similar-code', path: named })).ignored).toBe(true);
    expect(triage(blocks, smell({ rule: 'function-complexity', path: named })).ignored).toBe(false);
    expect(triage(blocks, smell({ rule: 'identical-code', path: named })).ignored).toBe(false);
    expect(triage(blocks, smell({ rule: 'similar-code', path: 'frontend/src/data/new-table.js' })).ignored).toBe(false);
  });

  it('names a reason for each file on the triage page', () => {
    const page = readFileSync(join(HERE, '..', 'docs', 'security', 'scanner-triage.md'), 'utf8');
    const at = page.indexOf('## Code smells in data and style tables');
    expect(at, 'the triage page has no data-table section').toBeGreaterThan(-1);
    const section = page.slice(at, page.indexOf('\n## ', at + 1));
    for (const file of dataBlock['match.file_patterns']) expect(section, file).toContain(`\`${file}\``);
  });
});

describe('what counts as a new smell', () => {
  it('treats deeper nesting of the same block as the same smell', () => {
    const base = [smell({ rule: 'nested-control-flow', message: 'Deeply nested control flow (level = 4)' })];
    const head = [smell({ rule: 'nested-control-flow', message: 'Deeply nested control flow (level = 5)' })];
    expect(smellKey(head[0])).toBe(smellKey(base[0]));
  });

  it('keeps a smell the base already had, even when it moved or grew', () => {
    const base = [smell({ line: 10, message: 'Function with high complexity (count = 16): doWork' })];
    const head = [smell({ line: 40, message: 'Function with high complexity (count = 25): doWork' })];
    expect(newSmells({ head, base, blocks: [] })).toEqual([]);
  });

  it('fails a smell in a function the base did not have', () => {
    const head = [smell({ message: 'Function with high complexity (count = 20): brandNew' })];
    expect(newSmells({ head, base: [smell()], blocks: [] })).toEqual(head);
  });

  it('fails a new copy of code, and not a copy that was already there', () => {
    const old = smell({ rule: 'similar-code', path: 'a.js', others: ['b.js'] });
    const grown = smell({ rule: 'similar-code', path: 'a.js', others: ['b.js', 'c.js'], message: 'Found 20 lines of similar code in 3 locations (mass = 90)' });
    expect(newSmells({ head: [old], base: [old], blocks: [] })).toEqual([]);
    expect(newSmells({ head: [grown], base: [old], blocks: [] })).toEqual([grown]);
  });

  it('follows a renamed file back to its old name', () => {
    const base = [smell({ path: 'old/name.js' })];
    const head = [smell({ path: 'new/name.js' })];
    const renames = parseRenames('M\0other.js\0R097\0old/name.js\0new/name.js\0C100\0a.js\0b.js\0D\0gone\tname.js\0');
    expect(renames.get('new/name.js')).toBe('old/name.js');
    expect([...renames.keys()]).toEqual(['new/name.js']);
    expect(newSmells({ head, base, blocks: [], renames })).toEqual([]);
    expect(newSmells({ head, base, blocks: [] })).toEqual(head);
  });

  it('counts smells whose key names no function: one on the base excuses one, not three', () => {
    const nested = (line) =>
      smell({ rule: 'nested-control-flow', line, message: 'Deeply nested control flow (level = 5)' });
    const flagged = newSmells({ head: [nested(5), nested(40), nested(90)], base: [nested(5)], blocks: [] });
    expect(flagged).toHaveLength(2);
  });

  it('counts two same-named functions in one file as two', () => {
    const fn = (line) => smell({ line, message: 'Function with high complexity (count = 20): handler' });
    expect(newSmells({ head: [fn(1), fn(50)], base: [fn(1)], blocks: [] })).toHaveLength(1);
    expect(newSmells({ head: [fn(1), fn(50)], base: [fn(1), fn(50)], blocks: [] })).toEqual([]);
  });

  it('lets a low smell through, and one set aside by triage', () => {
    const blocks = parseTriageBlocks('[[triage]]\nmatch.rules = ["qlty:similar-code"]\nmatch.file_patterns = ["a.js"]\nset.ignored = true\n');
    expect(newSmells({ head: [smell({ level: 'LEVEL_LOW' })], base: [], blocks: [] })).toEqual([]);
    expect(newSmells({ head: [smell({ rule: 'similar-code', path: 'a.js', others: ['b.js'] })], base: [], blocks })).toEqual([]);
    expect(newSmells({ head: [smell({ level: 'LEVEL_HIGH' })], base: [], blocks: [] })).toHaveLength(1);
  });

  it('keys a smell without its line or counts', () => {
    expect(smellKey(smell({ line: 3, message: 'Function with many returns (count = 7): f' }))).toBe(
      smellKey(smell({ line: 90, message: 'Function with many returns (count = 9): f' }))
    );
  });
});

describe('the command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'new-smells-'));
  const write = (name, value) => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
    return path;
  };
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const config = write('qlty.toml', 'config_version = "0"\n');

  it('exits 0 when nothing is new', () => {
    const result = run('--head', write('h0.json', [smell()]), '--base', write('b0.json', [smell()]), '--config', config);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No new medium or high code smell');
  });

  it('exits 1 with an annotation on the file and line of each new smell', () => {
    const result = run('--head', write('h1.json', [smell({ path: 'src/x.js', line: 7 })]), '--base', write('b1.json', '[]'), '--config', config);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('::error file=src/x.js,line=7,title=Code smell%3A function-complexity::');
    expect(result.stdout).toContain('1 new code smell in this pull request');
  });

  it('exits 2 on an empty smells file, which means a run that failed, not a clean one', () => {
    expect(run('--head', write('h-empty.json', ''), '--base', write('b-ok.json', '[]'), '--config', config).status).toBe(2);
    expect(run('--head', write('h-ok.json', '[]'), '--base', write('b-empty.json', ''), '--config', config).status).toBe(2);
    expect(run('--head', write('h-nl.json', '\n[]\n'), '--base', write('b-nl.json', '[]'), '--config', config).status).toBe(0);
  });

  it('exits 2 on wrong use or an unreadable file', () => {
    expect(run('--head', 'x').status).toBe(2);
    expect(run('--head', join(dir, 'missing.json'), '--base', join(dir, 'missing.json'), '--config', config).status).toBe(2);
    expect(() => parseArgs(['--head', 'a', '--base', 'b'])).toThrow(/usage/);
  });

  it('escapes what GitHub would read as the end of an annotation', () => {
    const line = annotation(smell({ path: 'a,b:c.js', message: 'two\nlines 100%' }));
    expect(line).toContain('file=a%2Cb%3Ac.js');
    expect(line).toContain('two%0Alines 100%25');
  });
});

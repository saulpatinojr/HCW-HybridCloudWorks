/**
 * The weekly floors updater (#715): which release each rule picks, when a
 * floor moves, and what it refuses to believe. The sources are fixtures in
 * the shape endoflife.date's v1 API and the Microsoft Learn page returned on
 * 2026-09-25, cut to the fields the updater reads.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SourceError,
  moveLockfileRange,
  moveManifestRange,
  movePins,
  proposeFloors,
  readFlexNodeLines,
  readRunnerUbuntuReleases,
  renderPullRequestBody,
  renderSummary,
  serialise,
} from './update-version-floors.mjs';
import { trackedFiles } from './version-floors.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TODAY = '2026-10-07';

const rel = (name, latest, extra = {}) => ({
  name,
  releaseDate: '2025-01-01',
  latest: latest ? { name: latest, date: '2026-09-01' } : null,
  ...extra,
});
const doc = (releases) => ({ schema_version: '1.2.0', result: { name: 'x', releases } });

/** The sources as they read on 2026-09-25, which the committed file records. */
function sourcesToday() {
  return {
    eol: {
      python: doc([rel('3.14', '3.14.7'), rel('3.13', '3.13.15')]),
      node: doc([
        rel('26', '26.10.0', { isLts: false, ltsFrom: '2026-10-28' }),
        rel('25', '25.9.0', { isLts: false, ltsFrom: null }),
        rel('24', '24.21.0', { isLts: true, ltsFrom: '2025-10-28' }),
        rel('22', '22.23.3', { isLts: true, ltsFrom: '2024-10-29' }),
      ]),
      ubuntu: doc([
        rel('26.04', '26.04.1', { codename: 'Resolute Raccoon', isLts: true }),
        rel('25.10', '25.10', { codename: 'Questing Quokka', isLts: false }),
        rel('24.04', '24.04.3', { codename: 'Noble Numbat', isLts: true }),
      ]),
      debian: doc([rel('13', '13.7', { codename: 'Trixie' }), rel('12', '12.15', { codename: 'Bookworm' })]),
      // As endoflife.date listed alpine-linux on 2026-09-28: 3.20 ended on
      // 2026-04-01, and 3.24 is supported to 2028-06-01.
      alpine: doc([
        rel('3.24', '3.24.2', { releaseDate: '2026-06-09', eolFrom: '2028-06-01' }),
        rel('3.23', '3.23.6', { releaseDate: '2025-12-04', eolFrom: '2027-11-01' }),
        rel('3.20', '3.20.10', { releaseDate: '2024-05-22', isEol: true, eolFrom: '2026-04-01' }),
      ]),
      terraform: doc([rel('1.16', '1.16.4'), rel('1.15', '1.15.9')]),
      // As endoflife.date listed it on 2026-09-26: majors only from their
      // general release, so 19 (19beta4 on Docker Hub that day) is absent.
      postgresql: doc([rel('18', '18.6'), rel('17', '17.11'), rel('16', '16.15')]),
      // As endoflife.date listed hashicorp-vault on 2026-09-26: 2.0 ended the
      // day 2.1 was released.
      vault: doc([
        rel('2.1', '2.1.1', { releaseDate: '2026-08-31', isMaintained: true }),
        rel('2.0', '2.0.4', { releaseDate: '2026-04-13', isMaintained: false, eolFrom: '2026-08-31' }),
        rel('1.21', '1.21.4', { releaseDate: '2025-10-21', isMaintained: false, eolFrom: '2026-04-13' }),
      ]),
    },
    flexNodeLines: [22, 24],
    // The x64 rows of the runner-images README on 2026-09-28: 26.04 had been
    // generally available since 2026-09-17.
    runnerUbuntuReleases: ['26.04', '24.04', '22.04'],
  };
}

/**
 * The floors file as it stood when sourcesToday() was written, frozen beside
 * it. Both halves of each comparison have to be frozen together: these tests
 * read "what the sources say" from fixtures, so reading "what the file
 * records" from the live scripts/version-floors.json made every move of a
 * floor a test failure. The updater's own first pull request (#999, python
 * 3.14.8 and terraform 1.16.5 on 2026-10-07) failed tests here for exactly
 * that reason, and so would every one after it. The live file's format is
 * still checked against serialise() below.
 */
const FROZEN_FLOORS = join(ROOT, 'scripts', 'fixtures', 'version-floors-2026-09-25.json');
const current = () => JSON.parse(readFileSync(FROZEN_FLOORS, 'utf8'));

describe('proposeFloors', () => {
  it('moves nothing when the sources say what the file already records', () => {
    const { changes, notes, next } = proposeFloors(current(), sourcesToday(), TODAY);
    expect(changes).toEqual([]);
    expect(notes).toEqual([]);
    expect(next).toEqual(current());
  });

  it('moves the newest patch and the N-2 floor with it, and dates only that entry', () => {
    const sources = sourcesToday();
    sources.eol.python.result.releases[0].latest.name = '3.14.9';
    const { changes, next } = proposeFloors(current(), sources, TODAY);
    expect(changes).toEqual([
      { kind: 'python', field: 'newest', from: '3.14.7', to: '3.14.9' },
      { kind: 'python', field: 'floor', from: '3.14.5', to: '3.14.7' },
    ]);
    expect(next.kinds.python.checkedOn).toBe(TODAY);
    expect(next.kinds.node.checkedOn).toBe(current().kinds.node.checkedOn);
  });

  it('adopts a new Python line only once its N-2 patch exists', () => {
    const early = sourcesToday();
    early.eol.python.result.releases.unshift(rel('3.15', '3.15.1'));
    expect(proposeFloors(current(), early, TODAY).next.kinds.python.line).toBe('3.14');

    const ready = sourcesToday();
    ready.eol.python.result.releases.unshift(rel('3.15', '3.15.2'));
    const { next } = proposeFloors(current(), ready, TODAY);
    expect([next.kinds.python.line, next.kinds.python.newest, next.kinds.python.floor]).toEqual(['3.15', '3.15.2', '3.15.0']);
  });

  it('moves Alpine to a newer patch release with its N-2 floor, and dates only that entry', () => {
    const sources = sourcesToday();
    sources.eol.alpine.result.releases[0].latest.name = '3.24.4';
    const { changes, next } = proposeFloors(current(), sources, TODAY);
    expect(changes).toEqual([
      { kind: 'alpine', field: 'newest', from: '3.24.2', to: '3.24.4' },
      { kind: 'alpine', field: 'floor', from: '3.24.0', to: '3.24.2' },
    ]);
    expect(next.kinds.alpine.checkedOn).toBe(TODAY);
    expect(next.kinds.debian.checkedOn).toBe(current().kinds.debian.checkedOn);
  });

  it('adopts a new Alpine line only once its N-2 patch exists', () => {
    const early = sourcesToday();
    early.eol.alpine.result.releases.unshift(rel('3.25', '3.25.1', { releaseDate: '2026-12-01' }));
    expect(proposeFloors(current(), early, '2027-01-15').next.kinds.alpine.line).toBe('3.24');

    const ready = sourcesToday();
    ready.eol.alpine.result.releases.unshift(rel('3.25', '3.25.2', { releaseDate: '2026-12-01' }));
    const { next } = proposeFloors(current(), ready, '2027-01-15');
    expect([next.kinds.alpine.line, next.kinds.alpine.newest, next.kinds.alpine.floor]).toEqual(['3.25', '3.25.2', '3.25.0']);
  });

  it('refuses an Alpine source that goes backwards, and writes nothing', () => {
    // 3.24.1 is below 3.24's N-2 patch, so the pick falls back a line.
    const sources = sourcesToday();
    sources.eol.alpine.result.releases[0].latest.name = '3.24.1';
    expect(() => proposeFloors(current(), sources, TODAY)).toThrow(/alpine: the source's line 3\.23 is older than the recorded 3\.24/);
  });

  it('skips a Node.js line that never becomes LTS, and adopts the next one at its N-2 minor', () => {
    const odd = sourcesToday();
    odd.eol.node.result.releases.unshift(rel('27', '27.4.0', { isLts: false, ltsFrom: null }));
    expect(proposeFloors(current(), odd, TODAY).next.kinds.node.line).toBe('26');

    const early = sourcesToday();
    early.eol.node.result.releases.unshift(rel('28', '28.1.0', { isLts: false, ltsFrom: '2028-10-24' }));
    expect(proposeFloors(current(), early, TODAY).next.kinds.node.line).toBe('26');

    const ready = sourcesToday();
    ready.eol.node.result.releases.unshift(rel('28', '28.2.0', { isLts: false, ltsFrom: '2028-10-24' }));
    const { next } = proposeFloors(current(), ready, TODAY);
    expect([next.kinds.node.line, next.kinds.node.floor]).toEqual(['28', '28.0.0']);
  });

  it('moves the functions ceiling when Flex Consumption lists a newer GA line, and says what that costs', () => {
    const sources = sourcesToday();
    sources.flexNodeLines = [22, 24, 26];
    const { next, notes } = proposeFloors(current(), sources, TODAY);
    const ceiling = next.kinds.node.platformCeilings.functions;
    expect([ceiling.line, ceiling.newest, ceiling.floor]).toEqual(['26', '26.10.0', '26.8.0']);
    expect(notes.join(' ')).toMatch(/runtime_version in infra\/functionapp\.tf/);
  });

  it('keeps the ceiling within the newest line the rule allows', () => {
    const sources = sourcesToday();
    sources.flexNodeLines = [24, 28];
    const ceiling = proposeFloors(current(), sources, TODAY).next.kinds.node.platformCeilings.functions;
    expect(ceiling.line).toBe('26');
  });

  it('leaves the ceiling alone, and says so, when the Learn table cannot be read', () => {
    const sources = sourcesToday();
    sources.flexNodeLines = null;
    const { next, notes } = proposeFloors(current(), sources, TODAY);
    expect(next.kinds.node.platformCeilings.functions.line).toBe('24');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/could not be read/);
  });

  it('moves the Ubuntu target to a new LTS and learns its codename, but never to an interim release', () => {
    const interim = sourcesToday();
    interim.eol.ubuntu.result.releases.unshift(rel('26.10', '26.10', { codename: 'Some Thing', isLts: false }));
    expect(proposeFloors(current(), interim, TODAY).changes).toEqual([]);

    const lts = sourcesToday();
    lts.eol.ubuntu.result.releases.unshift(rel('28.04', '28.04', { codename: 'Future Fox', isLts: true }));
    const { next } = proposeFloors(current(), lts, TODAY);
    expect(next.kinds.ubuntu.newest).toBe('28.04');
    expect(next.kinds.ubuntu.codenames.future).toBe('28.04');
  });

  /**
   * The runners ceiling. 26.04 went from Canonical's release on 2026-04-23 to
   * GitHub's preview on 2026-06-11 and general availability on 2026-09-17;
   * 28.04 is expected to follow the same path, and runs-on waits for the end
   * of it while the lab host moves at the start.
   */
  describe('the runners ceiling', () => {
    const withLts = (runners) => {
      const sources = sourcesToday();
      sources.eol.ubuntu.result.releases.unshift(rel('28.04', '28.04', { codename: 'Future Fox', isLts: true }));
      sources.runnerUbuntuReleases = runners;
      return sources;
    };

    it('stays put while GitHub does not offer the new LTS as generally available', () => {
      const { next, changes, notes } = proposeFloors(current(), withLts(['26.04', '24.04', '22.04']), TODAY);
      expect(next.kinds.ubuntu.newest).toBe('28.04');
      expect(next.kinds.ubuntu.platformCeilings.runners).toEqual(current().kinds.ubuntu.platformCeilings.runners);
      expect(changes.map((c) => c.kind)).not.toContain('ubuntu (runners ceiling)');
      expect(notes).toEqual([]);
    });

    it('moves to the new LTS when GitHub lists it as generally available, and says what that moves', () => {
      const { next, changes, notes } = proposeFloors(current(), withLts(['28.04', '26.04', '24.04']), TODAY);
      expect(next.kinds.ubuntu.platformCeilings.runners).toMatchObject({ newest: '28.04', floor: '28.04', checkedOn: TODAY });
      expect(changes.filter((c) => c.kind === 'ubuntu (runners ceiling)')).toEqual([
        { kind: 'ubuntu (runners ceiling)', field: 'newest', from: '26.04', to: '28.04' },
        { kind: 'ubuntu (runners ceiling)', field: 'floor', from: '26.04', to: '28.04' },
      ]);
      expect(notes.join(' ')).toMatch(/every runs-on in \.github\/workflows moves to ubuntu-28\.04/);
    });

    it('never passes the Ubuntu floor, and never takes an interim release', () => {
      const sources = sourcesToday();
      sources.runnerUbuntuReleases = ['28.04', '26.10', '26.04'];
      const { next, notes } = proposeFloors(current(), sources, TODAY);
      expect(next.kinds.ubuntu.platformCeilings.runners.newest).toBe('26.04');
      expect(notes).toEqual([]);
    });

    it('never moves down, and leaves a note for a human instead', () => {
      const sources = sourcesToday();
      sources.runnerUbuntuReleases = ['24.04', '22.04'];
      const { next, notes } = proposeFloors(current(), sources, TODAY);
      expect(next.kinds.ubuntu.platformCeilings.runners.newest).toBe('26.04');
      expect(notes).toEqual([
        'GitHub-hosted runners now list ubuntu-24.04, ubuntu-22.04 as generally available, none of them the recorded ceiling ubuntu-26.04 or a newer LTS; left unchanged for a human to read.',
      ]);
    });

    it('stays put, and says so, when the runner-images README cannot be read', () => {
      const sources = sourcesToday();
      sources.runnerUbuntuReleases = null;
      const { next, notes, changes } = proposeFloors(current(), sources, TODAY);
      expect(next.kinds.ubuntu.platformCeilings.runners.newest).toBe('26.04');
      expect(changes).toEqual([]);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toMatch(/image list could not be read/);
    });
  });

  it('moves PostgreSQL to a newer minor release with its N-2 floor', () => {
    const sources = sourcesToday();
    sources.eol.postgresql.result.releases[0].latest.name = '18.8';
    const { changes, next } = proposeFloors(current(), sources, TODAY);
    expect(changes).toEqual([
      { kind: 'postgresql', field: 'newest', from: '18.6', to: '18.8' },
      { kind: 'postgresql', field: 'floor', from: '18.4', to: '18.6' },
    ]);
    expect(next.kinds.postgresql.checkedOn).toBe(TODAY);
  });

  it('adopts a new PostgreSQL major only at its N-2 minor release', () => {
    const sources = sourcesToday();
    sources.eol.postgresql.result.releases.unshift(rel('19', '19.1'));
    expect(proposeFloors(current(), sources, TODAY).changes).toEqual([]);
    sources.eol.postgresql.result.releases[0].latest.name = '19.2';
    const { changes, next } = proposeFloors(current(), sources, TODAY);
    expect(changes).toEqual([
      { kind: 'postgresql', field: 'line', from: '18', to: '19' },
      { kind: 'postgresql', field: 'newest', from: '18.6', to: '19.2' },
      { kind: 'postgresql', field: 'floor', from: '18.4', to: '19.0' },
    ]);
    expect(next.kinds.postgresql).toMatchObject({ line: '19', newest: '19.2', floor: '19.0' });
  });

  it('never proposes a PostgreSQL beta, release candidate or unreleased major', () => {
    for (const pre of [
      rel('19', '19beta4'),
      rel('19', '19rc1'),
      rel('19', null),
      rel('19', '19.2', { releaseDate: '2027-09-23' }),
      rel('19beta4', '19beta4'),
    ]) {
      const sources = sourcesToday();
      sources.eol.postgresql.result.releases.unshift(pre);
      const { changes, next } = proposeFloors(current(), sources, TODAY);
      expect(changes, JSON.stringify(pre)).toEqual([]);
      expect(next.kinds.postgresql.newest).toBe('18.6');
    }
  });

  it('refuses a PostgreSQL newest release older than the recorded one', () => {
    const sources = sourcesToday();
    sources.eol.postgresql.result.releases[0].latest.name = '18.5';
    expect(() => proposeFloors(current(), sources, TODAY)).toThrow(/18\.5 is older than the recorded 18\.6/);
  });

  it('moves Vault to a newer patch release with its N-2 floor', () => {
    const sources = sourcesToday();
    sources.eol.vault.result.releases[0].latest.name = '2.1.3';
    const { changes, next } = proposeFloors(current(), sources, TODAY);
    expect(changes).toEqual([
      { kind: 'vault', field: 'newest', from: '2.1.1', to: '2.1.3' },
      { kind: 'vault', field: 'floor', from: '2.1.0', to: '2.1.1' },
    ]);
    expect(next.kinds.vault.checkedOn).toBe(TODAY);
  });

  it('adopts a new Vault line the day it is released, because the previous one ends that day', () => {
    const sources = sourcesToday();
    sources.eol.vault.result.releases.unshift(rel('2.2', '2.2.0', { releaseDate: TODAY }));
    const { changes, next } = proposeFloors(current(), sources, TODAY);
    expect(changes).toEqual([
      { kind: 'vault', field: 'line', from: '2.1', to: '2.2' },
      { kind: 'vault', field: 'newest', from: '2.1.1', to: '2.2.0' },
      { kind: 'vault', field: 'floor', from: '2.1.0', to: '2.2.0' },
    ]);
    expect(next.kinds.vault).toMatchObject({ line: '2.2', newest: '2.2.0', floor: '2.2.0' });
  });

  it('never proposes a Vault release candidate or an unreleased line', () => {
    for (const pre of [rel('2.2', '2.2.0-rc1'), rel('2.2', null), rel('2.2', '2.2.0', { releaseDate: '2027-01-01' })]) {
      const sources = sourcesToday();
      sources.eol.vault.result.releases.unshift(pre);
      const { changes, next } = proposeFloors(current(), sources, TODAY);
      expect(changes, JSON.stringify(pre)).toEqual([]);
      expect(next.kinds.vault.newest).toBe('2.1.1');
    }
  });

  it('refuses a Vault newest release older than the recorded one', () => {
    const sources = sourcesToday();
    sources.eol.vault.result.releases.shift();
    expect(() => proposeFloors(current(), sources, TODAY)).toThrow(/vault: the source's line 2\.0 is older than the recorded 2\.1/);
  });

  it('leaves the unsourced entries exactly as written', () => {
    const sources = sourcesToday();
    sources.eol.vault.result.releases[0].latest.name = '2.1.3';
    expect(proposeFloors(current(), sources, TODAY).next.unsourced).toEqual(current().unsourced);
  });

  it('does not count a release dated in the future', () => {
    const sources = sourcesToday();
    sources.eol.debian.result.releases.unshift(rel('14', null, { codename: 'Forky', releaseDate: '2027-06-01' }));
    expect(proposeFloors(current(), sources, TODAY).next.kinds.debian.newest).toBe('13');
  });

  it('refuses a source whose newest line is older than the recorded one', () => {
    const sources = sourcesToday();
    sources.eol.python.result.releases.shift();
    expect(() => proposeFloors(current(), sources, TODAY)).toThrow(SourceError);
    expect(() => proposeFloors(current(), sources, TODAY)).toThrow(/older than the recorded 3\.14/);
  });

  it('refuses a newest release older than the recorded one on the same line', () => {
    const sources = sourcesToday();
    sources.eol.terraform.result.releases[0].latest.name = '1.16.3';
    expect(() => proposeFloors(current(), sources, TODAY)).toThrow(/1\.16\.3 is older than the recorded 1\.16\.4/);
  });

  it('refuses a document without the v1 releases array', () => {
    const sources = sourcesToday();
    sources.eol.debian = { result: {} };
    expect(() => proposeFloors(current(), sources, TODAY)).toThrow(/no result\.releases array/);
  });
});

describe('readFlexNodeLines', () => {
  const page = (row) =>
    [
      '<h2 id="supported-language-stack-versions">Supported language stack versions</h2>',
      '<table><thead><tr><th>Language stack</th><th>Required version</th></tr></thead><tbody>',
      '<tr>\n<td>Java</td>\n<td style="text-align: center;">Java 21, Java 25</td>\n</tr>',
      row,
      '</tbody></table>',
      '<table><tr><td>Node.js</td><td>Node.js 99</td></tr></table>',
    ].join('\n');

  it('reads the lines from the Node.js row of that table and no other', () => {
    expect(readFlexNodeLines(page('<tr>\n<td>Node.js</td>\n<td style="text-align: center;">Node.js 22, Node.js 24</td>\n</tr>'))).toEqual([22, 24]);
  });

  it('skips a line marked preview', () => {
    expect(readFlexNodeLines(page('<tr><td>Node.js</td><td>Node.js 24, Node.js 26 (preview)</td></tr>'))).toEqual([24]);
  });

  it('returns null rather than guessing when the section or the row is missing', () => {
    expect(readFlexNodeLines('<html></html>')).toBe(null);
    expect(readFlexNodeLines(page(''))).toBe(null);
  });
});

describe('readRunnerUbuntuReleases', () => {
  const badge = (name) => `![Endpoint Badge](https://img.shields.io/endpoint?url=https%3A%2F%2Fgist.githubusercontent.com%2Fbot%2Fraw%2F${name}.json)`;
  const preview = '![preview](https://img.shields.io/badge/preview-0969DA?style=flat&logoColor=white)';
  /** The README's shape on 2026-09-28, cut to its Ubuntu rows, one macOS row and the section after. */
  const readme = (ubuntu2604 = `Ubuntu 26.04<br>${badge('ubuntu26')}`) =>
    [
      '# GitHub Actions Runner Images',
      '',
      '## Available Images',
      '',
      '| Image | Architecture | YAML Label | Included Software |',
      '| --------------------|--------------|---------------------|------------------|',
      `| ${ubuntu2604} | x64 | \`ubuntu-26.04\` | [ubuntu-26.04] |`,
      `| Ubuntu 26.04 Arm64<br>${badge('ubuntu26-arm64')} | arm64 | \`ubuntu-26.04-arm\` | [ubuntu-26.04-arm64] |`,
      `| Ubuntu 24.04<br>${badge('ubuntu24')} | x64 | \`ubuntu-latest\` or \`ubuntu-24.04\` | [ubuntu-24.04] |`,
      `| Ubuntu 22.04<br>${badge('ubuntu22')} | x64 | \`ubuntu-22.04\` | [ubuntu-22.04] |`,
      `| Ubuntu Slim<br>${badge('ubuntu-slim')} | x64 | \`ubuntu-slim\` | [ubuntu-slim] |`,
      `| macOS 26 Arm64<br>${badge('macos-26-arm64')} | arm64 | \`macos-latest\`, \`macos-26\` | [macOS-26-arm64] |`,
      '',
      '### Label scheme',
      '',
      '## Software and Image Support',
      '',
      '| Ubuntu | x64 | `ubuntu-30.04` | a row outside the image table |',
    ].join('\n');

  it('reads the x64 Ubuntu releases the image table lists, and nothing outside it', () => {
    expect(readRunnerUbuntuReleases(readme())).toEqual(['26.04', '24.04', '22.04']);
  });

  it('skips an image GitHub still marks preview or beta, as the 26.04 row was until 2026-09-17', () => {
    expect(readRunnerUbuntuReleases(readme(`Ubuntu 26.04 ${preview}<br>${badge('ubuntu26')}`))).toEqual(['24.04', '22.04']);
    expect(readRunnerUbuntuReleases(readme(`Ubuntu 26.04 ![beta](https://img.shields.io/badge/beta-x)<br>${badge('ubuntu26')}`))).toEqual([
      '24.04',
      '22.04',
    ]);
  });

  it('returns null rather than guessing when the section or its Ubuntu rows are missing', () => {
    expect(readRunnerUbuntuReleases('# GitHub Actions Runner Images\n')).toBe(null);
    expect(readRunnerUbuntuReleases('## Available Images\n\n| Image | Architecture | YAML Label |\n')).toBe(null);
    expect(readRunnerUbuntuReleases(null)).toBe(null);
  });
});

describe('the file and the summary', () => {
  it('serialises the floors exactly as the committed file is written', () => {
    const text = readFileSync(join(ROOT, 'scripts', 'version-floors.json'), 'utf8');
    expect(serialise(JSON.parse(text))).toBe(text);
  });

  it('lists each moved value, each pin moved with it, and each pin still behind', () => {
    const summary = renderSummary({
      today: TODAY,
      changes: [{ kind: 'node', field: 'floor', from: '26.8.0', to: '26.9.0' }],
      notes: ['a note'],
      moved: [{ file: 'scripts/package.json', line: 15, from: '>=26.8.0', to: '>=26.9.0', files: ['scripts/package.json', 'scripts/package-lock.json'] }],
      behind: [{ file: 'lab-host/bootstrap.sh', line: 48, where: 'lab-host/bootstrap.sh > python', message: 'below the floor' }],
    });
    expect(summary).toContain('| node | floor | 26.8.0 | 26.9.0 |');
    expect(summary).toContain('- a note');
    expect(summary).toContain('#### Pins moved with the floors');
    expect(summary).toContain('| `scripts/package.json:15` engines.node | `>=26.8.0` | `>=26.9.0` | `scripts/package.json`, `scripts/package-lock.json` |');
    expect(summary).toContain('#### Pins still behind the new floors');
    expect(summary).toContain('- `lab-host/bootstrap.sh:48` (lab-host/bootstrap.sh > python): below the floor');
  });

  it('says so plainly when nothing moved', () => {
    const summary = renderSummary({ today: TODAY, changes: [], notes: [], behind: [] });
    expect(summary).toContain('No floor moved.');
    expect(summary).toContain('#### Pins behind the floors');
    expect(summary).toContain('None.');
    expect(summary).not.toContain('Pins moved');
  });
});

describe('moving a range in its files', () => {
  /** A value as npm writes it. */
  const npm = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const manifest = { name: 'x', type: 'module', engines: { node: '>=26.8.0', npm: '>=10.0.0' }, dependencies: { a: '^1.0.0' } };
  /** The lines of `after` that differ from `before` at the same position. Split once: a lockfile runs to thousands of lines. */
  const changedLines = (before, after) => {
    const was = before.split('\n');
    return after.split('\n').filter((line, i) => line !== was[i]);
  };

  it('changes the engines.node line of a package.json and nothing else', () => {
    const before = npm(manifest);
    const after = moveManifestRange('x/package.json', before, '>=26.8.0', '>=26.9.0');
    expect(changedLines(before, after)).toEqual(['    "node": ">=26.9.0",']);
  });

  it("changes the lockfile's root entry and leaves a dependency recording the same range alone", () => {
    const lock = {
      name: 'x',
      lockfileVersion: 3,
      packages: { '': { name: 'x', engines: { node: '>=26.8.0' } }, 'node_modules/a': { version: '1.0.0', engines: { node: '>=26.8.0' } } },
    };
    const after = JSON.parse(moveLockfileRange('x/package-lock.json', npm(lock), '>=26.8.0', '>=26.9.0'));
    expect(after.packages[''].engines.node).toBe('>=26.9.0');
    expect(after.packages['node_modules/a'].engines.node).toBe('>=26.8.0');
  });

  it('refuses a file not in the form npm writes, rather than reformat it', () => {
    const fourSpaces = `${JSON.stringify(manifest, null, 4)}\n`;
    expect(() => moveManifestRange('x/package.json', fourSpaces, '>=26.8.0', '>=26.9.0')).toThrow(/not in the form npm writes/);
    expect(() => moveManifestRange('x/package.json', npm(manifest).trimEnd(), '>=26.8.0', '>=26.9.0')).toThrow(/not in the form npm writes/);
  });

  it('refuses a file whose range is not the one being moved', () => {
    expect(() => moveManifestRange('x/package.json', npm(manifest), '>=26.7.0', '>=26.9.0')).toThrow(/records engines.node ">=26.8.0", not ">=26.7.0"/);
    const bare = { packages: { '': { name: 'x' } } };
    expect(() => moveLockfileRange('x/package-lock.json', npm(bare), '>=26.8.0', '>=26.9.0')).toThrow(/records no engines.node, not ">=26.8.0"/);
  });

  // The weekly run must not meet a refusal: every package file it could move
  // is already in the form it writes, and moves one line.
  it('can move every tracked package.json and lockfile that records engines.node, one line each', () => {
    const files = trackedFiles(ROOT).filter((f) => /(^|\/)package(-lock)?\.json$/.test(f));
    const moved = files.flatMap((file) => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const value = JSON.parse(text);
      const lock = file.endsWith('package-lock.json');
      const range = lock ? value.packages?.['']?.engines?.node : value.engines?.node;
      if (range === undefined) return [];
      const after = (lock ? moveLockfileRange : moveManifestRange)(file, text, range, '>=99.0.0');
      expect(changedLines(text, after), file).toHaveLength(1);
      return [file];
    });
    expect(moved.length).toBeGreaterThanOrEqual(8);
  });
});

describe('moving a pin in its package and lockfile together', () => {
  const npm = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const floors = JSON.parse(readFileSync(join(ROOT, 'scripts', 'fixtures', 'version-floors-2026-09-25.json'), 'utf8'));
  Object.assign(floors.kinds.node, { newest: '26.11.1', floor: '26.9.0' });
  const root = join(ROOT, 'no-such-dir');
  const manifestPath = join(root, 'p', 'package.json');
  const lockPath = join(root, 'p', 'package-lock.json');
  const pin = { file: 'p/package.json', line: 3, where: 'p/package.json > engines.node', kind: 'node', raw: '>=26.8.0', range: '>=26.8.0' };
  const tracked = new Set(['p/package.json', 'p/package-lock.json']);

  /** An in-memory pair; `failOn` names the path whose write throws. */
  function disk(failOn) {
    const files = new Map([
      [manifestPath, npm({ name: 'p', engines: { node: '>=26.8.0' } })],
      [lockPath, npm({ packages: { '': { name: 'p', engines: { node: '>=26.8.0' } } } })],
    ]);
    const original = new Map(files);
    const io = {
      readFile: async (p) => files.get(p),
      writeFile: async (p, text) => {
        if (p === failOn) throw new Error(`EIO: ${p}`);
        files.set(p, text);
      },
    };
    return { files, original, io };
  }

  it('writes both, and reports the move with both files', async () => {
    const { files, io } = disk(null);
    const moved = await movePins(floors, [pin], { write: true, root, tracked, io });
    expect(moved).toEqual([{ file: 'p/package.json', line: 3, where: pin.where, from: '>=26.8.0', to: '>=26.9.0', files: ['p/package.json', 'p/package-lock.json'] }]);
    expect(JSON.parse(files.get(manifestPath)).engines.node).toBe('>=26.9.0');
    expect(JSON.parse(files.get(lockPath)).packages[''].engines.node).toBe('>=26.9.0');
  });

  it('puts the package.json back when the lockfile write fails, and reports no move (CodeRabbit on #1160)', async () => {
    const { files, original, io } = disk(lockPath);
    const moved = await movePins(floors, [pin], { write: true, root, tracked, io });
    expect(moved).toEqual([]);
    expect(files.get(manifestPath)).toBe(original.get(manifestPath));
    expect(files.get(lockPath)).toBe(original.get(lockPath));
  });

  it('writes nothing on a dry run, but still reports what would move', async () => {
    const { files, original, io } = disk(null);
    const moved = await movePins(floors, [pin], { write: false, root, tracked, io });
    expect(moved).toHaveLength(1);
    expect(files).toEqual(original);
  });
});

describe('the pull request body', () => {
  const template = readFileSync(join(ROOT, '.github', 'pull_request_template.md'), 'utf8');
  // The template less the section it says to drop when infrastructure is untouched.
  const kept = template.replace(/## Infrastructure changes only[\s\S]*?(?=\n## )/, '');
  /** The second-level headings, in order. */
  const headings = (text) => text.split('\n').filter((l) => l.startsWith('## '));
  const summary = renderSummary({ today: TODAY, changes: [{ kind: 'node', field: 'floor', from: '26.8.0', to: '26.9.0' }], notes: [], behind: [] });
  const runUrl = 'https://github.com/o/r/actions/runs/1';
  const body = (behind) => renderPullRequestBody({ summary, moved: [], behind, runUrl });

  it("has the template's sections, in its order, less the infrastructure one (CodeRabbit's Description check, #1152)", () => {
    expect(headings(body([]))).toEqual(headings(kept));
  });

  it('carries every checkbox the template asks, ticked or not, word for word', () => {
    const boxes = kept.split('\n').filter((l) => l.startsWith('- [ ] ')).map((l) => l.slice(6));
    expect(boxes.length).toBeGreaterThan(15);
    for (const box of boxes) expect(body([]), box).toMatch(new RegExp(`- \\[[ x]\\] ${box.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('carries the summary, the run and the issues', () => {
    const text = body([]);
    expect(text).toContain(summary.trim());
    expect(text).toContain(runUrl);
    expect(text).toContain('Refs #715 and #714.');
  });

  it('says the floors check is the evidence when every pin moved, and the work list when one did not', () => {
    expect(body([])).toContain('Every pin the new floors left behind moved in this pull request.');
    expect(body([])).not.toContain('expected to fail');
    const red = body([{ file: 'lab-host/bootstrap.sh', line: 48, where: 'w', message: 'm' }]);
    expect(red).toContain('This pull request is expected to fail `scripts (operations)` until the pins under "Pins still behind" move.');
    expect(red).toContain('`runtime_version`');
  });
});

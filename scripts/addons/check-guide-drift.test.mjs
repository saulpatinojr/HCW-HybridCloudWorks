/**
 * check-guide-drift.mjs (#1356): a guide that still matches the site passes, and each way it can stop matching
 * fails by name. The catalogue, the group_vars and the guide are small fixtures built here, so nothing reads the
 * network or the real files. The few command-line cases run the script as a child process, because the exit code
 * and the words on stderr are what a workflow sees.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkGuideDrift, COMPARED_FIELDS, evaluateRowBlock, extractRowBlock, guidePort, readAddonPorts } from './check-guide-drift.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-guide-drift.mjs');

const SITE_ROW = {
  id: 'demo-tool',
  title: 'Demo tool',
  summary: 'Upload an export and get a demo assessment. Nothing you upload is kept beyond two hours.',
  origin: 'https://demo-tool.lab.hybridcloudworks.com',
  panePath: '/',
  healthPath: '/api/health',
  providers: ['azure'],
  technology: ['terraform', 'resource-graph'],
  status: 'available',
  capabilities: ['downloads', 'clipboard-write'],
  docsUrl: 'https://github.com/saulpatinojr/HCW-Demo_AddOn#readme',
  articleSlugs: [],
};

/** A catalogue file shaped like the real one: frozen rows, exported as `addons`, with a second row beside ours. */
const catalogue = (rows = [SITE_ROW, { ...SITE_ROW, id: 'other-tool' }]) =>
  `export const addons = Object.freeze(${JSON.stringify(rows)}.map((row) => Object.freeze(row)));\n`;

const GROUP_VARS = [
  'caddy_domain: example',
  'addons:',
  '  - id: other-tool',
  '    enabled: true',
  '    port: 18081',
  '  - id: demo-tool',
  '    enabled: true',
  '    image: docker.io/hybridcloudworks/img-demo-lab-addon',
  '    port: 18082',
  '    memory: 512m',
  'next_key: 1',
  '',
].join('\n');

/** A literal the way a guide pastes it: single quotes, no trailing commas needed, nothing else around it. */
const literal = (row) => JSON.stringify(row, null, 2);

const guide = ({ row = SITE_ROW, heading = '## Catalogue row (`frontend/src/data/addons/catalogue.js`)', port = '| Lab-host loopback port | 18082 |', fence = '```js' } = {}) =>
  ['# Website integration guide', '', '| Item | Value |', '|---|---|', '| AddOn id | `demo-tool` |', port, '', heading, '', 'Prose before the block.', '', fence, literal(row), '```', '', '## Status proxy', '', '```js', '{ id: "decoy" }', '```', ''].join('\n');

const run = (overrides = {}, id = 'demo-tool', extra = {}) =>
  checkGuideDrift({ catalogueText: catalogue(), groupVarsText: GROUP_VARS, guideText: guide(overrides), id, ...extra });

describe('a guide that is in step', () => {
  it('passes and counts every compared field plus the port', async () => {
    const result = await run();
    expect(result).toEqual({ ok: true, compared: COMPARED_FIELDS.length + 1, problems: [] });
    expect(COMPARED_FIELDS.length).toBe(12);
  });

  it('compares twelve fields and no port when the guide states none', async () => {
    const result = await run({ port: '| Lab-host loopback port | not assigned; the next free port is the website\'s call (another uses 18082) |' });
    expect(result).toEqual({ ok: true, compared: 12, problems: [] });
  });

  it('reads a numbered heading and a 127.0.0.1:port form, as the migration guide writes them', async () => {
    const result = await run({ heading: '## 1. Catalogue row (`x`)', port: '| Loopback port on the lab host | `127.0.0.1:18082` -> container port `8080` |' });
    expect(result.ok).toBe(true);
    expect(result.compared).toBe(13);
  });

  it('accepts a row written as JavaScript, with single quotes and a trailing comma', async () => {
    const text = guide().replace(/```js\n[\s\S]*?\n```\n\n## Status/, "```js\n{ id: 'demo-tool', title: 'Demo tool', summary:\n 'Upload an export and get a demo assessment. Nothing you upload is kept beyond two hours.',\n origin: 'https://demo-tool.lab.hybridcloudworks.com', panePath: '/', healthPath: '/api/health', providers: ['azure'],\n technology: ['terraform', 'resource-graph'], status: 'available', capabilities: ['downloads', 'clipboard-write'],\n docsUrl: 'https://github.com/saulpatinojr/HCW-Demo_AddOn#readme', articleSlugs: [], }\n```\n\n## Status");
    const result = await checkGuideDrift({ catalogueText: catalogue(), groupVarsText: GROUP_VARS, guideText: text, id: 'demo-tool' });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe('a guide that has drifted', () => {
  it('names a changed summary with both values', async () => {
    const result = await run({ row: { ...SITE_ROW, summary: 'An older summary.' } });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([`summary: the site says ${JSON.stringify(SITE_ROW.summary)}, the guide says "An older summary."`]);
  });

  it('names a changed status, in both directions', async () => {
    const guideSaysComing = await run({ row: { ...SITE_ROW, status: 'coming' } });
    expect(guideSaysComing.problems).toEqual(['status: the site says "available", the guide says "coming"']);

    const siteSaysComing = await checkGuideDrift({
      catalogueText: catalogue([{ ...SITE_ROW, status: 'coming' }]),
      groupVarsText: GROUP_VARS,
      guideText: guide(),
      id: 'demo-tool',
    });
    expect(siteSaysComing.problems).toEqual(['status: the site says "coming", the guide says "available"']);
  });

  it('names a changed capabilities array, by content and not only by length', async () => {
    const sameLength = await run({ row: { ...SITE_ROW, capabilities: ['downloads', 'navigate'] } });
    expect(sameLength.problems).toEqual(['capabilities: the site says ["downloads","clipboard-write"], the guide says ["downloads","navigate"]']);

    const shorter = await run({ row: { ...SITE_ROW, capabilities: ['downloads'] } });
    expect(shorter.problems).toEqual(['capabilities: the site says ["downloads","clipboard-write"], the guide says ["downloads"]']);
  });

  it('names a field the guide leaves out', async () => {
    const { healthPath, ...withoutHealth } = SITE_ROW;
    expect(healthPath).toBeDefined();
    const result = await run({ row: withoutHealth });
    expect(result.problems).toEqual(['healthPath: the site says "/api/health", the guide says (not in the row)']);
  });

  it('names every differing field, not just the first', async () => {
    const result = await run({ row: { ...SITE_ROW, title: 'Old', origin: 'https://old.example', technology: [] } });
    expect(result.problems.map((p) => p.split(':')[0])).toEqual(['title', 'origin', 'technology']);
  });

  it('names a differing port, with the lab host\'s value first', async () => {
    const result = await run({ port: '| Lab-host loopback port | 18083 |' });
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["port: the site's lab host says 18082, the guide says 18083"]);
  });

  it('treats a stated port for an id the lab host does not run as a difference', async () => {
    const result = await checkGuideDrift({
      catalogueText: catalogue(),
      groupVarsText: GROUP_VARS.replace('  - id: demo-tool', '  - id: renamed-tool'),
      guideText: guide(),
      id: 'demo-tool',
    });
    expect(result.problems).toEqual(['port: the guide says 18082, the lab host\'s group_vars has no port for "demo-tool"']);
  });
});

describe('a guide that cannot be compared', () => {
  it('fails when the site no longer lists the id', async () => {
    const result = await run({}, 'demo-tool', { catalogueText: catalogue([{ ...SITE_ROW, id: 'other-tool' }]) });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('the site no longer lists this add-on');
    expect(result.problems[0]).toContain('"demo-tool"');
  });

  it('fails when the guide has no row block', async () => {
    const withoutBlock = guide().replace(/```js\n[\s\S]*?\n```\n\n## Status/, '## Status');
    const result = await checkGuideDrift({ catalogueText: catalogue(), groupVarsText: GROUP_VARS, guideText: withoutBlock, id: 'demo-tool' });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('no ```js block');
  });

  it('does not take a block from under a later heading', async () => {
    const result = await run({ heading: '## Something else' });
    expect(result.problems[0]).toContain('no heading that starts "Catalogue row"');
    const onlyLater = guide().replace(/```js\n[\s\S]*?\n```\n\n## Status/, '## Status');
    const second = await checkGuideDrift({ catalogueText: catalogue(), groupVarsText: GROUP_VARS, guideText: onlyLater, id: 'demo-tool' });
    expect(second.ok).toBe(false);
  });

  it('fails when the row block is malformed', async () => {
    const broken = guide().replace('"status": "available",', '"status": ,');
    const result = await checkGuideDrift({ catalogueText: catalogue(), groupVarsText: GROUP_VARS, guideText: broken, id: 'demo-tool' });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('row block is not a readable object');
  });

  it('fails when the block is never closed', async () => {
    const result = await checkGuideDrift({ catalogueText: catalogue(), groupVarsText: GROUP_VARS, guideText: guide().split('\n').slice(0, 13).join('\n'), id: 'demo-tool' });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('never closed');
  });

  it('fails when the block is not one object', async () => {
    const result = await checkGuideDrift({ catalogueText: catalogue(), groupVarsText: GROUP_VARS, guideText: guide({ row: SITE_ROW }).replace(/```js\n\{[\s\S]*?\n\}\n```/, '```js\n[1, 2]\n```'), id: 'demo-tool' });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('not a single');
  });

  it('refuses an id that is not shaped like an add-on id', async () => {
    const result = await run({}, 'Demo Tool');
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('is not an add-on id');
  });
});

describe('the guide\'s row is untrusted text', () => {
  it('cannot reach the process, require or import from inside the row', () => {
    for (const block of ['{ id: process.exit(3) }', "{ id: require('node:fs') }", '{ id: globalThis.process.env.PATH }', "{ id: (() => { while (true) {} })() }", '{ id: eval("1") }', '{ id: new Function("return 1")() }']) {
      const result = evaluateRowBlock(block);
      expect(result.error, block).toBeTruthy();
    }
  });
});

describe('the parts', () => {
  it('extractRowBlock stops at the next heading and ignores a heading inside prose', () => {
    expect(extractRowBlock('# T\n\n## Catalogue row\n\n## Next\n\n```js\n{}\n```\n').error).toContain('no ```js block');
    expect(extractRowBlock('# T\n\n## Catalogue row\n\n```js\n{ id: 1 }\n```\n').block).toBe('{ id: 1 }');
    expect(extractRowBlock('# T\r\n\r\n## 2. Catalogue row\r\n\r\n```js\r\n{ id: 1 }\r\n```\r\n').block).toBe('{ id: 1 }');
  });

  it('guidePort reads the loopback port row and nothing else', () => {
    expect(guidePort('| Lab-host loopback port | 18083 |')).toBe(18083);
    expect(guidePort('| Loopback port on the lab host | `127.0.0.1:18081` -> container port `8080` |')).toBe(18081);
    expect(guidePort('| Lab-host loopback port | not assigned; the Cloud Assessor uses 18083 |')).toBeNull();
    expect(guidePort('The loopback port is 18083.')).toBeNull();
    expect(guidePort('| Image | img on port 18083 |')).toBeNull();
  });

  it('readAddonPorts reads a row that has no digest and keeps ids apart', () => {
    expect([...readAddonPorts(GROUP_VARS)]).toEqual([['other-tool', 18081], ['demo-tool', 18082]]);
    expect(() => readAddonPorts('nothing: here\n')).toThrow('no `addons:` block');
  });
});

describe('the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guide-drift-'));
  const file = (name, text) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const cli = (guideText, id = 'demo-tool') =>
    spawnSync(
      process.execPath,
      [SCRIPT, '--catalogue', file('catalogue.js', catalogue()), '--group-vars', file('all.yml', GROUP_VARS), '--guide', file('guide.md', guideText), '--id', id],
      { encoding: 'utf8' }
    );

  it('exits 0 and prints the count when in step', () => {
    const result = cli(guide());
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('in step: 13 fields compared\n');
    expect(result.stderr).toBe('');
  });

  it('exits 1 and names the field and both values when not', () => {
    const result = cli(guide({ row: { ...SITE_ROW, status: 'coming' } }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('status: the site says "available", the guide says "coming"');
    expect(result.stdout).toBe('');
  });

  it('exits 1 when the site no longer lists the id', () => {
    const result = cli(guide(), 'gone-tool');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the site no longer lists this add-on');
  });

  it('exits 2 with the usage line when an argument is missing, and when a file cannot be read', () => {
    const missing = spawnSync(process.execPath, [SCRIPT, '--id', 'demo-tool'], { encoding: 'utf8' });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('usage:');
    const unreadable = spawnSync(process.execPath, [SCRIPT, '--catalogue', join(dir, 'nope.js'), '--group-vars', join(dir, 'nope.yml'), '--guide', join(dir, 'nope.md'), '--id', 'demo-tool'], { encoding: 'utf8' });
    expect(unreadable.status).toBe(2);
  });
});

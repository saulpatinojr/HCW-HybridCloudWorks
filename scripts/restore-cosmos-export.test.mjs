import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  parseBlobName,
  selectRestoreSet,
  restoreLayers,
  containersToRestore,
  layersCarrying,
  dataBlobName,
  manifestBlobName,
  parseLine,
  assertLayerBlobPresent,
  requireBody,
  stripSystemFields,
  classifyUpsert,
  createRestoreTally,
  formatRow,
  parseConcurrency,
  forEachConcurrent,
} from './lib/cosmos-export-restore.mjs';
import { parseOptions } from './restore-cosmos-export.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

const run = (mode, runId, containers, complete = true) => [
  ...containers.flatMap((c) => [
    `${mode}/${runId}/${c}.ndjson.gz`,
    `${mode}/${runId}/${c}.marker.json`,
  ]),
  `${mode}/${runId}/run.json`,
  ...(complete ? [`${mode}/${runId}/manifest.json`] : []),
];

describe('parseBlobName', () => {
  it('recognises every blob kind in a run prefix and nothing outside one', () => {
    expect(parseBlobName('full/2026-09-13/content.ndjson.gz')).toEqual({
      mode: 'full',
      runId: '2026-09-13',
      kind: 'data',
      container: 'content',
    });
    expect(parseBlobName('delta/2026-09-14/admin_config.marker.json')).toEqual({
      mode: 'delta',
      runId: '2026-09-14',
      kind: 'marker',
      container: 'admin_config',
    });
    expect(parseBlobName('full/2026-09-13/manifest.json').kind).toBe('manifest');
    expect(parseBlobName('full/2026-09-13/run.json').kind).toBe('run');
    expect(parseBlobName('full/2026-09-13/notes.txt').kind).toBe('other');
    expect(parseBlobName('state/content.json')).toBeNull();
    expect(parseBlobName('weekly/2026-09-13/content.ndjson.gz')).toBeNull();
  });
});

describe('selectRestoreSet', () => {
  const names = [
    ...run('full', '2026-09-06', ['content']),
    ...run('delta', '2026-09-08', ['content']),
    ...run('full', '2026-09-13', ['content']),
    ...run('delta', '2026-09-14', ['content']),
    ...run('delta', '2026-09-15', ['content'], false),
    ...run('delta', '2026-09-16', ['content']),
    ...run('full', '2026-09-20', ['content'], false),
    ...run('delta', '2026-09-21', ['content']),
    'state/content.json',
  ];

  it('takes the latest complete full and every complete delta after it, in order; incomplete runs are skipped and named', () => {
    expect(selectRestoreSet(names)).toEqual({
      full: '2026-09-13',
      deltas: ['2026-09-14', '2026-09-16', '2026-09-21'],
      incompleteSkipped: ['delta/2026-09-15', 'full/2026-09-20'],
    });
  });

  it('honours --as-of, and deltas before the chosen full are never applied', () => {
    expect(selectRestoreSet(names, { asOf: '2026-09-14' })).toEqual({
      full: '2026-09-13',
      deltas: ['2026-09-14'],
      incompleteSkipped: [],
    });
    expect(selectRestoreSet(names, { asOf: '2026-09-12' })).toEqual({
      full: '2026-09-06',
      deltas: ['2026-09-08'],
      incompleteSkipped: [],
    });
  });

  it('fails loudly with no complete full', () => {
    expect(() => selectRestoreSet(run('full', '2026-09-13', ['content'], false))).toThrow(
      /no complete full export/
    );
    expect(() => selectRestoreSet(names, { asOf: '2026-09-01' })).toThrow(
      /on or before 2026-09-01/
    );
    expect(() => selectRestoreSet(names, { asOf: 'yesterday' })).toThrow(/YYYY-MM-DD/);
  });

  it('restoreLayers is the full then the deltas', () => {
    expect(restoreLayers({ full: '2026-09-13', deltas: ['2026-09-14', '2026-09-16'] })).toEqual([
      { mode: 'full', runId: '2026-09-13' },
      { mode: 'delta', runId: '2026-09-14' },
      { mode: 'delta', runId: '2026-09-16' },
    ]);
    expect(dataBlobName('delta', '2026-09-14', 'blogs')).toBe('delta/2026-09-14/blogs.ndjson.gz');
    expect(manifestBlobName('full', '2026-09-13')).toBe('full/2026-09-13/manifest.json');
  });
});

describe('containersToRestore', () => {
  const manifest = {
    containers: [{ container: 'content' }, { container: 'blogs' }, { container: 'admins' }],
  };

  it('is every container in the full, sorted, or the explicit subset', () => {
    expect(containersToRestore(manifest)).toEqual(['admins', 'blogs', 'content']);
    expect(containersToRestore(manifest, ['content', 'blogs', 'content'])).toEqual([
      'blogs',
      'content',
    ]);
  });

  it('refuses a name the full does not carry rather than skipping it', () => {
    expect(() => containersToRestore(manifest, ['content', 'jobs'])).toThrow(
      /does not carry: jobs/
    );
    expect(() => containersToRestore({ containers: [] })).toThrow(/lists no containers/);
  });
});

describe('layersCarrying', () => {
  // As the live set read 2026-10-12: the Sunday full carries admin_audit_logs
  // (operational, full only) and content; the deltas carry content alone.
  const layers = restoreLayers({ full: '2026-10-11', deltas: ['2026-10-12', '2026-10-13'] });
  const manifests = new Map([
    ['full/2026-10-11', { containers: [{ container: 'admin_audit_logs' }, { container: 'content' }] }],
    ['delta/2026-10-12', { containers: [{ container: 'content' }] }],
    ['delta/2026-10-13', { containers: [{ container: 'content' }] }],
  ]);

  it('restores a full-only container from the full alone, not from deltas that never carry it', () => {
    // The first drill stopped here: every delta was asked for admin_audit_logs.
    expect(layersCarrying('admin_audit_logs', layers, manifests)).toEqual([
      { mode: 'full', runId: '2026-10-11' },
    ]);
  });

  it('applies every layer that lists a container, in order', () => {
    expect(layersCarrying('content', layers, manifests)).toEqual(layers);
  });

  it('refuses to guess when a layer has no manifest read', () => {
    const partial = new Map([...manifests].filter(([key]) => key !== 'delta/2026-10-13'));
    expect(() => layersCarrying('content', layers, partial)).toThrow(/no manifest was read for delta\/2026-10-13/);
  });
});

describe('documents', () => {
  it('parseLine strips Cosmos system fields and requires a string id', () => {
    expect(
      parseLine(
        '{"id":"a","title":"t","_rid":"x","_self":"y","_etag":"z","_attachments":"w","_ts":1}'
      )
    ).toEqual({ id: 'a', title: 't' });
    expect(() => parseLine('{"title":"no id"}')).toThrow(/string id/);
    expect(() => parseLine('[]')).toThrow(/string id/);
    expect(stripSystemFields({ id: 'a', _ts: 1, keep: true })).toEqual({ id: 'a', keep: true });
  });

  it('classifyUpsert maps 201 to created and 200 to replaced, and refuses anything else', () => {
    expect(classifyUpsert(201)).toBe('created');
    expect(classifyUpsert(200)).toBe('replaced');
    expect(() => classifyUpsert(204)).toThrow(/HTTP 204/);
    expect(() => classifyUpsert(undefined)).toThrow(/neither a create/);
  });

  it('the tally counts per layer and, on a real run, created (distinct) and replaced from status codes without keeping ids', () => {
    const tally = createRestoreTally();
    tally.touch('full/2026-09-13');
    for (const code of [201, 201, 201]) tally.add('full/2026-09-13', code);
    tally.touch('delta/2026-09-14');
    tally.add('delta/2026-09-14', 200);
    tally.add('delta/2026-09-14', 201);
    tally.touch('delta/2026-09-15');
    expect(tally.result()).toEqual({
      perLayer: { 'full/2026-09-13': 3, 'delta/2026-09-14': 2, 'delta/2026-09-15': 0 },
      documents: 5,
      created: 4,
      replaced: 1,
    });
  });

  it('on a dry run the tally reports document counts only; created and replaced are null', () => {
    const tally = createRestoreTally();
    tally.touch('full/2026-09-13');
    tally.add('full/2026-09-13');
    tally.add('full/2026-09-13');
    tally.touch('delta/2026-09-14');
    expect(tally.result()).toEqual({
      perLayer: { 'full/2026-09-13': 2, 'delta/2026-09-14': 0 },
      documents: 2,
      created: null,
      replaced: null,
    });
  });
});

describe('helpers', () => {
  it('formatRow pads to the widths and trims the tail', () => {
    expect(formatRow(['a', 1, ''], [3, 2, 4])).toBe('a    1');
  });

  it('parseConcurrency defaults to 8 and bounds the value', () => {
    expect(parseConcurrency(undefined)).toBe(8);
    expect(parseConcurrency('4')).toBe(4);
    for (const bad of ['0', '33', '2.5', 'many'])
      expect(() => parseConcurrency(bad)).toThrow(/1 to 32/);
  });

  it('forEachConcurrent bounds the in-flight count and surfaces the first failure', async () => {
    let inFlight = 0;
    let peak = 0;
    const done = [];
    async function* items() {
      for (let i = 0; i < 10; i += 1) yield i;
    }
    await forEachConcurrent(items(), 3, async (i) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      done.push(i);
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    await expect(
      forEachConcurrent(items(), 2, async (i) => {
        if (i === 4) throw new Error('boom');
      })
    ).rejects.toThrow('boom');
  });

  it('forEachConcurrent treats a synchronous throw like a rejection and drains the in-flight work first', async () => {
    let inFlight = 0;
    let finished = 0;
    async function* items() {
      for (let i = 0; i < 6; i += 1) yield i;
    }
    await expect(
      forEachConcurrent(items(), 3, (i) => {
        if (i === 2) throw new Error('sync boom');
        inFlight += 1;
        return new Promise((r) => setTimeout(r, 5)).then(() => {
          inFlight -= 1;
          finished += 1;
        });
      })
    ).rejects.toThrow('sync boom');
    expect(inFlight).toBe(0);
    expect(finished).toBe(2);
  });

  it('requireBody returns the download stream, and names the blob when there is none', () => {
    const body = Readable.from(['x']);
    expect(requireBody({ readableStreamBody: body }, 'full/2026-09-13/a.ndjson.gz')).toBe(body);
    for (const res of [
      {},
      { readableStreamBody: undefined },
      null,
      { readableStreamBody: 'text' },
    ]) {
      expect(() => requireBody(res, 'full/2026-09-13/a.ndjson.gz')).toThrow(
        /full\/2026-09-13\/a\.ndjson\.gz: the download returned no readable body/
      );
    }
  });

  it('assertLayerBlobPresent throws naming the blob when a selected layer has no data blob', () => {
    expect(() => assertLayerBlobPresent(true, 'full/2026-09-13/content.ndjson.gz')).not.toThrow();
    expect(() => assertLayerBlobPresent(false, 'delta/2026-09-14/blogs.ndjson.gz')).toThrow(
      /delta\/2026-09-14\/blogs\.ndjson\.gz is missing .* corrupted or expired/
    );
  });
});

describe('parseOptions', () => {
  it('requires the storage account, and the target endpoint unless dry-run', () => {
    expect(() => parseOptions([])).toThrow(/--storage-account is required/);
    expect(() => parseOptions(['--storage-account', 'stsiteprodcus01'])).toThrow(
      /--target-endpoint is required unless --dry-run/
    );
    expect(parseOptions(['--storage-account', 'stsiteprodcus01', '--dry-run'])).toEqual({
      help: false,
      storageAccount: 'stsiteprodcus01',
      targetEndpoint: null,
      database: 'hcw',
      asOf: undefined,
      containers: null,
      concurrency: 8,
      dryRun: true,
      verify: false,
    });
  });

  it('refuses a production account as the target unless --allow-production-target says so', () => {
    const base = ['--storage-account', 'stsiteprodcus01', '--target-endpoint'];
    expect(() => parseOptions([...base, 'https://cosmos-site-prod-cus.documents.azure.com:443/'])).toThrow(
      /names cosmos-site-prod-cus, a production account/
    );
    expect(
      parseOptions([
        ...base,
        'https://cosmos-site-prod-cus-02.documents.azure.com:443/',
        '--allow-production-target',
      ]).targetEndpoint
    ).toBe('https://cosmos-site-prod-cus-02.documents.azure.com:443/');
    // The drill's scratch account needs no flag.
    expect(parseOptions([...base, 'https://cosmos-site-sbx-cus.documents.azure.com:443/']).targetEndpoint).toBe(
      'https://cosmos-site-sbx-cus.documents.azure.com:443/'
    );
  });

  it('parses a full restore invocation', () => {
    expect(
      parseOptions([
        '--storage-account=stsiteprodcus01',
        '--target-endpoint',
        'https://cosmos-site-sbx-cus.documents.azure.com:443/',
        '--as-of',
        '2026-09-14',
        '--containers',
        'content, blogs',
        '--concurrency',
        '16',
        '--verify',
      ])
    ).toMatchObject({
      targetEndpoint: 'https://cosmos-site-sbx-cus.documents.azure.com:443/',
      asOf: '2026-09-14',
      containers: ['content', 'blogs'],
      concurrency: 16,
      dryRun: false,
      verify: true,
    });
    expect(() =>
      parseOptions(['--storage-account', 's', '--target-endpoint', 'http://plain.example'])
    ).toThrow(/https/);
    expect(
      parseOptions(['--storage-account', 's', '--dry-run', '--database', ' drill ']).database
    ).toBe('drill');
    expect(
      parseOptions(['--storage-account', 's', '--dry-run', '--as-of', '2026-09-14 ']).asOf
    ).toBe('2026-09-14');
    for (const blank of ['', '   ']) {
      expect(() =>
        parseOptions(['--storage-account', 's', '--dry-run', '--database', blank])
      ).toThrow(/--database must name the target database/);
    }
    expect(() => parseOptions(['--storage-account', 's', '--dry-run', '--bogus'])).toThrow(
      /Unknown argument/
    );
  });
});

describe('entry-point guard', () => {
  it('--help prints usage and exits 0 when invoked directly', () => {
    const stdout = execFileSync(
      process.execPath,
      [join(SCRIPTS, 'restore-cosmos-export.mjs'), '--help'],
      {
        encoding: 'utf8',
        timeout: 30_000,
      }
    );
    expect(stdout).toContain('Usage: node scripts/restore-cosmos-export.mjs');
  });

  it('a missing required option exits 2 with the reason on stderr', () => {
    let failure = null;
    try {
      execFileSync(process.execPath, [join(SCRIPTS, 'restore-cosmos-export.mjs')], {
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      failure = err;
    }
    expect(failure?.status).toBe(2);
    expect(failure?.stderr).toContain('--storage-account is required');
  });
});

/**
 * The archive dry run's search for names that look like a secret, at its
 * limits (archive-report-base.js SENSITIVE_MAX_DEPTH and
 * SENSITIVE_MAX_NODES, issue #1811): a record just inside them is searched
 * whole, a record just past them is cut short, and a cut-short record in a
 * container an archive keeps still stops the archive. Made-up records only.
 */
import { describe, it, expect } from 'vitest';
import {
  SENSITIVE_MAX_DEPTH,
  SENSITIVE_MAX_NODES,
  cutShortParts,
  reportGate,
  sensitiveFieldsIn,
  sensitiveNamesIn,
} from './archive-report.js';
import { COSMOS_MAX_ITEM_BYTES, COSMOS_MAX_NESTING } from './archive-report-base.js';
import { classificationFingerprint } from './archive-classification.js';

/** A record whose deepest object sits `depth` levels below it (the record is level 0), with a sensitive name there. */
function recordOfDepth(depth) {
  let inner = { apiKey: 1 };
  for (let level = 1; level < depth; level += 1) inner = { next: inner };
  return { id: 'made-up', next: inner };
}

/** A record of exactly `nodes` objects and lists, counting itself: itself, one list, and `nodes - 2` empty objects. */
const recordOfNodes = (nodes) => ({ id: 'made-up', items: Array.from({ length: nodes - 2 }, () => ({})) });

describe('the limits come from the database, so a record it can hold is searched whole', () => {
  it('are the Cosmos DB item limits: 128 levels, and the most objects 2 MiB of JSON can hold', () => {
    expect(SENSITIVE_MAX_DEPTH).toBe(COSMOS_MAX_NESTING);
    expect(COSMOS_MAX_NESTING).toBe(128);
    expect(COSMOS_MAX_ITEM_BYTES).toBe(2 * 1024 * 1024);
    // Every object or list costs at least its two brackets; a comma is only
    // needed between siblings, so a list's last child costs just `[]`.
    expect(SENSITIVE_MAX_NODES).toBe(1048576);
  });

  it('searches whole the densest record found to fit in 2 MiB: lists of nested lists, 126 levels deep', () => {
    const chain = () => {
      let inner = [];
      for (let level = 1; level < 126; level += 1) inner = [inner];
      return inner;
    };
    const dense = { id: 'made-up', items: Array.from({ length: 8200 }, chain) };
    expect(JSON.stringify(dense).length).toBeLessThan(COSMOS_MAX_ITEM_BYTES);
    expect(sensitiveNamesIn(dense).cutShort).toBe(false);
  });

  it('searches a record exactly as deep as the limit whole, and still finds the name at the bottom', () => {
    const found = sensitiveFieldsIn(recordOfDepth(SENSITIVE_MAX_DEPTH));
    expect(found.cutShort).toBe(false);
    expect([...found.fields.values()].map((field) => field.name)).toEqual(['apiKey']);
    expect(sensitiveNamesIn(recordOfDepth(SENSITIVE_MAX_DEPTH)).cutShort).toBe(false);
  });

  it('cuts short a record one level deeper than the limit', () => {
    expect(sensitiveFieldsIn(recordOfDepth(SENSITIVE_MAX_DEPTH + 1)).cutShort).toBe(true);
    expect(sensitiveNamesIn(recordOfDepth(SENSITIVE_MAX_DEPTH + 1)).cutShort).toBe(true);
  });

  it('searches a record of exactly the most objects whole, and cuts short one with one more', () => {
    expect(sensitiveNamesIn(recordOfNodes(SENSITIVE_MAX_NODES)).cutShort).toBe(false);
    expect(sensitiveNamesIn(recordOfNodes(SENSITIVE_MAX_NODES + 1)).cutShort).toBe(true);
  });

  it('searches whole the shapes the old limits (8 levels, 5,000 objects) cut short', () => {
    // An editor-style document: blocks holding lists holding marks, ten levels down.
    const nested = { id: 'made-up', body: { content: [{ content: [{ content: [{ marks: [{ attrs: { href: 'x' } }] }] }] }] } };
    expect(sensitiveNamesIn(nested).cutShort).toBe(false);
    // A transcript-style record: 6,000 timed lines.
    const long = { id: 'made-up', segments: Array.from({ length: 6000 }, (_, i) => ({ start: i, end: i + 1, text: 'x' })) };
    expect(sensitiveNamesIn(long).cutShort).toBe(false);
  });
});

describe('a record still cut short still stops the archive, and the report says where', () => {
  const SUNDAY = '2027-02-07';
  const clean = { remaining: [], flagged: 0, keptRecords: 0, cutShort: 0 };
  const part = (container, over = {}) => ({ container, decision: 'archive', reason: null, read: 3, matchesBackup: true, unreadable: 0, sensitive: clean, ...over });
  const latest = (containers) => ({
    reportId: 'x',
    complete: true,
    report: { sourceBackup: { runId: SUNDAY }, rules: classificationFingerprint(), totals: {}, containers, leftOutWhole: [] },
  });
  const gate = (containers) => reportGate({ latest: latest(containers), backupRunId: SUNDAY, backupContainers: ['blogs', 'newsletters'] });

  it('blocks on a cut-short record in a kept container, and names that container with its count', () => {
    const containers = [part('blogs'), part('newsletters', { sensitive: { ...clean, cutShort: 2 } })];
    expect(gate(containers)).toEqual(['report-cut-short']);
    expect(cutShortParts(latest(containers).report)).toEqual([{ container: 'newsletters', records: 2 }]);
  });

  it('lists every kept container that had one, and none that is left out', () => {
    const containers = [
      part('blogs', { sensitive: { ...clean, cutShort: 1 } }),
      part('newsletters', { sensitive: { ...clean, cutShort: 3 } }),
      part('admins', { decision: 'leave-out', reason: 'access-list', sensitive: { ...clean, cutShort: 5 } }),
    ];
    expect(cutShortParts(latest(containers).report)).toEqual([
      { container: 'blogs', records: 1 },
      { container: 'newsletters', records: 3 },
    ]);
  });

  it('names nothing for a clean report, a missing one or one that is not a report', () => {
    expect(cutShortParts(latest([part('blogs'), part('newsletters')]).report)).toEqual([]);
    expect(cutShortParts(null)).toEqual([]);
    expect(cutShortParts({ containers: 'not a list' })).toEqual([]);
    expect(gate([part('blogs'), part('newsletters')])).toEqual([]);
  });
});

describe('size alone does not cut a record short', () => {
  it('searches whole a record made large by one long value, since only names are read', () => {
    const doc = { id: 'x', body: 'x'.repeat(2_100_000), password: 'not read' };
    const { names, cutShort } = sensitiveNamesIn(doc);
    expect(cutShort).toBe(false);
    expect([...names]).toContain('password');
  });
});

/**
 * The calendar alerts are the owner's private notes. This pins that nothing a
 * visitor, the content manifest or the prerender can reach will ever show one.
 *
 * Two kinds of proof, because each catches what the other cannot:
 *
 *   1. BEHAVIOUR. The real public handlers (public reads, the content
 *      manifest, the signed preview) run against a store that really holds
 *      the alerts document with sentinel words in it, and that hands it back
 *      to ANY read of `admin_config` they might make. No answer may contain a
 *      sentinel, and the only `admin_config` read any of them makes is the
 *      podcast feed list they already made.
 *   2. A TRIPWIRE. Only the calendar-alerts module, its route registration
 *      and the function index may mention the alerts at all. A public module
 *      that starts reading them has to name them, so it fails here the day
 *      someone writes it, whatever the handlers happen to do in this test.
 */
import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPublicReadHandlers } from '../public-reads.js';
import { createPublicContentManifestHandlers } from '../public-content-manifest.js';
import { createPublicPreviewHandlers } from '../public-preview.js';
import { CALENDAR_ALERTS_DOC_ID } from './model.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SENTINELS = ['PRIVATE-ALERT-TITLE-5a1', 'PRIVATE-ALERT-NOTE-77c', 'PRIVATE-ALERT-LINK-0e9'];

const alertsDocument = () => ({
  id: CALENDAR_ALERTS_DOC_ID,
  configScope: 'admin_config',
  docType: 'calendar_alerts',
  seeded: ['docker-dsos-application'],
  alerts: [
    {
      id: 'a1',
      title: SENTINELS[0],
      dueDate: '2026-10-30',
      dueTime: null,
      link: `https://example.com/${SENTINELS[2]}`,
      note: SENTINELS[1],
      status: 'open',
      snoozedUntil: null,
      doneAt: null,
      createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:00.000Z',
    },
  ],
  _etag: '"1"',
});

/**
 * A store that records every read and answers the alerts document to any read
 * of `admin_config`, however it is asked.
 */
function trapStore() {
  const reads = [];
  return {
    reads,
    readDoc: vi.fn(async (container, id, partitionKey) => {
      reads.push({ kind: 'readDoc', container, id, partitionKey });
      return container === 'admin_config' ? alertsDocument() : null;
    }),
    queryDocs: vi.fn(async (container, query) => {
      reads.push({ kind: 'queryDocs', container, query });
      return container === 'admin_config' ? [alertsDocument()] : [];
    }),
  };
}

const makeRequest = ({ query = {}, params = {} } = {}) => ({
  method: 'GET',
  query: { get: (key) => query[key] ?? null },
  params,
  headers: { get: () => null },
});

/** Requests that reach each public handler's store reads, not just its argument check. */
const REQUESTS = [
  makeRequest(),
  makeRequest({ query: { type: 'blog', provider: 'azure', limit: '5' } }),
  makeRequest({ query: { source: 'blogs', type: 'news' } }),
  makeRequest({ params: { slugOrId: 'some-article', id: 'certifications', contentId: 'c1' } }),
  makeRequest({ params: { id: 'speakerevents' }, query: { provider: 'main', setId: 'set-1' } }),
  makeRequest({ query: { ids: 'a,b,c', provider: 'azure', certification: 'AZ-104' } }),
];

const context = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** Every function a handler set exposes, called with every request. */
async function callAll(handlers) {
  const answers = [];
  for (const handler of Object.values(handlers)) {
    for (const request of REQUESTS) {
      try {
        answers.push(await handler(request, context));
      } catch {
        // A handler that throws on a request it was never meant to get has not leaked.
      }
    }
  }
  return answers;
}

describe('the public handlers never reach the alerts', () => {
  it('give no answer a word of an alert, and read admin_config only for the podcast feed list', async () => {
    const store = trapStore();
    const handlerSets = [
      createPublicReadHandlers({ store }),
      createPublicContentManifestHandlers({ store }),
      createPublicPreviewHandlers({ store, env: { PREVIEW_SIGNING_SECRET: 'x'.repeat(32) } }),
    ];
    const answers = [];
    for (const handlers of handlerSets) answers.push(...(await callAll(handlers)));

    expect(answers.length).toBeGreaterThan(20);
    const text = JSON.stringify(answers);
    for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
    expect(text).not.toContain('calendar_alerts');

    const adminConfigReads = store.reads.filter((read) => read.container === 'admin_config');
    // The feed list is read, and was handed the alerts document: had it
    // copied anything out of it, a sentinel above would have shown.
    expect(adminConfigReads.length).toBeGreaterThan(0);
    for (const read of adminConfigReads) {
      expect(read, 'a public handler read admin_config in a way other than by the feed list id').toMatchObject({
        kind: 'readDoc',
        id: 'podcast_feeds',
      });
    }
    expect(store.reads.some((read) => read.id === CALENDAR_ALERTS_DOC_ID)).toBe(false);
  });

  it('sweeps something: the store was read, so the proof above is not vacuous', async () => {
    const store = trapStore();
    await callAll(createPublicReadHandlers({ store }));
    expect(store.reads.length).toBeGreaterThan(5);
  });
});

/** Every non-test .js file under functions/src, as a path relative to it. */
function sourceFiles(directory = SRC) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.js') && !name.endsWith('.test.js') ? [path] : [];
  });
}

describe('nothing but the alerts module itself names the alerts', () => {
  const ALLOWED = [
    `lib${sep}calendar-alerts${sep}`,
    `functions${sep}calendar-alerts-http.js`,
    `functions${sep}index.js`,
    // The Calendar read shows the alerts as one more kind (collector.js). It is
    // the editor-gated cms/calendar route, never a public one.
    `lib${sep}calendar.js`,
    `lib${sep}calendar${sep}collectors.js`,
    `functions${sep}calendar-http.js`,
  ];
  const NAMES = /calendar[_-]?alerts?/i;

  it('is not mentioned by any other module, so no public path can read it without being seen here', () => {
    const offenders = sourceFiles()
      .map((path) => relative(SRC, path))
      .filter((file) => !ALLOWED.some((prefix) => file.startsWith(prefix)))
      .filter((file) => NAMES.test(readFileSync(join(SRC, file), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('is not imported by a module that serves a public route', () => {
    const publicModules = [
      'lib/public-reads.js',
      'lib/public-content-manifest.js',
      'lib/public-preview.js',
      'lib/public-media.js',
      'lib/public-section-counts.js',
      'functions/public-reads.js',
      'functions/public-content-manifest.js',
      'functions/public-preview.js',
      'functions/public-media.js',
      'functions/public-submissions.js',
      'functions/labs-public-http.js',
      'functions/addons-public-http.js',
      'functions/newsletter-http.js',
    ].map((file) => file.split('/').join(sep));
    for (const file of publicModules) {
      expect(readFileSync(join(SRC, file), 'utf8'), file).not.toMatch(/calendar-alerts/);
    }
  });

  it('is the only module that reads or writes the alerts document id', () => {
    const holders = sourceFiles()
      .map((path) => relative(SRC, path))
      .filter((file) => readFileSync(join(SRC, file), 'utf8').includes('CALENDAR_ALERTS_DOC_ID'))
      .filter((file) => !file.startsWith(`lib${sep}calendar-alerts${sep}`));
    expect(holders).toEqual([]);
  });
});

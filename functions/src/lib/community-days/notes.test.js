/**
 * What the owner saves against one Community Days event, and how a save is
 * kept from overwriting a newer one (#1823).
 */
import { describe, it, expect } from 'vitest';
import {
  CONTAINER,
  COST_MAX,
  NOTES_MAX,
  NOTE_DOC_TYPE,
  NoteConflictError,
  NoteNotFoundError,
  NoteValidationError,
  deleteNote,
  eventSnapshot,
  listNoteDocs,
  normalizeNoteInput,
  noteDocId,
  presentNote,
  saveEstimate,
  saveNote,
  storedEstimate,
} from './notes.js';
import { cachedEvent, fakeStore } from './fake-store.test-helper.js';

const NOW = () => new Date('2026-11-24T12:00:00.000Z');
const INPUT = { status: 'applied', notes: 'Flights look cheap in March.', costs: { travel: 320.5, lodging: 410, other: null } };

describe('normalizeNoteInput', () => {
  it('accepts the owner’s fields and fills in what is missing', () => {
    expect(normalizeNoteInput({})).toEqual({ status: '', notes: '', costs: { travel: null, lodging: null, other: null } });
    expect(normalizeNoteInput({ status: 'accepted', notes: '  hello  ', costs: { travel: 10.239, other: 0, lodging: '' }, etag: '"x"' })).toEqual({
      status: 'accepted',
      notes: 'hello',
      costs: { travel: 10.24, lodging: null, other: 0 },
    });
  });

  it.each([
    [null, /JSON object/],
    [[], /JSON object/],
    [{ status: 'maybe' }, /status must be/],
    [{ notes: 5 }, /notes must be text/],
    [{ notes: 'x'.repeat(NOTES_MAX + 1) }, /at most/],
    [{ costs: [] }, /costs must be an object/],
    [{ costs: { flights: 1 } }, /costs can only hold/],
    [{ costs: { travel: -1 } }, /costs\.travel/],
    [{ costs: { travel: '12' } }, /costs\.travel/],
    [{ costs: { lodging: COST_MAX + 1 } }, /costs\.lodging/],
    [{ costs: { other: Number.NaN } }, /costs\.other/],
    [{ 'costs.travel': 5 }, /Unknown field/],
    [{ estimate: { percent: 100 } }, /Unknown field/],
    [{ event: { title: 'Mine' } }, /Unknown field/],
  ])('refuses %j', (body, message) => {
    expect(() => normalizeNoteInput(body)).toThrow(NoteValidationError);
    expect(() => normalizeNoteInput(body)).toThrow(message);
  });
});

describe('saveNote', () => {
  it('creates the note, with a copy of the event and no undefined or dotted field', async () => {
    const store = fakeStore();
    const doc = await saveNote(store, { eventId: 'event-1', input: INPUT, etag: '', cachedEvent: cachedEvent(), now: NOW });
    expect(doc).toMatchObject({
      id: noteDocId('event-1'),
      configScope: 'admin_config',
      docType: NOTE_DOC_TYPE,
      eventId: 'event-1',
      status: 'applied',
      notes: 'Flights look cheap in March.',
      costs: { travel: 320.5, lodging: 410, other: null },
      estimate: null,
      event: { title: 'Example Community Day 2027', startDate: '2027-03-06', endDate: '2027-03-07', city: 'Exampleville', country: 'CA' },
      updatedAt: '2026-11-24T12:00:00.000Z',
    });
    const walk = (value) => {
      if (value && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          expect(inner, key).not.toBeUndefined();
          expect(key).not.toContain('.');
          walk(inner);
        }
      }
    };
    walk(doc);
    // The page text is the outside API's and is not copied into the note.
    expect(JSON.stringify(doc)).not.toContain('platform engineering');
  });

  it('replaces only under the version the page read, and keeps the saved estimate', async () => {
    const store = fakeStore();
    const first = await saveNote(store, { eventId: 'event-1', input: INPUT, etag: '', cachedEvent: cachedEvent(), now: NOW });
    await saveEstimate(store, { eventId: 'event-1', estimate: { percent: 55, reasons: ['Fits.'], madeAt: NOW().toISOString(), topicsFrom: [] }, cachedEvent: cachedEvent(), now: NOW });
    const current = store.get(CONTAINER, noteDocId('event-1'));

    // The page still holds the first version: refused, nothing written.
    await expect(saveNote(store, { eventId: 'event-1', input: { ...INPUT, status: 'declined' }, etag: first._etag, cachedEvent: cachedEvent(), now: NOW })).rejects.toThrow(NoteConflictError);
    expect(store.get(CONTAINER, noteDocId('event-1')).status).toBe('applied');

    const saved = await saveNote(store, { eventId: 'event-1', input: { ...INPUT, status: 'accepted' }, etag: current._etag, cachedEvent: null, now: NOW });
    expect(saved.status).toBe('accepted');
    expect(saved.estimate.percent).toBe(55);
    // The event has left the list: the note's own copy of it is kept.
    expect(saved.event.title).toBe('Example Community Day 2027');
  });

  it('refuses a save with no version when a note exists, and with a version when none does', async () => {
    const store = fakeStore();
    await expect(saveNote(store, { eventId: 'event-1', input: INPUT, etag: '"old"', cachedEvent: cachedEvent(), now: NOW })).rejects.toThrow(NoteConflictError);
    await saveNote(store, { eventId: 'event-1', input: INPUT, etag: '', cachedEvent: cachedEvent(), now: NOW });
    await expect(saveNote(store, { eventId: 'event-1', input: INPUT, etag: '', cachedEvent: cachedEvent(), now: NOW })).rejects.toThrow(NoteConflictError);
  });

  it('turns a 412 from the store (another tab won the race) into a conflict', async () => {
    const store = fakeStore();
    const first = await saveNote(store, { eventId: 'event-1', input: INPUT, etag: '', cachedEvent: cachedEvent(), now: NOW });
    store.replaceDocIfMatch.mockRejectedValueOnce(Object.assign(new Error('precondition'), { code: 412 }));
    const error = await saveNote(store, { eventId: 'event-1', input: INPUT, etag: first._etag, cachedEvent: cachedEvent(), now: NOW }).catch((caught) => caught);
    expect(error).toBeInstanceOf(NoteConflictError);
    expect(error.status).toBe(409);
  });

  it('refuses a first save for an event this site has never seen', async () => {
    await expect(saveNote(fakeStore(), { eventId: 'event-unknown', input: INPUT, etag: '', cachedEvent: null, now: NOW })).rejects.toThrow(NoteNotFoundError);
  });

  it('passes a store failure through unchanged', async () => {
    const store = fakeStore();
    store.createDoc.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 503 }));
    await expect(saveNote(store, { eventId: 'event-1', input: INPUT, etag: '', cachedEvent: cachedEvent(), now: NOW })).rejects.toThrow('boom');
  });
});

describe('saveEstimate', () => {
  const estimate = { percent: 40, reasons: ['One.', 'Two.'], madeAt: NOW().toISOString(), topicsFrom: ['Speaking hub sessions and topics'] };

  it('creates a note that holds only the estimate when none exists', async () => {
    const store = fakeStore();
    const doc = await saveEstimate(store, { eventId: 'event-1', estimate, cachedEvent: cachedEvent(), now: NOW });
    expect(doc).toMatchObject({ status: '', notes: '', costs: { travel: null, lodging: null, other: null }, estimate });
  });

  it('changes nothing else on an existing note, and tries again on the latest version after a lost race', async () => {
    const store = fakeStore();
    await saveNote(store, { eventId: 'event-1', input: INPUT, etag: '', cachedEvent: cachedEvent(), now: NOW });
    store.replaceDocIfMatch.mockRejectedValueOnce(Object.assign(new Error('precondition'), { code: 412 }));
    const doc = await saveEstimate(store, { eventId: 'event-1', estimate, cachedEvent: cachedEvent(), now: NOW });
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(2);
    expect(doc).toMatchObject({ status: 'applied', notes: INPUT.notes, costs: INPUT.costs, estimate });
  });

  it('gives up after three lost races', async () => {
    const store = fakeStore();
    await saveNote(store, { eventId: 'event-1', input: INPUT, etag: '', cachedEvent: cachedEvent(), now: NOW });
    store.replaceDocIfMatch.mockRejectedValue(Object.assign(new Error('precondition'), { code: 412 }));
    await expect(saveEstimate(store, { eventId: 'event-1', estimate, cachedEvent: cachedEvent(), now: NOW })).rejects.toThrow(NoteConflictError);
    expect(store.replaceDocIfMatch).toHaveBeenCalledTimes(3);
  });
});

describe('deleteNote', () => {
  it('deletes only the version the page read', async () => {
    const store = fakeStore();
    const doc = await saveNote(store, { eventId: 'event-1', input: INPUT, etag: '', cachedEvent: cachedEvent(), now: NOW });
    await expect(deleteNote(store, { eventId: 'event-1', etag: '' })).rejects.toThrow(NoteConflictError);
    await expect(deleteNote(store, { eventId: 'event-1', etag: '"stale"' })).rejects.toThrow(NoteConflictError);
    await deleteNote(store, { eventId: 'event-1', etag: doc._etag });
    expect(store.get(CONTAINER, noteDocId('event-1'))).toBeNull();
    await expect(deleteNote(store, { eventId: 'event-1', etag: doc._etag })).rejects.toThrow(NoteNotFoundError);
  });
});

describe('what is read back', () => {
  it('lists only notes, from the admin partition', async () => {
    const store = fakeStore([[CONTAINER, { id: 'cost_ledger', configScope: 'admin_config', docType: 'cost_ledger' }]]);
    await saveNote(store, { eventId: 'event-1', input: INPUT, etag: '', cachedEvent: cachedEvent(), now: NOW });
    const docs = await listNoteDocs(store);
    expect(docs.map((doc) => doc.eventId)).toEqual(['event-1']);
    const [, query, parameters, options] = store.queryDocs.mock.calls[0];
    expect(query).toContain('SELECT TOP 500');
    expect(parameters).toEqual([
      { name: '@scope', value: 'admin_config' },
      { name: '@type', value: NOTE_DOC_TYPE },
    ]);
    expect(options).toEqual({ partitionKey: 'admin_config' });
  });

  it('presents a note with its ETag and none of the store’s own fields, checked again', () => {
    const note = presentNote({
      id: noteDocId('event-1'),
      docType: NOTE_DOC_TYPE,
      eventId: 'event-1',
      status: 'made-up',
      notes: 'kept',
      costs: { travel: 'lots', lodging: 20, other: -3 },
      estimate: { percent: 250, reasons: ['<b>bold</b> reason', 7, 'two', 'three', 'four'], madeAt: 'never' },
      event: { title: 'T', startDate: '2027-03-06', url: 'javascript:alert(1)' },
      _etag: '"e"',
      _rid: 'x',
      _ts: 1,
    });
    expect(note).toEqual({
      eventId: 'event-1',
      status: '',
      notes: 'kept',
      costs: { travel: null, lodging: 20, other: null },
      estimate: { percent: 100, reasons: ['<b>bold</b> reason', 'two', 'three'], madeAt: null, topicsFrom: [] },
      event: { title: 'T', startDate: '2027-03-06', endDate: '2027-03-06', url: null, city: '', region: '', country: '', eventType: '', callCloses: null },
      updatedAt: null,
      etag: '"e"',
    });
    expect(presentNote({ docType: 'cost_ledger', eventId: 'event-1' })).toBeNull();
    expect(presentNote({ docType: NOTE_DOC_TYPE, eventId: 'a/b' })).toBeNull();
    expect(presentNote(null)).toBeNull();
  });

  it('reads a stored estimate or event copy of any shape', () => {
    expect(storedEstimate(null)).toBeNull();
    expect(storedEstimate({ percent: 'high' })).toBeNull();
    expect(storedEstimate({ percent: -5 }).percent).toBe(0);
    expect(eventSnapshot({ title: '', startDate: '2027-03-06' })).toBeNull();
    expect(eventSnapshot({ title: 'T', startDate: 'soon' })).toBeNull();
  });
});

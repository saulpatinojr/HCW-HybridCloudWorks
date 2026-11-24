/**
 * One Community Days event, reduced to what the site keeps (#1823). Every
 * event here is made up.
 */
import { describe, it, expect } from 'vitest';
import {
  EVENT_PAGE_BASE,
  MAX_EVENTS,
  PAGE_TEXT_MAX,
  dayOf,
  htmlToText,
  httpUrl,
  isEventId,
  normalizeEvent,
  normalizeEvents,
  presentEvent,
  talkTitles,
} from './events.js';

const raw = (over = {}) => ({
  RowKey: '00000000-0000-0000-0000-000000000001',
  slug: '2027-03-06/example-community-day-2027',
  title: 'Example Community Day 2027',
  tagline: 'A free day of talks',
  status: 'published',
  start_date: '2027-03-06T09:00',
  end_date: '2027-03-07T17:00',
  timezone: 'America/Toronto',
  event_type: 'In Person',
  location: 'Example Hall',
  city: 'Exampleville',
  state_province: 'Ontario',
  country: 'ca',
  website: 'https://example.org/day',
  cost_tiers: ['Free', 'Low Cost', 'Made up'],
  call_for_speakers_link: 'https://example.org/speak',
  speaker_call_start_date: '2026-11-01T09:00',
  speaker_call_end_date: '2027-01-15T23:59',
  home_content: '<p>Join us for a day of <strong>cloud</strong> talks.</p>',
  last_update: '2026-11-12T10:41:37.000Z',
  ...over,
});

describe('normalizeEvent', () => {
  it('keeps the fields the page uses, days as plain calendar days', () => {
    expect(normalizeEvent(raw())).toEqual({
      id: '00000000-0000-0000-0000-000000000001',
      title: 'Example Community Day 2027',
      tagline: 'A free day of talks',
      url: `${EVENT_PAGE_BASE}2027-03-06/example-community-day-2027`,
      website: 'https://example.org/day',
      startDate: '2027-03-06',
      endDate: '2027-03-07',
      timezone: 'America/Toronto',
      eventType: 'In Person',
      venue: 'Example Hall',
      city: 'Exampleville',
      region: 'Ontario',
      country: 'CA',
      costTiers: ['Free', 'Low Cost'],
      callUrl: 'https://example.org/speak',
      callOpens: '2026-11-01',
      callCloses: '2027-01-15',
      cancelled: false,
      postponed: false,
      lastUpdate: '2026-11-12T10:41:37.000Z',
      pageText: 'Join us for a day of cloud talks.',
    });
  });

  it('drops an event with no usable id, title or start day', () => {
    expect(normalizeEvent(raw({ RowKey: '' }))).toBeNull();
    expect(normalizeEvent(raw({ RowKey: 'has/slash' }))).toBeNull();
    expect(normalizeEvent(raw({ RowKey: 'a'.repeat(65) }))).toBeNull();
    expect(normalizeEvent(raw({ title: '   ' }))).toBeNull();
    expect(normalizeEvent(raw({ start_date: 'soon' }))).toBeNull();
    expect(normalizeEvent(raw({ start_date: '2027-02-30T09:00' }))).toBeNull();
    expect(normalizeEvent(null)).toBeNull();
    expect(normalizeEvent([raw()])).toBeNull();
  });

  it('treats an end before the start, or no end, as a one-day event', () => {
    expect(normalizeEvent(raw({ end_date: '2027-03-01T17:00' })).endDate).toBe('2027-03-06');
    expect(normalizeEvent(raw({ end_date: undefined })).endDate).toBe('2027-03-06');
  });

  it('keeps a link only when it is plain http or https', () => {
    const event = normalizeEvent(
      raw({ website: 'javascript:alert(1)', call_for_speakers_link: 'data:text/html,<script>1</script>' })
    );
    expect(event.website).toBeNull();
    expect(event.callUrl).toBeNull();
    expect(httpUrl('  https://example.org/a b ')).toBe('https://example.org/a%20b');
    expect(httpUrl('ftp://example.org')).toBeNull();
    expect(httpUrl(`https://example.org/${'a'.repeat(600)}`)).toBeNull();
  });

  it('builds the event page link from a well-formed slug only, never from a link the API sent', () => {
    expect(normalizeEvent(raw({ slug: '../../admin' })).url).toBeNull();
    expect(normalizeEvent(raw({ slug: 'https://evil.example.org/x' })).url).toBeNull();
    expect(normalizeEvent(raw({ slug: undefined })).url).toBeNull();
  });

  it('marks cancelled and postponed events only on a real true', () => {
    expect(normalizeEvent(raw({ is_cancelled: true, is_postponed: 'yes' }))).toMatchObject({ cancelled: true, postponed: false });
  });

  it('cuts every string to a fixed length', () => {
    const event = normalizeEvent(raw({ title: 'T'.repeat(500), tagline: 'g'.repeat(500), home_content: `<p>${'w '.repeat(5000)}</p>` }));
    expect(event.title).toHaveLength(160);
    expect(event.tagline).toHaveLength(200);
    expect(event.pageText.length).toBeLessThanOrEqual(PAGE_TEXT_MAX);
  });
});

describe('htmlToText', () => {
  it('removes tags and decodes the common entities once', () => {
    expect(htmlToText('<h2>Hello &amp; welcome</h2><ul><li>One</li><li>Two&nbsp;three</li></ul>')).toBe('Hello & welcome One Two three');
    expect(htmlToText('&#65;&#x42; &unknown; &amp;lt;')).toBe('AB &unknown; &lt;');
  });

  it('leaves a script’s text as plain words, with no tag left to run', () => {
    const out = htmlToText('<p>Hi</p><script>alert("x")</script><img src=x onerror=alert(1)>');
    expect(out).not.toMatch(/<script|<img|onerror/i);
    expect(out).toContain('Hi');
  });

  it('survives an unclosed tag and a value that is not text', () => {
    expect(htmlToText('before <a href="x')).toBe('before');
    expect(htmlToText(undefined)).toBe('');
    expect(htmlToText(42)).toBe('');
  });

  it('is bounded on a very long input', () => {
    expect(htmlToText('<'.repeat(200000)).length).toBeLessThanOrEqual(PAGE_TEXT_MAX);
    expect(htmlToText('x'.repeat(200000))).toHaveLength(PAGE_TEXT_MAX);
  });
});

describe('dayOf and isEventId', () => {
  it('takes the leading calendar day, whatever follows it', () => {
    expect(dayOf('2027-03-06T23:59')).toBe('2027-03-06');
    expect(dayOf('2027-03-06')).toBe('2027-03-06');
    expect(dayOf('2027-13-01')).toBeNull();
    expect(dayOf('06/03/2027')).toBeNull();
    expect(dayOf(null)).toBeNull();
  });

  it('accepts ids that are safe to store under', () => {
    expect(isEventId('00000000-0000-0000-0000-000000000001')).toBe(true);
    for (const bad of ['', 'a/b', 'a?b', 'a#b', 'a b', '-lead', '__proto__/x', 5, null]) expect(isEventId(bad), String(bad)).toBe(false);
  });
});

describe('normalizeEvents, talkTitles and presentEvent', () => {
  it('keeps one entry per id, counts what it dropped, and stops at MAX_EVENTS', () => {
    const many = Array.from({ length: MAX_EVENTS + 5 }, (_, n) => raw({ RowKey: `event-${n}` }));
    const { events, skipped } = normalizeEvents([raw(), raw(), { nope: true }, ...many]);
    expect(events).toHaveLength(MAX_EVENTS);
    // One repeat, one unusable, and the six past the limit.
    expect(skipped).toBe(8);
    expect(normalizeEvents('nope')).toEqual({ events: [], skipped: 0 });
  });

  it('reads talk titles once each, in order', () => {
    expect(talkTitles([{ title: 'Made-up talk' }, { title: 'made-up TALK' }, { title: '' }, null, { title: 'Second one' }])).toEqual([
      'Made-up talk',
      'Second one',
    ]);
    expect(talkTitles(Array.from({ length: 80 }, (_, n) => ({ title: `Talk ${n}` })))).toHaveLength(40);
  });

  it('sends the page an excerpt, not the whole page text', () => {
    const shown = presentEvent(normalizeEvent(raw({ home_content: `<p>${'word '.repeat(400)}</p>` })));
    expect(shown.pageText).toBeUndefined();
    expect(shown.excerpt.length).toBeLessThanOrEqual(320);
    expect(shown.hasPageText).toBe(true);
  });
});

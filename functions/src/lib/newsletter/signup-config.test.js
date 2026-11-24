/**
 * GET public/newsletter/signup-config — the load-bearing assertions: the
 * answer carries exactly three keys whatever the settings document holds (it
 * also holds a postal address and a reply-to inbox), and nothing that goes
 * wrong reading it can take the signup box off the site.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_SIGNUP_CONFIG,
  SIGNUP_CONFIG_CACHE_SECONDS,
  createSignupConfigHandler,
} from './signup-config.js';
import {
  DEFAULT_SIGNUP_BLURB,
  DEFAULT_SIGNUP_HEADING,
  MAX_SIGNUP_BLURB_LENGTH,
  MAX_SIGNUP_HEADING_LENGTH,
  NEWSLETTER_SETTINGS_CONFIG_ID,
  SIGNUP_PLACEMENTS,
} from './settings.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';

const STORED = {
  id: 'newsletter_settings',
  configScope: ADMIN_CONFIG_PARTITION,
  postalAddress: 'PO Box 1, Austin, TX 78701',
  replyTo: 'owner@example.com',
  sendDay: 'thursday',
  sendTime: '07:30',
  timeZone: 'Europe/London',
  introEnabled: false,
  introTone: 'concise',
  signupPlacement: 'footer',
  signupHeading: '<b>Weekly</b> cloud notes',
  signupBlurb: 'One email a week.',
  updatedAt: '2026-09-10T00:00:00Z',
  updatedBy: 'owner-oid',
  _etag: '"abc"',
};

const makeContext = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

async function call(readDoc) {
  const store = { readDoc: vi.fn(readDoc) };
  const context = makeContext();
  const res = await createSignupConfigHandler({ store })({ method: 'GET' }, context);
  return { res, body: JSON.parse(res.body), store, context };
}

describe('GET public/newsletter/signup-config', () => {
  it('answers only placement, heading and blurb from the stored settings', async () => {
    const { res, body, store } = await call(async () => STORED);
    expect(res.status).toBe(200);
    expect(body).toEqual({
      placement: 'footer',
      heading: '<b>Weekly</b> cloud notes',
      blurb: 'One email a week.',
    });
    expect(Object.keys(body).sort()).toEqual(['blurb', 'heading', 'placement']);
    expect(store.readDoc).toHaveBeenCalledWith(
      'admin_config',
      NEWSLETTER_SETTINGS_CONFIG_ID,
      ADMIN_CONFIG_PARTITION
    );
  });

  it('never carries the postal address, the reply-to or any other stored value', async () => {
    const { res } = await call(async () => STORED);
    for (const secret of ['PO Box 1', 'owner@example.com', 'Europe/London', 'owner-oid', 'concise']) {
      expect(res.body.includes(secret), secret).toBe(false);
    }
    for (const key of ['postalAddress', 'replyTo', 'sendDay', 'updatedBy', 'id', '_etag']) {
      expect(res.body.includes(key), key).toBe(false);
    }
  });

  it('is cacheable by browsers and the CDN for five minutes', async () => {
    const { res } = await call(async () => STORED);
    expect(SIGNUP_CONFIG_CACHE_SECONDS).toBe(300);
    expect(res.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    });
  });

  it('asks for no identity: an anonymous request with no headers is answered', async () => {
    const store = { readDoc: vi.fn(async () => STORED) };
    const res = await createSignupConfigHandler({ store })({}, undefined);
    expect(res.status).toBe(200);
  });

  it('answers the defaults with 200, and logs why, when the store read fails', async () => {
    const { res, body, context } = await call(async () => {
      throw new Error('Cosmos unavailable');
    });
    expect(res.status).toBe(200);
    expect(body).toEqual({ placement: 'both', heading: DEFAULT_SIGNUP_HEADING, blurb: DEFAULT_SIGNUP_BLURB });
    expect(res.headers['Cache-Control']).toBe('public, max-age=300');
    expect(context.warn).toHaveBeenCalledWith(expect.stringMatching(/settings read failed.*: name=Error\b/));
    expect(context.warn.mock.calls.flat().join(' ')).not.toContain('Cosmos unavailable');
  });

  it('answers the defaults when nothing has been saved yet', async () => {
    const { body, context } = await call(async () => null);
    expect(body).toEqual({ ...DEFAULT_SIGNUP_CONFIG });
    expect(context.warn).not.toHaveBeenCalled();
  });

  it('answers the defaults for a document saved before the signup fields existed', async () => {
    const legacy = { ...STORED };
    delete legacy.signupPlacement;
    delete legacy.signupHeading;
    delete legacy.signupBlurb;
    const { body } = await call(async () => legacy);
    expect(body).toEqual({ ...DEFAULT_SIGNUP_CONFIG });
  });

  it('answers the defaults, and logs the problem without the stored values, for a document that does not validate', async () => {
    const { body, context } = await call(async () => ({ ...STORED, signupPlacement: 'sidebar' }));
    expect(body).toEqual({ ...DEFAULT_SIGNUP_CONFIG });
    expect(context.warn).toHaveBeenCalledWith(expect.stringContaining('signupPlacement must be one of'));
    const logged = context.warn.mock.calls.flat().join(' ');
    expect(logged.includes('PO Box 1')).toBe(false);
    expect(logged.includes('owner@example.com')).toBe(false);
  });

  it('defaults to the box in both places', () => {
    expect(DEFAULT_SIGNUP_CONFIG.placement).toBe('both');
  });
});

describe('the site keeps the same defaults as the server', () => {
  // The site paints these before the API answers and in the pre-rendered
  // HTML; if they drifted from the server's, a page would change wording on
  // load for every visitor to a site whose owner never changed anything.
  const site = readFileSync(
    join(process.cwd(), '..', 'frontend', 'src', 'lib', 'newsletterSignup.js'),
    'utf8'
  );

  it('carries the same heading, blurb, placement and limits', () => {
    expect(site.includes(`heading: '${DEFAULT_SIGNUP_HEADING}'`)).toBe(true);
    expect(site.includes(`'${DEFAULT_SIGNUP_BLURB}'`)).toBe(true);
    expect(site.includes(`placement: '${DEFAULT_SIGNUP_CONFIG.placement}'`)).toBe(true);
    expect(site.includes(`MAX_SIGNUP_HEADING_LENGTH = ${MAX_SIGNUP_HEADING_LENGTH};`)).toBe(true);
    expect(site.includes(`MAX_SIGNUP_BLURB_LENGTH = ${MAX_SIGNUP_BLURB_LENGTH};`)).toBe(true);
    const placements = SIGNUP_PLACEMENTS.map((p) => `'${p}'`).join(', ');
    expect(site.includes(`SIGNUP_PLACEMENTS = Object.freeze([${placements}])`)).toBe(true);
  });
});

// @vitest-environment node
/**
 * The Cloudflare Web Analytics beacon is whole or absent (#1302).
 *
 * Three things nothing else would catch: a build without the token must
 * leave no trace of the tag in index.html; a build with a value that is not
 * a token must fail rather than serve it as markup; and the tag, once in the
 * template, must survive the pre-render that rewrites every page's head —
 * because the page views the beacon counts are the pre-rendered pages.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BEACON_SRC,
  TOKEN_PATTERN,
  beaconTag,
  cfWebAnalyticsPlugin,
  injectBeacon,
} from './cf-web-analytics.mjs';
import { injectIntoTemplate } from './prerender.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(here, '..', 'index.html'), 'utf8');

/** A real-shaped site token: 32 hex characters, as the Cloudflare dashboard shows one. */
const TOKEN = '0123456789abcdef0123456789abcdef';

describe('beaconTag', () => {
  it('emits the standard Cloudflare tag, deferred, with the token JSON-encoded in data-cf-beacon', () => {
    expect(beaconTag(TOKEN)).toBe(
      `<script defer src="${BEACON_SRC}" data-cf-beacon='{"token":"${TOKEN}"}'></script>`
    );
    expect(BEACON_SRC).toBe('https://static.cloudflareinsights.com/beacon.min.js');
  });

  it('trims the value, as the other build variables are trimmed', () => {
    expect(beaconTag(`  ${TOKEN}\n`)).toBe(beaconTag(TOKEN));
  });

  it.each([[''], ['   '], [undefined], [null]])('emits nothing for %j', (value) => {
    expect(beaconTag(value)).toBe('');
  });

  it.each([
    ['a URL', 'https://static.cloudflareinsights.com/beacon.min.js'],
    ['the whole snippet', `<script defer src="x" data-cf-beacon='{"token": "${TOKEN}"}'></script>`],
    ['a quote', `${TOKEN.slice(0, 20)}"`],
    ['too short', 'abc123'],
    ['too long', 'a'.repeat(65)],
    ['a hyphen', '0123456789ab-def0123456789abcdef'],
  ])('refuses %s, naming the variable', (_what, value) => {
    expect(() => beaconTag(value)).toThrow(
      /VITE_CF_WEB_ANALYTICS_TOKEN is not a Cloudflare Web Analytics site token/
    );
  });

  it('accepts exactly the documented shape and a little slack, nothing broader', () => {
    expect(TOKEN_PATTERN.test(TOKEN)).toBe(true);
    expect(TOKEN_PATTERN.test('a'.repeat(16))).toBe(true);
    expect(TOKEN_PATTERN.test('a'.repeat(64))).toBe(true);
    expect(TOKEN_PATTERN.test('a'.repeat(15))).toBe(false);
    expect(TOKEN_PATTERN.test(`${TOKEN} `)).toBe(false);
  });
});

describe('injectBeacon on the real index.html', () => {
  it('puts the tag inside <head> when the token is set', () => {
    const html = injectBeacon(INDEX_HTML, TOKEN);
    const [, head] = /<head>([\s\S]*?)<\/head>/i.exec(html);
    expect(head).toContain(beaconTag(TOKEN));
    expect(html.match(/beacon\.min\.js/g)).toHaveLength(1);
  });

  it('leaves index.html byte-for-byte unchanged when the token is empty: no attribute, no comment, no blank line', () => {
    expect(injectBeacon(INDEX_HTML, '')).toBe(INDEX_HTML);
    expect(injectBeacon(INDEX_HTML, undefined)).toBe(INDEX_HTML);
    // And the committed template carries no beacon of its own, so a build
    // without the variable really does serve none.
    expect(INDEX_HTML).not.toContain('cloudflareinsights');
    expect(INDEX_HTML).not.toContain('data-cf-beacon');
  });

  it('survives the pre-render of a route and the SPA fallback shell alike', () => {
    // scripts/prerender.mjs reads the built index.html as its template,
    // removes only the title and the canonical, and writes the untouched
    // template as app-shell.html. If either side ever strips unknown script
    // tags, the beacon disappears from every page and nothing else notices.
    const template = injectBeacon(INDEX_HTML, TOKEN);
    const page = injectIntoTemplate(
      template,
      { head: '<title>About</title>', body: '<main>About</main>' },
      '/about'
    );
    expect(page).toContain(beaconTag(TOKEN));
    expect(page.match(/beacon\.min\.js/g)).toHaveLength(1);
    // The shell is the template itself.
    expect(template).toContain(beaconTag(TOKEN));
  });
});

describe('cfWebAnalyticsPlugin', () => {
  it('is a Vite plugin whose transformIndexHtml adds the tag, and logs the decision without the token', () => {
    const log = vi.fn();
    const plugin = cfWebAnalyticsPlugin(TOKEN, { log });
    expect(plugin.name).toBe('hcw-cf-web-analytics');
    expect(plugin.transformIndexHtml(INDEX_HTML)).toContain(beaconTag(TOKEN));
    expect(log).toHaveBeenCalledWith('Cloudflare Web Analytics beacon: on');
    expect(log.mock.calls.flat().join(' ')).not.toContain(TOKEN);
  });

  it('with no token says so and transforms nothing', () => {
    const log = vi.fn();
    const plugin = cfWebAnalyticsPlugin('', { log });
    expect(plugin.transformIndexHtml(INDEX_HTML)).toBe(INDEX_HTML);
    expect(log).toHaveBeenCalledWith(
      'Cloudflare Web Analytics beacon: off (no VITE_CF_WEB_ANALYTICS_TOKEN)'
    );
  });

  it('fails the build at config time on a malformed token', () => {
    expect(() => cfWebAnalyticsPlugin('not a token!', { log: vi.fn() })).toThrow(
      /VITE_CF_WEB_ANALYTICS_TOKEN/
    );
  });
});

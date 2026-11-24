/**
 * The site only READS from Community Days, and this test is what holds it to
 * that (#1823, ADR 0045).
 *
 * WHY A TEST. The Community Days key is not read-only: the same key can
 * create, change and delete the owner's events, speaker profile and
 * organization, and the vendor offers no narrower key. Nothing at the vendor
 * stops this site from doing those things, so the rule has to live here. The
 * site makes two calls, both GET: the list of published events and the
 * owner's talks.
 *
 * WHAT IT CHECKS, by reading the source:
 *
 *   1. The API's host is written in ONE source file, the client. Any other
 *      file that names it fails, so a second caller cannot appear quietly.
 *      (The Test button imports the client's own URL constant.)
 *   2. In the client, every path under that host is one of the two reads,
 *      and no word that names a writing HTTP method appears at all.
 *   3. The API's whole list of paths (from its public OpenAPI description, as
 *      read on 2026-11-24) is checked against the client's text: none of the
 *      others appears in it.
 *   4. At run time, the client refuses a path outside the two before sending
 *      anything, and sends GET whatever it is given.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import * as client from './client.js';

const SRC = fileURLToPath(new URL('../..', import.meta.url));
const CLIENT_FILE = 'lib/community-days/client.js';
// The API's host. The public website (www.) is a different host: events.js builds
// plain links to event pages on it, which call nothing.
const HOST = 'api.communitydays.org';

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) out.push(full);
  }
  return out;
}

/** Source with its comments removed, so a comment that explains a rule cannot break or satisfy it. */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const clientCode = code(readFileSync(join(SRC, CLIENT_FILE), 'utf8'));

/**
 * The first segment of every path the API serves besides the two this site
 * reads (https://api.communitydays.org/v1/openapi-events.json, read
 * 2026-11-24). A new one at the vendor is not a risk by itself: rule 2 below
 * already refuses any path that is not one of the two.
 */
const OTHER_API_PATHS = [
  '/organizations',
  '/organization-invites',
  '/events',
  '/speakers',
  '/profile/photo',
  '/profile/incognito',
  '/published-events/{',
];

describe('the site only reads from Community Days', () => {
  it('names the API’s host in the client and in no other source file', () => {
    const naming = sourceFiles(SRC)
      .filter((file) => code(readFileSync(file, 'utf8')).toLowerCase().includes(HOST))
      .map((file) => relative(SRC, file).replace(/\\/g, '/'));
    expect(naming, 'a second file calls or names the Community Days API; route it through the client').toEqual([CLIENT_FILE]);
  });

  it('scans a client that really has the calls in it', () => {
    // A scan of an empty or renamed file would pass every check below.
    expect(clientCode).toContain("'/published-events'");
    expect(clientCode).toContain("'/profile/talks'");
    expect(clientCode).toContain("method: 'GET'");
  });

  it('writes no HTTP method but GET in the client', () => {
    const methods = [...clientCode.matchAll(/method\s*:\s*([^,\n}]+)/g)].map((match) => match[1].trim());
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((value) => value === "'GET'"), `methods found: ${methods.join(', ')}`).toBe(true);
    expect(clientCode).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    // No request body is ever sent.
    expect(clientCode).not.toMatch(/\bbody\s*:/);
  });

  it('writes no path but the two reads in the client', () => {
    // Every quoted string that starts with a slash is a path.
    const paths = [...clientCode.matchAll(/['"`](\/[A-Za-z][^'"`\s]*)['"`]/g)].map((match) => match[1]);
    expect([...new Set(paths)].sort()).toEqual(['/profile/talks', '/published-events']);
    for (const other of OTHER_API_PATHS) {
      expect(clientCode.includes(`'${other}`) || clientCode.includes(`\`${other}`), `the client names ${other}`).toBe(false);
    }
  });

  it('exports nothing that could send another call', () => {
    const made = client.createCommunityDaysClient({ apiKey: 'cdo_test_not-a-real-key-EXAMPLE' });
    expect(Object.keys(made).sort()).toEqual(['listOpenCalls', 'listTalks']);
    expect(client.ALLOWED_PATHS).toEqual(['/published-events', '/profile/talks']);
    expect(Object.isFrozen(client.ALLOWED_PATHS)).toBe(true);
  });

  it('sends GET to one of the two paths on the API’s own host, whatever happens', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '{"events":[],"talks":[],"next_page":null}',
    }));
    const made = client.createCommunityDaysClient({
      apiKey: 'cdo_test_not-a-real-key-EXAMPLE',
      fetchImpl,
      resolve: async () => ({ address: '93.184.216.34' }),
      dispatcherFor: () => null,
    });
    await made.listOpenCalls();
    await made.listTalks();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchImpl.mock.calls) {
      const target = new URL(url);
      expect(target.origin).toBe('https://api.communitydays.org');
      expect(['/v1/published-events', '/v1/profile/talks']).toContain(target.pathname);
      expect(options.method).toBe('GET');
      expect(options.body).toBeUndefined();
    }
  });
});

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
 *   1. The API's host is written in ONE source file, api.js, which holds
 *      constants only (no import, no call). Any other file that names the
 *      host fails, and only the client and the Test button's table may take
 *      the address from that file; nothing passes it on (rule 1b below).
 *   2. Every path written is one of the two reads, and in the client no word
 *      that names a writing HTTP method appears at all.
 *   3. The API's whole list of paths (from its public OpenAPI description, as
 *      read on 2026-11-24) is checked against the client's text: none of the
 *      others appears in it.
 *   4. At run time, the client refuses a path outside the two before sending
 *      anything, and sends GET whatever it is given.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import * as api from './api.js';
import * as client from './client.js';

const SRC = fileURLToPath(new URL('../..', import.meta.url));
const CLIENT_FILE = 'lib/community-days/client.js';
// The one file that names the API's host: constants only, no imports, no calls.
const API_FILE = 'lib/community-days/api.js';
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
const apiCode = code(readFileSync(join(SRC, API_FILE), 'utf8'));

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
  it('names the API’s host in one constants file, which imports nothing and sends nothing', () => {
    const naming = sourceFiles(SRC)
      .filter((file) => code(readFileSync(file, 'utf8')).toLowerCase().includes(HOST))
      .map((file) => relative(SRC, file).replace(/\\/g, '/'));
    expect(naming, 'a second file names the Community Days API; route it through the client').toEqual([API_FILE]);
    expect(apiCode).not.toMatch(/\bimport\b|\bfetch\b|\brequire\(/);
  });

  it('lets only the client and the Test button take the address from that file, and nothing pass it on', () => {
    const found = sourceFiles(SRC).flatMap((file) => apiUses(file, code(readFileSync(file, 'utf8'))));
    // The scan sees the two real callers; a scan that saw nothing would pass everything below.
    const takers = [...new Set(found.filter((use) => use.takesAddress).map((use) => use.file))].sort();
    expect(takers, 'only these two files may import the Community Days address').toEqual(MAY_TAKE_ADDRESS);
    // Every other use of the file is a plain import of names that are not the address.
    const unclear = found.filter((use) => use.kind !== 'import' || use.names === null).map((use) => `${use.file}: ${use.kind}`);
    expect(unclear, 'api.js is passed on, loaded whole, or loaded at run time; import the names needed, by name').toEqual([]);
    // The client hands the address to no one.
    for (const name of ADDRESS_NAMES) expect(Object.keys(client), `client.js exports ${name}`).not.toContain(name);
  });

  it('would catch each way of taking the address quietly', () => {
    // The scan above, run on made-up files, so a gap in it shows here and not in production.
    const uses = (file, text) => apiUses(join(SRC, file), text);
    const here = 'lib/community-days/other.js';
    expect(uses(here, "import { API_BASE } from './api.js';")).toEqual([{ file: here, kind: 'import', names: ['API_BASE'], takesAddress: true }]);
    expect(uses(here, "import { API_KEY_SETTING, PROBE_URL as url } from './api.js';")[0]).toMatchObject({ takesAddress: true });
    expect(uses(here, "import {\n  API_KEY_SETTING,\n  API_BASE,\n} from './api.js';")[0]).toMatchObject({ takesAddress: true });
    expect(uses(here, "import { API_KEY_SETTING } from './api.js';")[0]).toMatchObject({ kind: 'import', takesAddress: false });
    // Loaded whole, passed on, or loaded at run time: the names cannot be counted, so each is refused.
    expect(uses(here, "import * as all from './api.js';")[0]).toMatchObject({ names: null, takesAddress: true });
    expect(uses(here, "export { API_BASE } from './api.js';")[0]).toMatchObject({ kind: 'export', takesAddress: true });
    expect(uses(here, "export * from './api.js';")[0]).toMatchObject({ kind: 'export', takesAddress: true });
    expect(uses(here, "const all = await import('./api.js');")[0]).toMatchObject({ kind: 'dynamic', takesAddress: true });
    expect(uses('lib/other/far.js', 'import { PROBE_URL } from "../community-days/api.js";')[0]).toMatchObject({ takesAddress: true });
    // Another folder's own api.js is a different file.
    expect(uses('lib/other/far.js', "import { API_BASE } from './api.js';")).toEqual([]);
  });

  it('scans a client that really has the calls in it', () => {
    // A scan of an empty or renamed file would pass every check below.
    expect(apiCode).toContain("'/published-events'");
    expect(apiCode).toContain("'/profile/talks'");
    expect(clientCode).toContain("method: 'GET'");
    expect(clientCode).toContain('ALLOWED_PATHS.includes(path)');
  });

  it('writes no HTTP method but GET in the client', () => {
    const methods = [...clientCode.matchAll(/method\s*:\s*([^,\n}]+)/g)].map((match) => match[1].trim());
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((value) => value === "'GET'"), `methods found: ${methods.join(', ')}`).toBe(true);
    expect(clientCode).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    // No request body is ever sent.
    expect(clientCode).not.toMatch(/\bbody\s*:/);
  });

  it('writes no path but the two reads, in the constants file or the client', () => {
    // Every quoted string that starts with a slash is a path.
    const pathsIn = (text) => [...text.matchAll(/['"`](\/[A-Za-z][^'"`\s]*)['"`]/g)].map((match) => match[1]);
    expect([...new Set(pathsIn(apiCode))].sort()).toEqual(['/profile/talks', '/published-events']);
    // The client writes no path of its own: it uses the two named constants.
    expect(pathsIn(clientCode)).toEqual([]);
    for (const other of OTHER_API_PATHS) {
      for (const text of [apiCode, clientCode]) {
        expect(text.includes(`'${other}`) || text.includes(`\`${other}`), `${other} is named`).toBe(false);
      }
    }
  });

  it('exports nothing that could send another call', () => {
    const made = client.createCommunityDaysClient({ apiKey: 'cdo_test_not-a-real-key-EXAMPLE' });
    expect(Object.keys(made).sort()).toEqual(['listOpenCalls', 'listTalks']);
    expect(api.ALLOWED_PATHS).toEqual(['/published-events', '/profile/talks']);
    expect(Object.isFrozen(api.ALLOWED_PATHS)).toBe(true);
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

// The scan for rule 1b. It sits below the tests so that the lines above keep
// their place; the tests run after the whole file has loaded, so they see it.

/** The names under which api.js exports the API's address (the base, and the Test button's full URL). */
const ADDRESS_NAMES = Object.keys(api).filter((name) => typeof api[name] === 'string' && api[name].includes('://'));
/** The only files that may import one of them. */
const MAY_TAKE_ADDRESS = [CLIENT_FILE, 'lib/integrations/connection-probe.js'];

/**
 * Every place `text` (the source of `file`, comments removed) loads api.js:
 * a static import, a re-export, or a run-time `import()` or `require()`. The
 * module's path is worked out from the file's own folder, so `./api.js` in
 * another folder is not mistaken for this one.
 *
 * `names` is the list of names imported, or null when they cannot be listed
 * (the whole module, a default, or a run-time load). `takesAddress` is true
 * when one of the names is the address, or when the names cannot be listed.
 */
function apiUses(file, text) {
  const target = join(SRC, API_FILE);
  const name = relative(SRC, file).replace(/\\/g, '/');
  const isApi = (specifier) => specifier.startsWith('.') && resolve(dirname(file), specifier) === target;
  const uses = [];
  for (const match of text.matchAll(/\b(import|export)\b([^;'"`]*?)\bfrom\s*['"]([^'"]+)['"]/g)) {
    const [, kind, clause, specifier] = match;
    if (!isApi(specifier)) continue;
    const braces = /^\s*\{([^}]*)\}\s*$/.exec(clause);
    // The name before any `as`: `PROBE_URL as url` takes PROBE_URL.
    const names = braces ? braces[1].split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean) : null;
    const takesAddress = kind === 'export' || names === null || names.some((taken) => ADDRESS_NAMES.includes(taken));
    uses.push({ file: name, kind, names, takesAddress });
  }
  for (const match of text.matchAll(/\b(?:import|require)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
    if (isApi(match[1])) uses.push({ file: name, kind: 'dynamic', names: null, takesAddress: true });
  }
  return uses;
}

/**
 * `PROVIDER_FEEDS` as functions/src/lib/rss/feeds.js declares it: the feeds
 * the server actually reads. For tests only; it needs Node's `fs` and `vm`,
 * and nothing the browser loads imports it.
 *
 * The server module cannot be imported from here: it imports an HTML parser
 * that only `functions/` installs, and CI's frontend job installs nothing
 * else. So the object literal is cut out of the file and evaluated on its
 * own. It is plain data (strings, arrays, objects and comments), which is
 * what makes that safe, and a file the cut cannot find throws rather than
 * reading as an empty list. `.github/workflows/ci.yml` runs the frontend job
 * when that file changes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { runInNewContext } from 'node:vm';

export const SERVER_FEEDS_FILE = join(
  process.cwd(),
  '..',
  'functions',
  'src',
  'lib',
  'rss',
  'feeds.js'
);

const START = 'export const PROVIDER_FEEDS = Object.freeze(';

export function readServerFeeds(source = readFileSync(SERVER_FEEDS_FILE, 'utf8')) {
  const start = source.indexOf(START);
  if (start === -1) throw new Error(`the server feed file no longer declares "${START}"`);
  const from = start + START.length;
  const end = source.indexOf('\n});', from);
  if (end === -1) throw new Error('the server feed list has no closing "});"');
  const literal = runInNewContext(`(${source.slice(from, end + 2)})`, Object.create(null));
  // A JSON round trip: the literal was built in another realm, and a
  // cross-realm array is not "equal" to a local one to every matcher.
  return JSON.parse(JSON.stringify(literal));
}

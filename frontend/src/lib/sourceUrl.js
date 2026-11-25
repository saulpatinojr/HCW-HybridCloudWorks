/**
 * Classify an owner-typed URL as a source for a source-grounded Listen & Learn
 * episode (#433): a YouTube video, a web page, or neither.
 *
 * The rule is the server's — `isYouTubeVideoUrl` and the branches of
 * `validateGroundingSources` in functions/src/lib/ai/router.js — restated
 * here so the form can show what each line will be treated as before it is
 * sent, and refuse what the server would refuse without a round trip. The two
 * are pinned equal by a test on the functions side
 * (listen-and-learn/source-episode.test.js), which imports THIS file and runs
 * both over one table of URLs; that is why this module has no imports and no
 * `@/` alias — it has to load under plain Node.
 *
 * What the server decides, this does not: the caps (20 pages, 10 videos) and
 * deduplication are the router's, and the form shows its sentence when a list
 * is refused for them.
 */

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);

/** A YouTube video id: the characters YouTube uses, and at least one of them. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * youtube.com/watch?v=<id>, youtube.com/shorts/<id> or youtu.be/<id>, with an
 * actual id. A playlist, a channel page or `watch?v=` with nothing after it is
 * none of those.
 */
export function isYouTubeVideoUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return false;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (host === 'youtu.be') return segments.length === 1 && YOUTUBE_ID.test(segments[0]);
  if (parsed.pathname === '/watch') return YOUTUBE_ID.test(parsed.searchParams.get('v') || '');
  return segments.length === 2 && segments[0] === 'shorts' && YOUTUBE_ID.test(segments[1]);
}

/** `{ parsed }` for an http(s) address, or `{ error }` saying what is wrong with it. */
function parseHttpUrl(url) {
  if (!url) return { error: 'is empty' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'is not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'is not an http(s) URL' };
  }
  return { parsed };
}

/**
 * One line of the form → `{ kind: 'page'|'video', url }` or `{ url, error }`.
 * The error is a sentence for the person typing, in the server's words.
 */
export function classifySourceUrl(raw) {
  const url = String(raw || '').trim();
  const { parsed, error } = parseHttpUrl(url);
  if (error) return { url, error };
  if (isYouTubeVideoUrl(url)) return { kind: 'video', url };
  if (YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) {
    return {
      url,
      error: 'is a YouTube page that is not a video; only a YouTube video can be watched',
    };
  }
  return { kind: 'page', url };
}

/**
 * The textarea's contents, one URL per line, classified. Blank lines are
 * skipped; everything else is kept, valid or not, so the form can show each
 * line's verdict beside it rather than silently dropping one.
 */
export function classifySourceLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(classifySourceUrl);
}

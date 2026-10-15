/**
 * host-publish.js — put one approved episode on Podbean, idempotently (#437,
 * ADR 0029 §1b, §1c).
 *
 * ## The contract
 *
 * `publishEpisodeToHost` takes the episode document and returns THE PATCH TO
 * STORE on it. It never throws past itself, and it never touches `status`,
 * `approvedAt` or `approvedBy` — a publish failure does not un-approve an
 * episode. What it writes lives entirely under `host.podbean`:
 *
 *     host.podbean = {
 *       episodeId,      // Podbean's episode id (e.g. 'IWPNG2FB3F') — the idempotency key
 *       permalinkUrl,   // the episode's page on the show's Podbean site
 *       mediaUrl,       // the audio URL Podbean serves
 *       hostStatus,     // the episode's status as last seen: 'draft' | 'publish'
 *       audioPath,      // the blob path Podbean currently has audio FROM
 *       fileKey,        // the uploadAuthorize file_key that audio went up under
 *       publishedAt,    // first successful publish, never rewritten
 *       firstAttemptAt, // the first run, success or not, never rewritten
 *       lastAttemptAt,  // every run, success or not
 *       adoptedAt,      // set when the id came from reconciliation, not a create
 *       error,          // null on success; { status, code, message, retryable } on failure
 *     }
 *
 * Podbean answers no guid, so none is recorded; the feed ingest keys on the
 * guid it reads from the feed, as it always did.
 *
 * The caller (the approval hook and the admin retry, publish-transcript.js)
 * merges the patch onto the document. This file does not know the store.
 *
 * ## Idempotent on `host.podbean.episodeId`
 *
 * The first successful run creates the Podbean episode and records its id.
 * Every run after that updates the same id (`POST /v1/episodes/{id}`) —
 * metadata always, audio only when `doc.audioPath` differs from
 * `host.podbean.audioPath` — so a retry after a timeout, a regenerated
 * episode, or an edited summary all converge on one episode. A second create
 * is the one thing this file must never do, because the feed is public and
 * the ingest keys `podcasts` rows on the feed guid: two episodes are two site
 * rows.
 *
 * ## A create whose answer was lost (#1118)
 *
 * The weak spot is a create that succeeded upstream but whose response was
 * lost before the id was recorded: a timeout, a dropped connection, a 5xx
 * after the write. Podbean's API takes no client-chosen idempotency key, so
 * the next run cannot ask "did that land?" by key. It asks by listing instead
 * (CodeRabbit on #1117 held this to be fixed before merge, rightly: a
 * duplicate on the public feed is the failure #437 lists first).
 *
 * Before any create on a document that has an earlier attempt on record and
 * no episode id, `findUnrecordedEpisode` reads the show's newest episodes
 * (`GET /v1/episodes`). An episode with the same title, published inside
 * the span this document's attempts could have created it in, is the one
 * they made. The span runs from `RECONCILE_WINDOW_MS` before the FIRST
 * attempt to `ATTEMPT_SPAN_MS` plus that margin after the LAST recorded one.
 * It is adopted (its id recorded, `adoptedAt` set) and updated, audio
 * re-sent, never created twice.
 * - **The lower bound** keeps an older, unrelated episode with the same title
 *   from being taken over: it was published before this document was ever
 *   tried.
 * - **The upper bound** does the same for a newer one, published after
 *   every recorded attempt had ended, perhaps by hand. A late retry must not
 *   adopt it.
 * - **Fails closed:** if the listing fails, or a recorded attempt time is
 *   unreadable, nothing is created. A run that cannot tell whether the
 *   episode exists records the failure and leaves the next retry to find
 *   out.
 *
 * One case stays open: a process killed after its create landed but before
 * its record was written leaves no attempt time for that run, so a much later
 * retry falls outside the upper bound. The job timeout makes that a crash
 * inside one function invocation, not a lost response.
 *
 * Two runs at once on one document are not this file's concern: the job
 * scheduler refuses a second publish while one is queued or in flight, and
 * since #1118's second half its pending marker is an etag-conditional
 * reservation (publish-transcript.js, "One reservation per document"), so
 * two schedules landing in the same instant queue one job and creates on
 * one document are serial. The listing above answers a create whose reply
 * was lost; it could not tell two live creates apart, which is why the
 * reservation has to be the thing that is atomic.
 *
 * ## What Podbean is told
 *
 * `describeForHost` is pure and tested on its own:
 *
 * - `status: 'publish'`, on the first publish and every update. The site's
 *   approval is the review; an episode reaches this file only once a
 *   publisher has approved it, so it goes out at once, as it would have on
 *   RSS.com. A retry from the hub therefore re-publishes an episode someone
 *   drafted by hand in Podbean, which is what pressing Publish means.
 * - `type: 'public'` and `apple_episode_type: 'full'`.
 * - `content` is HTML, because that is what Podbean renders ("HTML code
 *   except style and script is supported"): the summary and the key
 *   takeaways as paragraphs and a list, every character of the text
 *   HTML-escaped, and nothing but `<p>`, `<br>`, `<ul>`, `<li>` and `<a>`.
 * - The article link. RSS.com had a `custom_link` field; Podbean has none, so
 *   the article's public URL, when there is one, is the last paragraph of
 *   `content` as a link.
 * - No AI flag. RSS.com's `ai_content` has no Podbean counterpart, so it is
 *   dropped rather than smuggled into another field.
 */
import { storedFailure } from '../http/error-response.js';
import { PodbeanError } from './podbean.js';

/**
 * Podbean documents no length limit for `title` or `content`. These caps are
 * this site's, kept from the RSS.com client where they were the host's: a
 * podcast app shows far fewer characters than 250 for a title, and episode
 * notes past a few thousand characters are a page, not notes. A cap here is a
 * deliberate choice, not a host rule, so a long field is cut cleanly rather
 * than sent whole to an API that has not said what it does with it.
 */
export const HOST_TITLE_MAX = 250;
export const HOST_CONTENT_TEXT_MAX = 4000;
export const HOST_LINK_MAX = 500;

export const DEFAULT_AUDIO_MIME = 'audio/mpeg';

const clean = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/** The five characters that change meaning in HTML text and attribute values. */
const escapeHtml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Cut to at most `max` characters with an ellipsis. The cut lands on the
 * last space inside the prefix when that space is past the halfway point;
 * otherwise it is a hard character cut. So a long sentence is cut between
 * words, and one unbroken run of characters — a URL, a slug, a pasted hash —
 * is cut mid-run rather than dropped to almost nothing. That is the right
 * trade for a title and episode notes: the host shows them, nothing parses
 * them, and a visibly truncated token is better than a half-empty field.
 */
function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The plain-text notes, capped — summary, then the takeaways as a dash list
 * — and then that text as HTML: a blank line is a paragraph break, a line
 * break inside one is `<br>`. Built as text first so the cap counts what a
 * listener reads, not markup, and so the cut can never land inside a tag.
 */
function notesHtml(doc, title) {
  const summary = clean(doc?.summary);
  const takeaways = (Array.isArray(doc?.keyTakeaways) ? doc.keyTakeaways : [])
    .map(clean)
    .filter(Boolean);

  const sections = [];
  if (summary) sections.push(summary);
  if (takeaways.length) {
    sections.push(['Key takeaways:', ...takeaways.map((t) => `- ${t}`)].join('\n'));
  }
  const text = truncate(sections.join('\n\n') || title, HOST_CONTENT_TEXT_MAX);

  return text
    .split('\n\n')
    .map((paragraph) => {
      const lines = paragraph.split('\n');
      const items = lines.slice(1);
      // A takeaways block: its heading as a paragraph, its dash lines as a list.
      if (items.length && items.every((line) => line.startsWith('- '))) {
        const list = items.map((line) => `<li>${escapeHtml(line.slice(2))}</li>`).join('');
        return `<p>${escapeHtml(lines[0])}</p><ul>${list}</ul>`;
      }
      return `<p>${lines.map(escapeHtml).join('<br>')}</p>`;
    })
    .join('');
}

/**
 * The Podbean-facing fields for one episode document. Pure.
 *
 * @param {object} doc the episode document
 * @param {object} [options]
 * @param {string} [options.publicUrl] the site page for this episode, if the caller has one
 * @returns {{ title: string, content: string, status: 'publish', type: 'public',
 *   apple_episode_type: 'full' }}
 */
export function describeForHost(doc, { publicUrl } = {}) {
  const title = truncate(clean(doc?.title), HOST_TITLE_MAX);
  if (!title) {
    throw new PodbeanError('The episode has no title to publish under.', {
      status: null,
      code: 'VALIDATION',
    });
  }

  let content = notesHtml(doc, title);

  const link = clean(publicUrl);
  if (link) {
    if (link.length > HOST_LINK_MAX || !/^https?:\/\//i.test(link)) {
      throw new PodbeanError(
        `The article link must be an http(s) URL of at most ${HOST_LINK_MAX} characters.`,
        { status: null, code: 'VALIDATION' }
      );
    }
    const safe = escapeHtml(link);
    content += `<p>Read the article: <a href="${safe}">${safe}</a></p>`;
  }

  return {
    title,
    content,
    status: 'publish',
    type: 'public',
    apple_episode_type: 'full',
  };
}

/** The last segment of the blob path, which is what Podbean shows as the file name. */
function filenameFor(audioPath) {
  return String(audioPath).split('/').filter(Boolean).pop() || 'episode.mp3';
}

/** Accept a bare Buffer or `{ bytes | body, contentType }` from `readAudio`. */
function normaliseAudio(result) {
  if (!result) return null;
  if (Buffer.isBuffer(result) || result instanceof Uint8Array) {
    return { bytes: result, contentType: DEFAULT_AUDIO_MIME };
  }
  const bytes = result.bytes || result.body || null;
  if (!bytes || !bytes.length) return null;
  return { bytes, contentType: result.contentType || DEFAULT_AUDIO_MIME };
}

/**
 * A failure as a document records it: `{ status, code, message, retryable }`,
 * never the Error itself. Exported so the hub's reads (host-reads.js,
 * host-stats.js) record a failed Podbean call in the one shape the hub
 * already renders.
 *
 * `message` is a sentence this code wrote (#945): a PodbeanError's own,
 * which names the status and the API's code but never its words, or a fixed
 * one with the error's code for anything else. The hub's reads serve it to
 * an editor in the same request, so nothing the API or a socket said goes in.
 *
 * @param {unknown} error - anything a Podbean step threw
 * @returns {{ status: number|null, code: string, message: string, retryable: boolean }}
 */
export function toRecordedError(error) {
  const podbean = error instanceof PodbeanError;
  return {
    status: podbean ? (error.status ?? null) : null,
    code: podbean ? error.code : 'UNEXPECTED',
    message: storedFailure(error, 'The Podbean step failed unexpectedly.'),
    retryable: podbean && Boolean(error.retryable),
  };
}

/**
 * Upload the document's audio and return the `file_key` to send as
 * `media_key`.
 *
 * Three steps, in order: read the bytes (ours), authorise the upload (token),
 * PUT the bytes (no token). A failure at any step is the caller's failure —
 * nothing here is partially recorded, because an upload Podbean has not been
 * told to attach to an episode is invisible to the show and costs nothing to
 * redo but a little of the month's storage allowance.
 */
async function uploadAudioFor({ client, readAudio, doc }) {
  const audio = normaliseAudio(await readAudio(doc.audioPath));
  if (!audio) {
    throw new PodbeanError(`No audio bytes were read for ${doc.audioPath}.`, {
      status: null,
      code: 'VALIDATION',
    });
  }
  const upload = await client.authorizeUpload({
    filename: filenameFor(doc.audioPath),
    filesize: audio.bytes.length,
    contentType: audio.contentType,
  });
  if (!upload?.presigned_url || !upload?.file_key) {
    throw new PodbeanError('Podbean authorised the upload without a presigned_url and a file_key.', {
      status: null,
      code: 'UPSTREAM',
      // The keys only: a presigned URL is a credential of its own.
      detail: `answered with ${Object.keys(upload || {}).join(', ') || 'nothing'}`,
    });
  }
  await client.uploadMedia(upload.presigned_url, audio.bytes, audio.contentType);
  return upload.file_key;
}

/**
 * How far before a document's first attempt a listed episode may have been
 * published and still count as that attempt's. Podbean stamps `publish_time`
 * when it creates the episode, which is after the attempt began; ten minutes
 * absorbs clock skew between Podbean and this host, and is far shorter than
 * the gap to any unrelated episode with the same title.
 */
export const RECONCILE_WINDOW_MS = 10 * 60_000;

/**
 * How long after its start one attempt can still be creating: the publish
 * job's timeout (podcast-jobs.js, 10 minutes). With the skew margin above,
 * an episode published later than `lastAttemptAt` + this + the margin was not
 * made by any recorded attempt, so a late retry never adopts it (CodeRabbit on
 * #1117: an unrelated episode published later under the same title).
 */
export const ATTEMPT_SPAN_MS = 10 * 60_000;

/** How many of the newest episodes reconciliation reads: one page. */
export const RECONCILE_LIMIT = 20;

/** Titles as compared: entities decoded, whitespace collapsed. */
function comparableTitle(value) {
  return String(value ?? '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e])
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The Podbean episode an earlier attempt on this document may have created
 * without its answer arriving, or null when the show has none (#1118; the
 * rule is in this file's header).
 *
 * Throws when the listing cannot be read or comes back in a shape that cannot
 * be checked: the caller records that and creates nothing, because "could not
 * tell" must not become "go ahead and create".
 *
 * @param {object} deps
 * @param {{ listEpisodes: Function }} deps.client
 * @param {string} deps.title the title this run would publish under
 * @param {string} deps.since ISO time of the document's first attempt
 * @param {string} deps.until ISO time of its last recorded attempt
 * @returns {Promise<object|null>} the newest matching Podbean episode
 */
export async function findUnrecordedEpisode({ client, title, since, until }) {
  // Checked before the listing: an unreadable time is local data, so no call
  // could help, and NaN bounds would match nothing and let a create through.
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) {
    throw new PodbeanError(
      'Could not tell whether an earlier attempt created the episode: the recorded attempt time is unreadable.',
      { status: null, code: 'VALIDATION', retryable: false }
    );
  }
  const listed = await client.listEpisodes({ limit: RECONCILE_LIMIT });
  if (!Array.isArray(listed?.episodes)) {
    throw new PodbeanError(
      'Could not tell whether an earlier attempt created the episode: Podbean listed no episodes array.',
      { status: null, code: 'UPSTREAM', retryable: true }
    );
  }
  const floor = sinceMs - RECONCILE_WINDOW_MS;
  const ceiling = untilMs + ATTEMPT_SPAN_MS + RECONCILE_WINDOW_MS;
  const wanted = comparableTitle(title);
  const matches = listed.episodes.filter(
    (episode) =>
      episode &&
      episode.id !== undefined &&
      episode.id !== null &&
      episode.id !== '' &&
      comparableTitle(episode.title) === wanted &&
      Number(episode.publish_time) * 1000 >= floor &&
      Number(episode.publish_time) * 1000 <= ceiling
  );
  matches.sort((a, b) => Number(b.publish_time) - Number(a.publish_time));
  return matches[0] ?? null;
}

/**
 * Publish or re-publish one episode document to Podbean.
 *
 * @param {object} deps
 * @param {ReturnType<import('./podbean.js').createPodbeanClient>} deps.client
 * @param {(audioPath: string) => Promise<Buffer|{bytes?: Buffer, body?: Buffer, contentType?: string}>} deps.readAudio
 * @param {object} deps.doc the episode document as stored
 * @param {() => Date} [deps.now]
 * @param {string} [deps.publicUrl] the site page for the episode, linked at the end of the notes
 * @returns {Promise<{ host: { podbean: object } }>} the patch to merge onto the document
 */
export async function publishEpisodeToHost({ client, readAudio, doc, now = () => new Date(), publicUrl }) {
  const previous = doc?.host?.podbean && typeof doc.host.podbean === 'object' ? doc.host.podbean : {};
  const attemptAt = now().toISOString();
  // A record written before firstAttemptAt existed counts its last attempt as
  // its first: the earliest time this file can vouch for.
  const firstAttemptAt = previous.firstAttemptAt ?? previous.lastAttemptAt ?? attemptAt;

  const failure = (error) => ({
    host: {
      podbean: { ...previous, firstAttemptAt, lastAttemptAt: attemptAt, error: toRecordedError(error) },
    },
  });

  try {
    if (!client) {
      throw new PodbeanError('Podbean publishing has no client; nothing was sent.', {
        status: null,
        code: 'NOT_CONFIGURED',
      });
    }
    if (client.configured && client.configured.ok === false) {
      throw new PodbeanError(client.configured.reason, { status: null, code: 'NOT_CONFIGURED' });
    }
    if (!doc?.audioPath) {
      throw new PodbeanError('The episode has no audio, so there is nothing to publish.', {
        status: null,
        code: 'VALIDATION',
      });
    }

    const metadata = describeForHost(doc, { publicUrl });

    if (previous.episodeId) {
      const audioChanged = doc.audioPath !== previous.audioPath;
      const fields = { ...metadata };
      let fileKey = previous.fileKey ?? null;
      if (audioChanged) {
        fileKey = await uploadAudioFor({ client, readAudio, doc });
        fields.media_key = fileKey;
      }

      const response = await client.updateEpisode(previous.episodeId, fields);
      const episode = response?.episode ?? {};
      return {
        host: {
          podbean: {
            ...previous,
            episodeId: previous.episodeId,
            permalinkUrl: episode.permalink_url ?? previous.permalinkUrl ?? null,
            mediaUrl: episode.media_url ?? previous.mediaUrl ?? null,
            hostStatus: episode.status ?? previous.hostStatus ?? null,
            audioPath: doc.audioPath,
            fileKey,
            publishedAt: previous.publishedAt ?? attemptAt,
            firstAttemptAt,
            lastAttemptAt: attemptAt,
            error: null,
          },
        },
      };
    }

    // No id, but an earlier attempt: it may have created the episode and lost
    // the answer. Look before creating (#1118); a failed look throws to the
    // recorded failure below, and nothing is created.
    if (previous.lastAttemptAt) {
      const adopted = await findUnrecordedEpisode({
        client,
        title: metadata.title,
        since: firstAttemptAt,
        until: previous.lastAttemptAt,
      });
      if (adopted) {
        // Which audio the lost create carried is unknown, so it is sent again.
        const adoptedKey = await uploadAudioFor({ client, readAudio, doc });
        const response = await client.updateEpisode(adopted.id, { ...metadata, media_key: adoptedKey });
        const episode = response?.episode ?? {};
        const created = Number(adopted.publish_time);
        return {
          host: {
            podbean: {
              ...previous,
              episodeId: adopted.id,
              permalinkUrl: episode.permalink_url ?? adopted.permalink_url ?? null,
              mediaUrl: episode.media_url ?? adopted.media_url ?? null,
              hostStatus: episode.status ?? adopted.status ?? null,
              audioPath: doc.audioPath,
              fileKey: adoptedKey,
              publishedAt: Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString() : attemptAt,
              firstAttemptAt,
              lastAttemptAt: attemptAt,
              adoptedAt: attemptAt,
              error: null,
            },
          },
        };
      }
    }

    const fileKey = await uploadAudioFor({ client, readAudio, doc });
    const response = await client.createEpisode({ ...metadata, media_key: fileKey });
    const episode = response?.episode;
    if (!episode || episode.id === undefined || episode.id === null || episode.id === '') {
      throw new PodbeanError('Podbean created the episode but answered without an id.', {
        status: null,
        code: 'UPSTREAM',
        detail: `answered with ${Object.keys(response || {}).join(', ') || 'nothing'}`,
      });
    }
    return {
      host: {
        podbean: {
          ...previous,
          episodeId: episode.id,
          permalinkUrl: episode.permalink_url ?? null,
          mediaUrl: episode.media_url ?? null,
          hostStatus: episode.status ?? null,
          audioPath: doc.audioPath,
          fileKey,
          publishedAt: attemptAt,
          firstAttemptAt,
          lastAttemptAt: attemptAt,
          error: null,
        },
      },
    };
  } catch (error) {
    return failure(error);
  }
}

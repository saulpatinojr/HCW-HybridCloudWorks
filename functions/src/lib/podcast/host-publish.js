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
 *       lastAttemptAt,  // every run, success or not
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
 * The weak spot is a create that succeeded upstream but whose response was
 * lost before the id was recorded. That gap is left visible rather than
 * hidden: the next run would create a duplicate. Closing it needs the host to
 * accept a client-chosen key, which Podbean's API does not offer, or a
 * pre-flight search of the show's episodes by title, which is heuristic.
 * Recorded here so it is decided on purpose.
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

function toRecordedError(error) {
  if (error instanceof PodbeanError) {
    return {
      status: error.status ?? null,
      code: error.code,
      message: error.message,
      retryable: Boolean(error.retryable),
    };
  }
  return {
    status: null,
    code: 'UNEXPECTED',
    message: error?.message ? String(error.message) : String(error),
    retryable: false,
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

  const failure = (error) => ({
    host: { podbean: { ...previous, lastAttemptAt: attemptAt, error: toRecordedError(error) } },
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
            lastAttemptAt: attemptAt,
            error: null,
          },
        },
      };
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
          lastAttemptAt: attemptAt,
          error: null,
        },
      },
    };
  } catch (error) {
    return failure(error);
  }
}

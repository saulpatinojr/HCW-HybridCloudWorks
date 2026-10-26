import { getPrimaryContentBody } from '../cms/content-quality.js';
import { isSoftDeleted } from '../public-reads.js';
import { SEARCH, sourceKey, tokens, text } from './model.js';

// Explicit editorial allowlist. Never index arbitrary Cosmos containers or
// follow external URLs. Only fields below may reach retrieval or the plugin.
export const SOURCES = [
  ['content', '/admin/editor/'],
  ['frameworks', '/admin/live-pages'],
  ['designs', '/admin/live-pages'],
  ['newsletters', '/admin/mailing-list'],
  ['social_posts', '/admin/social-hub'],
  ['recordings', '/admin/recording-hub'],
  ['podcast_transcripts', '/admin/recording-hub'],
];
const sourceMap = new Map(SOURCES);
const firstText = (...values) =>
  values.find((v) => typeof v === 'string' && v.trim()) || '';
const tagsOf = (doc) =>
  Array.isArray(doc.tags || doc.Tags || doc.keyTopics)
    ? (doc.tags || doc.Tags || doc.keyTopics)
        .filter((v) => typeof v === 'string')
        .slice(0, 30)
    : [];
const dialogueText = (value) =>
  Array.isArray(value)
    ? value
        .slice(0, 5000)
        .map((turn) =>
          typeof turn?.text === 'string'
            ? `${text(turn.speaker, 100)}: ${turn.text}`
            : '',
        )
        .filter(Boolean)
        .join('\n\n')
    : '';
const newsletterText = (doc) =>
  [
    doc.intro,
    doc.customNote,
    ...(Array.isArray(doc.sections)
      ? doc.sections
          .slice(0, 30)
          .flatMap((section) => [
            text(section.title || section.label, 300),
            ...(Array.isArray(section.items)
              ? section.items
                  .slice(0, 100)
                  .map((item) =>
                    [
                      text(item.title, 300),
                      text(item.summary || item.description, 3000),
                    ]
                      .filter(Boolean)
                      .join('\n'),
                  )
              : []),
          ])
      : []),
  ]
    .filter((v) => typeof v === 'string')
    .join('\n\n');

export function referenceOf(container, doc) {
  if (
    !sourceMap.has(container) ||
    !doc ||
    isSoftDeleted(doc) ||
    doc.archived === true ||
    doc.deleted === true ||
    doc.deletedAt
  )
    return null;
  if (container === 'content' && (doc.type === 'news' || doc.source === 'rss'))
    return null;
  const body = firstText(
    getPrimaryContentBody(doc),
    doc.body,
    doc.markdown,
    doc.contentMarkdown,
    doc.transcript,
    doc.transcriptText,
    doc.script,
    doc.caption,
    doc.text,
    dialogueText(doc.transcript || doc.dialogue),
    container === 'newsletters' ? newsletterText(doc) : '',
    doc.description,
  );
  const title = text(
    firstText(
      doc.Title,
      doc.title,
      doc.name,
      doc.subject,
      container === 'social_posts'
        ? firstText(doc.caption, doc.text).slice(0, 120)
        : '',
    ),
    300,
  );
  if (!title) return null;
  const href =
    container === 'content'
      ? `/admin/editor/${encodeURIComponent(doc.id)}`
      : sourceMap.get(container);
  const recordingId =
    container === 'recordings'
      ? doc.id
      : container === 'podcast_transcripts'
        ? text(
            doc.recordingId || doc.sourceRecordingId || doc.storedRecordingId,
            128,
          )
        : null;
  return {
    id: sourceKey(container, doc.id),
    type: 'reference',
    source: { container, id: doc.id, ...(recordingId && { recordingId }) },
    title,
    body: body.slice(0, 128 * 1024),
    truncated: body.length > 128 * 1024,
    tags: tagsOf(doc),
    links: [],
    collections: [],
    summary: text(firstText(doc.Summary, doc.summary, doc.description), 800),
    status: text(firstText(doc.contentStatus, doc.status, doc.Status), 60),
    href,
    updatedAt: doc.updatedAt || doc['Created At'] || null,
  };
}

export function indexDocument(item) {
  return {
    ...item,
    type: 'search-item',
    itemType: item.type,
    searchable:
      `${item.title}\n${item.body}\n${item.tags.join(' ')}\n${item.summary || ''}`.toLowerCase(),
    tokens: tokens(`${item.title} ${item.body} ${item.tags.join(' ')}`),
    indexedAt: new Date().toISOString(),
  };
}

export function createSourceService(repo) {
  async function current(index) {
    if (index.source) {
      if (!sourceMap.has(index.source.container)) return null;
      const doc = await repo.store.readDoc(
        index.source.container,
        index.source.id,
      );
      return referenceOf(index.source.container, doc);
    }
    const item = await repo.read(index.id);
    return item &&
      ['note', 'topic', 'project', 'conflict'].includes(item.type) &&
      !item.archived
      ? item
      : null;
  }
  async function search({ q = '', cursor = null, limit = 30, kind = '' } = {}) {
    const terms = tokens(q).slice(0, 12);
    const params = [];
    const clauses = ['c.ownerId = @owner', 'c.type = "search-item"'];
    if (kind) {
      clauses.push('c.itemType = @kind');
      params.push({ name: '@kind', value: kind });
    }
    if (terms.length) {
      clauses.push(
        `(${terms.map((_, i) => `CONTAINS(c.searchable, @t${i})`).join(' OR ')})`,
      );
      terms.forEach((term, i) => params.push({ name: `@t${i}`, value: term }));
    }
    const page = await repo.searchPage(
      `SELECT * FROM c WHERE ${clauses.join(' AND ')} ORDER BY c.id`,
      params,
      { maxItemCount: limit, continuationToken: cursor },
    );
    const items = (await Promise.all(page.resources.map(current)))
      .filter(Boolean)
      .filter(
        (item) =>
          !terms.length ||
          terms.some((term) =>
            `${item.title} ${item.body} ${item.tags.join(' ')} ${item.summary || ''}`
              .toLowerCase()
              .includes(term),
          ),
      );
    items.sort((a, b) => {
      const score = (item) =>
        terms.reduce(
          (n, term) =>
            n +
            (item.title.toLowerCase().includes(term) ? 5 : 0) +
            (item.body.toLowerCase().includes(term) ? 1 : 0),
          0,
        );
      return score(b) - score(a);
    });
    return {
      items,
      cursor: page.continuationToken,
      hasMore: page.hasMoreResults,
    };
  }
  async function indexItem(item) {
    if (item.archived) {
      // Keep a small tombstone in the index. Retrieval rechecks the source,
      // so stale index entries can never resurrect archived or removed text.
      await repo.putIndex({
        id: item.id,
        type: 'removed',
        indexedAt: new Date().toISOString(),
      });
    } else await repo.putIndex(indexDocument(item));
  }
  async function get(id) {
    const note = await repo.read(id);
    if (note && ['note', 'topic', 'project', 'conflict'].includes(note.type))
      return note;
    const indexed = await repo.readIndex(id);
    return indexed?.type === 'search-item' ? current(indexed) : null;
  }
  async function contextItems(id) {
    const items = new Map();
    const queue = [id];
    const seen = new Set();
    // A small breadth-first walk gives "this series" real selected context
    // without trusting the model to invent graph edges or query the database.
    while (queue.length && items.size < 8 && seen.size < 16) {
      const next = queue.shift();
      if (seen.has(next)) continue;
      seen.add(next);
      const item = await get(next);
      if (!item || item.archived) continue;
      items.set(item.id, item);
      queue.push(
        ...(item.links || []).slice(0, 8),
        ...(item.collections || []).slice(0, 8),
      );
      const backlinks = await repo.backlinks(next);
      queue.push(...backlinks.slice(0, 8).map((r) => r.id));
    }
    return [...items.values()];
  }
  return { search, current, indexItem, get, contextItems, container: SEARCH };
}

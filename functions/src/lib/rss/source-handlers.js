import { randomUUID } from 'node:crypto';
import { json } from '../http/admin-handler.js';
import { validateFetchUrl } from '../http/guarded-fetch.js';
import {
  SOURCE_KIND,
  DEFAULT_BLOG_SOURCES,
  loadBlogSources,
  validateSource,
} from './source-config.js';
import { AUDIT_TTL_SECONDS } from '../audit.js';

export function createBlogSourceHandlers({
  guard,
  store,
  validateUrl = validateFetchUrl,
  uuid = randomUUID,
  now = () => new Date(),
}) {
  return {
    async list(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      try {
        const [sources, runs] = await Promise.all([
          loadBlogSources(store),
          store.queryDocs('admin_settings', 'SELECT * FROM c WHERE c.settingKind = @kind', [
            { name: '@kind', value: 'blog_source_run' },
          ]),
        ]);
        return json(200, {
          sources: sources.map((source) => ({
            ...source,
            lastRun: runs.find((run) => run.sourceId === source.id) || null,
          })),
        });
      } catch (error) {
        context.error?.('Blog sources could not be loaded', error);
        return json(500, { error: 'Blog sources could not be loaded.' });
      }
    },
    async save(request, context) {
      const auth = await guard.requireRole(request, 'editor');
      if (auth.error) return auth.error;
      let body, clean;
      try {
        body = await request.json();
        if (JSON.stringify(body).length > 12000) throw new Error('Source settings are too large.');
        clean = validateSource(body);
        await validateUrl(clean.url);
        if (clean.fallbackImageUrl.startsWith('https:')) await validateUrl(clean.fallbackImageUrl);
      } catch (error) {
        return json(400, {
          error: error.refused
            ? 'Use a reachable public URL.'
            : 'Invalid source settings. Check the name, URLs, provider, intake type, and article limit.',
        });
      }
      try {
        const id = request.params?.id || `blog-source-custom-${uuid()}`;
        if (!/^blog-source-[\w-]{1,90}$/.test(id))
          return json(400, { error: 'Invalid source identifier.' });
        const seed = DEFAULT_BLOG_SOURCES.find((source) => source.id === id);
        const existing = await store.readDoc('admin_settings', id, id);
        if (request.params?.id && !seed && !existing)
          return json(404, { error: 'Source not found.' });
        if (existing && body._etag !== existing._etag)
          return json(409, { error: 'This source changed. Refresh before saving.' });
        if (seed && (clean.provider !== seed.provider || clean.kind !== seed.kind))
          return json(400, { error: 'Official source provider and intake type are fixed.' });
        const doc = { id, settingKind: SOURCE_KIND, ...clean, updatedAt: now().toISOString() };
        const saved = existing
          ? await store.replaceDocIfMatch('admin_settings', { ...doc, _etag: existing._etag })
          : await store.createDoc('admin_settings', doc);
        try {
          await store.upsertDoc('admin_audit_logs', {
            id: uuid(),
            action: 'blog_source_updated',
            userId: auth.user?.oid || auth.user?.sub || null,
            timestamp: now().toISOString(),
            ttl: AUDIT_TTL_SECONDS,
            details: { sourceId: id, created: !existing },
            compliance: { schemaVersion: 2, appendOnly: true },
          });
        } catch (error) {
          context.warn?.('Blog source saved; audit record failed', error);
        }
        return json(200, {
          source: {
            ...saved,
            official: Boolean(seed && new URL(clean.url).hostname === new URL(seed.url).hostname),
          },
        });
      } catch (error) {
        if ([409, 412].includes(Number(error.code || error.statusCode)))
          return json(409, { error: 'This source changed. Refresh before saving.' });
        context.error?.('Blog source could not be saved', error);
        return json(500, { error: 'Blog source could not be saved.' });
      }
    },
  };
}

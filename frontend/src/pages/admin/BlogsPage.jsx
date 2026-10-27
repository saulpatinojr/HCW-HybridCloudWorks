import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Newspaper } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import TypedReviewList from '@/components/admin/TypedReviewList';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import PageHeader from '@/components/admin/shared/PageHeader';
import { ImageGalleryPicker } from '@/components/admin/ImageGalleryPicker';
import { Input } from '@/components/ui/input';
import { getJSON, sendJSON } from '@/lib/api';
import { resolveMediaUrl } from '@/lib/functionsBase';
import { runJob } from '@/lib/jobs';
import { useAuthReady } from '@/hooks/useAuthReady';
import { PROVIDER_LABELS, ADMIN_ROUTES } from '@/config/admin';

const HELP = [
  'RSS intake runs every two hours and blog-page discovery every six hours when their scheduler flags are enabled. Run now works independently of the timer switches.',
  'Intake deduplicates URLs and titles, then sends new drafts through inspection. ContentForge turns selected source material into your own writing; review and publish gates still apply.',
  'Source defaults apply to newly ingested articles after inspection checks for article images. Existing and generated covers are preserved. Use the article editor to change an existing article’s image.',
];
const BLANK = {
  name: '',
  provider: 'aws',
  kind: 'rss',
  url: '',
  enabled: true,
  maxItems: 10,
  fallbackImageUrl: '',
};

function BlogCard({ item }) {
  return (
    <Card className="p-4 space-y-3 min-w-0">
      <div className="flex flex-wrap gap-2 text-sm">
        <StatusBadge content={item} />
        <span>{item['Cloud Provider'] || item.cloudProvider}</span>
      </div>
      <h2 className="font-semibold break-words">
        {item.Title || item.title || 'Untitled article'}
      </h2>
      <p className="text-sm text-muted-foreground line-clamp-3">
        {item.Summary || item.summary || 'Open the review to inspect this article.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link
            to={`${ADMIN_ROUTES.REVIEW.replace(':id', encodeURIComponent(item.id))}?source=content`}
          >
            Review article
          </Link>
        </Button>
        <Button asChild size="sm">
          <Link to={ADMIN_ROUTES.EDITOR.replace(':id', encodeURIComponent(item.id))}>
            Edit article
          </Link>
        </Button>
      </div>
    </Card>
  );
}

function SourceEditor({ source, onSaved, onCancel }) {
  const [form, setForm] = useState(source || BLANK);
  const [gallery, setGallery] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const field = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await sendJSON(
        source ? `cms/blog-sources/${encodeURIComponent(source.id)}` : 'cms/blog-sources',
        source ? 'PUT' : 'POST',
        form
      );
      onSaved();
    } catch (err) {
      setError(err.message || 'Source could not be saved.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <Card className="p-4 sm:p-6 min-w-0 space-y-5">
      <h2 className="font-semibold text-lg">
        {source ? `Edit ${source.name}` : 'Add blog source'}
      </h2>
      <form onSubmit={save} className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="space-y-2 text-sm">
            Source name
            <Input
              required
              maxLength={120}
              value={form.name}
              onChange={(event) => field('name', event.target.value)}
            />
          </label>
          <label className="space-y-2 text-sm">
            Provider
            <select
              className="w-full rounded-md border bg-background p-2"
              value={form.provider}
              disabled={source?.builtIn}
              onChange={(event) => field('provider', event.target.value)}
            >
              {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-2 text-sm">
            Intake type
            <select
              className="w-full rounded-md border bg-background p-2"
              value={form.kind}
              disabled={source?.builtIn}
              onChange={(event) => field('kind', event.target.value)}
            >
              <option value="rss">RSS feed</option>
              <option value="listing">Blog listing page</option>
            </select>
          </label>
          <label className="space-y-2 text-sm">
            New articles per run
            <Input
              type="number"
              required
              min={1}
              max={20}
              value={form.maxItems}
              onChange={(event) => field('maxItems', Number(event.target.value))}
            />
          </label>
        </div>
        <label className="block space-y-2 text-sm">
          {form.kind === 'rss' ? 'RSS feed URL' : 'Blog listing URL'}
          <Input
            type="url"
            required
            value={form.url}
            onChange={(event) => field('url', event.target.value)}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Use a public HTTPS address. Custom sources and official sources moved to another host are
          treated as untrusted during review.
        </p>
        <label className="block space-y-2 text-sm">
          Fallback image URL
          <Input
            aria-label="Fallback image URL"
            value={form.fallbackImageUrl}
            onChange={(event) => field('fallbackImageUrl', event.target.value)}
            placeholder="Choose from the gallery or paste an HTTPS image URL"
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setGallery((value) => !value)}>
            {gallery ? 'Hide image gallery' : 'Choose default image'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={!form.fallbackImageUrl}
            onClick={() => field('fallbackImageUrl', '')}
          >
            Clear default
          </Button>
        </div>
        {form.fallbackImageUrl && (
          <img
            src={resolveMediaUrl(form.fallbackImageUrl)}
            alt="Source fallback preview"
            className="h-32 w-full max-w-sm rounded-md object-cover"
          />
        )}
        {gallery && (
          <ImageGalleryPicker
            title="Choose a fallback image"
            onSelect={(image) => {
              field('fallbackImageUrl', image.imageUrl);
              setGallery(false);
            }}
          />
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => field('enabled', event.target.checked)}
          />
          Enabled for intake
        </label>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save source'}
          </Button>
          <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Sources() {
  const { authReady } = useAuthReady();
  const [sources, setSources] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const [edit, setEdit] = useState(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('all');
  const [running, setRunning] = useState(null);
  useEffect(() => {
    if (!authReady) return;
    let stale = false;
    getJSON('cms/blog-sources')
      .then((data) => {
        if (!stale) {
          setSources(data.sources || []);
          setError('');
        }
      })
      .catch((err) => {
        if (!stale) setError(err.message || 'Sources could not be loaded.');
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [authReady, revision]);
  async function sync(source) {
    setRunning(source.id);
    setMessage('');
    setError('');
    try {
      const job = await runJob('sync-blog-source', { sourceId: source.id });
      if (job.status !== 'succeeded') throw new Error(job.error || 'Intake did not finish.');
      const result = job.result || {};
      const failures = Array.isArray(result.errors) ? result.errors.length : result.errors || 0;
      setMessage(
        result.skipped
          ? 'Blog-page discovery is unavailable. Check the Firecrawl integration.'
          : `${source.name}: ${result.newContent ?? result.newArticles ?? 0} new articles; ${failures} source errors. Open the article list to review new drafts.`
      );
      setRevision((value) => value + 1);
    } catch (err) {
      setError(err.message || 'Intake could not run.');
    } finally {
      setRunning(null);
    }
  }
  if (edit || adding)
    return (
      <SourceEditor
        key={edit?.id || 'new'}
        source={edit}
        onCancel={() => {
          setEdit(null);
          setAdding(false);
        }}
        onSaved={() => {
          setEdit(null);
          setAdding(false);
          setMessage('Source saved. Changes apply on the next intake run.');
          setRevision((value) => value + 1);
        }}
      />
    );
  const filtered = sources.filter(
    (source) =>
      (provider === 'all' || source.provider === provider) &&
      `${source.name} ${source.url}`.toLowerCase().includes(query.toLowerCase())
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <label className="flex-1 min-w-0 space-y-2 text-sm">
          Search sources
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search sources"
            placeholder="Source name or URL"
          />
        </label>
        <label className="space-y-2 text-sm">
          Provider
          <select
            className="block rounded-md border p-2 bg-background"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
          >
            <option value="all">All providers</option>
            {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button onClick={() => setAdding(true)}>Add source</Button>
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh sources
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {sources.length} sources · {sources.filter((source) => source.enabled).length} enabled.
        Pause a source by editing it and clearing Enabled for intake. Previously imported articles
        stay in review.
      </p>
      {error && (
        <p role="alert" className="text-destructive break-words">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm break-words">
          {message}
        </p>
      )}
      {loading && <p role="status">Loading sources…</p>}
      {!loading && !error && !filtered.length && <p>No sources match these filters.</p>}
      <div className="grid gap-4 xl:grid-cols-2">
        {filtered.map((source) => (
          <Card key={source.id} className="p-4 sm:p-5 space-y-3 min-w-0">
            <div className="flex flex-wrap justify-between gap-2">
              <h2 className="font-semibold break-words min-w-0">{source.name}</h2>
              <span className="text-xs text-muted-foreground">
                {source.enabled ? 'Enabled' : 'Paused'} ·{' '}
                {source.official ? 'Official' : 'Custom / untrusted'}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {PROVIDER_LABELS[source.provider]} · {source.kind === 'rss' ? 'RSS' : 'Blog listing'}{' '}
              · Up to {source.maxItems} articles per run
            </p>
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-sm text-primary break-all underline"
            >
              {source.url}
            </a>
            <p className="text-xs text-muted-foreground">
              {source.lastRun
                ? `Last run: ${source.lastRun.status} · ${new Date(source.lastRun.fetchedAt).toLocaleString()}`
                : 'No recorded intake run yet.'}
            </p>
            <p className="text-xs text-muted-foreground">
              {source.fallbackImageUrl ? 'Fallback image selected' : 'No source fallback image'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => setEdit(source)}>
                Edit source
              </Button>
              <Button
                size="sm"
                disabled={!source.enabled || Boolean(running)}
                onClick={() => sync(source)}
              >
                {running === source.id ? 'Running intake…' : 'Run now'}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function BlogsPage() {
  const [tab, setTab] = useState('articles');
  return (
    <div className="space-y-6 max-w-6xl min-w-0">
      <PageHeader icon={Newspaper} help={HELP} />
      <div role="group" aria-label="Blogs view" className="flex flex-wrap gap-2">
        <Button
          variant={tab === 'articles' ? 'default' : 'outline'}
          aria-pressed={tab === 'articles'}
          onClick={() => setTab('articles')}
        >
          Articles
        </Button>
        <Button
          variant={tab === 'sources' ? 'default' : 'outline'}
          aria-pressed={tab === 'sources'}
          onClick={() => setTab('sources')}
        >
          Blog sources
        </Button>
        <Button
          variant={tab === 'workflow' ? 'default' : 'outline'}
          aria-pressed={tab === 'workflow'}
          onClick={() => setTab('workflow')}
        >
          Publishing workflow
        </Button>
      </div>
      {tab === 'articles' && (
        <TypedReviewList
          type="blog"
          icon={Newspaper}
          help={HELP}
          nouns={{ singular: 'article', plural: 'articles' }}
          showHeader={false}
          enableSearch
          renderCard={(props) => <BlogCard key={props.item.id} {...props} />}
        />
      )}
      {tab === 'sources' && <Sources />}
      {tab === 'workflow' && (
        <Card className="p-4 sm:p-6 space-y-4">
          <h2 className="font-semibold">From source to published article</h2>
          <ol className="list-decimal pl-5 space-y-3">
            <li>
              Discover articles from enabled RSS feeds and blog listings. Intake skips duplicates
              and creates drafts.
            </li>
            <li>
              Inspect the original page to extract content, classify it, and find images. A source
              fallback is used when the article has no image.
            </li>
            <li>
              Review source material and use ContentForge to develop your own article. Open the
              editor to adjust writing, attribution, tags, and images.
            </li>
            <li>
              Preview and approve. Publishing checks content quality, images, metadata, and the
              destination URL before anything goes live.
            </li>
          </ol>
          <p className="text-sm text-muted-foreground">
            Pausing intake does not delete imported articles. Changing a source default affects
            future intake; existing articles can be edited individually.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/admin/forge-studio">Open Forge Studio</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/admin/publish">Open Publish</Link>
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

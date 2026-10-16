/**
 * Published — the history, as a calendar (#575).
 *
 * Two sections, because "published" means two different things here: the pages
 * live on hybridcloudworks.com, and the social posts Publer has already sent.
 * The posts are grouped by the day they went out so the tab reads as a record
 * of when things happened rather than a flat list, and each post shows the
 * per-account outcomes Publer reported — only the ones it actually sent.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AlertCircle, Clock, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { listSocialPosts, publerCallFailed, publerListPosts, readPublerPosts } from './publerApi';
import {
  firstText,
  fmtDate,
  getLiveTitle,
  getLiveUrl,
  groupByDay,
  postResults,
  postWhen,
} from './socialView';
import { PlatformBadge } from './shared';
import useRecentContent from './useRecentContent';

/** One account's outcome, when Publer said anything about it. */
function AccountResult({ result }) {
  const failed = /fail|error|reject/i.test(result.state) || Boolean(result.error);
  return (
    <Badge
      variant="outline"
      className={`text-xs ${failed ? 'border-destructive/40 text-destructive' : ''}`}
      title={result.error || undefined}
    >
      {result.name}
      {result.state ? ` · ${result.state}` : ''}
    </Badge>
  );
}

function PublishedPost({ post, fromHub, index }) {
  const text = firstText([post.caption, post.text, post.description], '—');
  const provider = firstText([post.network, post.provider]);
  const permalink = firstText([post.permalink, post.public_url, post.url]);
  const results = postResults(post);
  const failures = results.filter((result) => result.error);
  return (
    <Card key={post.id ?? `published-${index}`} className="p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium line-clamp-2">{text}</p>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            {provider && <PlatformBadge provider={provider} />}
            {results.map((result, i) => (
              <AccountResult key={result.id || `${result.name}-${i}`} result={result} />
            ))}
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {fmtDate(postWhen(post))}
            </span>
            {fromHub && (
              <Badge variant="outline" className="text-xs border-pink-300 text-pink-600">
                via Social Hub
              </Badge>
            )}
          </div>
          {failures.map((result, i) => (
            <p
              key={result.id || `failure-${i}`}
              className="mt-1 text-xs text-destructive flex items-start gap-1"
            >
              <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
              {result.name}: {result.error}
            </p>
          ))}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {permalink && (
            <Button variant="ghost" size="icon" className="h-7 w-7" asChild>
              <a href={permalink} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

function LivePageCard({ item }) {
  const url = getLiveUrl(item);
  const provider = item['Cloud Provider'] || item.cloudProvider || '';
  return (
    <Card className="p-3">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{getLiveTitle(item)}</p>
          <div className="flex flex-wrap items-center gap-2 mt-1">
            {provider && (
              <Badge variant="outline" className="text-xs">
                {provider}
              </Badge>
            )}
            <Badge variant="outline" className="text-xs capitalize">
              {item.__source}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {fmtDate(item.publishedAt || item.updatedAt || item.createdAt)}
            </span>
          </div>
        </div>
        {url && (
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" asChild>
            <a href={url} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        )}
      </div>
    </Card>
  );
}

export default function PublishedTab({ ready = true }) {
  const {
    items: recentContent,
    loading: loadingContent,
    error: contentError,
  } = useRecentContent(ready);
  const [publerPosts, setPublerPosts] = useState([]);
  const [hubPosts, setHubPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [publerRes, snap] = await Promise.all([
        publerListPosts('published').catch(publerCallFailed),
        listSocialPosts(['published']).catch(() => []),
      ]);
      const { posts, notice } = readPublerPosts(publerRes);
      // A failed read shows the notice with an empty list, never the previous
      // read's posts under an error saying they could not be read (#555).
      setPublerPosts(notice ? [] : posts);
      setError(notice);
      setHubPosts(Array.isArray(snap) ? snap : []);
    } catch (err) {
      setPublerPosts([]);
      setError(err?.message || 'Could not read the published posts.');
    } finally {
      // In a `finally`, so a throw anywhere above still clears the spinner
      // rather than leaving the section loading for the rest of the session.
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      load();
    });
  }, [load]);

  const refresh = () => {
    setLoading(true);
    load();
  };

  // Track which Publer posts originated from this hub via publerJobId
  const hubJobIds = new Set(hubPosts.map((p) => p.publerJobId).filter(Boolean));
  const days = groupByDay(publerPosts);

  return (
    <div className="space-y-8">
      {/* Section 1 — Live Pages on hybridcloudworks.com */}
      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-2">
            Live Pages on hybridcloudworks.com
            {recentContent.length > 0 && (
              <Badge variant="secondary" className="text-xs">
                {recentContent.length}
              </Badge>
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            Blogs &amp; articles already published from the Content Library.
          </p>
        </div>

        {loadingContent && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        {!loadingContent && contentError && (
          <p className="text-sm text-destructive py-4 text-center" role="status">
            {contentError}
          </p>
        )}
        {!loadingContent && !contentError && recentContent.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">No live pages found.</p>
        )}
        {recentContent.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {recentContent.map((item) => (
              <LivePageCard key={`${item.__source}-${item.id}`} item={item} />
            ))}
          </div>
        )}
      </div>

      {/* Section 2 — Published in Publer, by day */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold flex items-center gap-2">
              Published in Publer
              {publerPosts.length > 0 && (
                <Badge variant="secondary" className="text-xs">
                  {publerPosts.length}
                </Badge>
              )}
            </h3>
            <p className="text-xs text-muted-foreground">
              Social posts already live on LinkedIn, X, Facebook, Instagram &amp; YouTube via
              Publer, newest day first.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={refresh} className="gap-1.5 h-7">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loading && error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-xs">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {!loading && !error && publerPosts.length === 0 && (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No published posts in Publer yet.
          </p>
        )}

        {days.map((day) => (
          <section key={day.key || 'undated'} className="space-y-2" aria-label={day.label}>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {day.label}
              <Badge variant="secondary" className="ml-2 text-xs">
                {day.posts.length}
              </Badge>
            </h4>
            {day.posts.map((post, index) => (
              <PublishedPost
                key={post.id ?? `${day.key}-${index}`}
                post={post}
                index={index}
                fromHub={post.job_id ? hubJobIds.has(post.job_id) : false}
              />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

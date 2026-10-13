/**
 * Distribution — what this hub has sent to Podbean, and how it went (#576).
 *
 * The host record used to be one line tucked under each transcript, so
 * "did anything fail to publish" meant scrolling the whole list and reading
 * every row. Here the same records are grouped by state, failures first, with
 * the retry beside them.
 *
 * It renders no state of its own: the transcripts come from the hub read that
 * Transcripts also uses, because approving a transcript there is exactly what
 * creates a record here. Two reads could disagree about one transcript, and a
 * publish that a stale list says never happened is the worst thing this tab
 * could say.
 */
import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { hostState } from './recordingView';
import { HostLine, ReadState } from './shared';

/**
 * The groups, worst first: a failure needs a decision, a pending publish needs
 * only patience, and `none` is every transcript nobody has approved yet — the
 * largest group and the least interesting, so it is last and collapsed.
 */
const GROUPS = Object.freeze([
  { state: 'error', title: 'Failed to publish', tone: 'text-red-700 dark:text-red-300' },
  { state: 'skipped', title: 'Skipped', tone: 'text-slate-600 dark:text-slate-300' },
  { state: 'pending', title: 'Publishing now', tone: 'text-slate-600 dark:text-slate-300' },
  {
    state: 'published',
    title: 'Published to Podbean',
    tone: 'text-emerald-700 dark:text-emerald-300',
  },
  { state: 'none', title: 'Not sent', tone: 'text-slate-500' },
]);

function TranscriptHostCard({ item, onRetry, retrying }) {
  return (
    <Card>
      <CardContent className="p-3 space-y-1">
        <p className="text-sm font-medium">{item.title || item.id}</p>
        <HostLine item={item} onRetry={onRetry} retrying={retrying} />
      </CardContent>
    </Card>
  );
}

function Group({ group, items, onRetry, busyKey }) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-2" aria-label={group.title}>
      <h3 className={`font-semibold text-sm flex items-center gap-2 ${group.tone}`}>
        {group.title}
        <Badge variant="secondary" className="text-[10px]">
          {items.length}
        </Badge>
      </h3>
      {group.state === 'none' ? (
        <p className="text-xs text-slate-500">
          {items.length} transcript{items.length === 1 ? '' : 's'} nothing has been asked to publish
          yet. Approve one on the Transcripts tab to send it.
        </p>
      ) : (
        items.map((item) => (
          <TranscriptHostCard
            key={item.id}
            item={item}
            onRetry={onRetry}
            retrying={busyKey === `retry:${item.id}`}
          />
        ))
      )}
    </section>
  );
}

/** The feed link and the reload, beside the heading. */
function Header({ feedUrl, loading, onReload }) {
  return (
    <div className="flex items-baseline justify-between gap-4 flex-wrap">
      <div>
        <h3 className="font-semibold text-sm">Podbean</h3>
        <p className="text-xs text-slate-500">
          Approving a transcript queues its publish; this is what happened next.
        </p>
      </div>
      <div className="flex items-center gap-2">
        {feedUrl && (
          <a
            href={feedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-slate-500 hover:underline inline-flex items-center gap-1"
          >
            Feed <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={onReload}
          disabled={loading}
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
        </Button>
      </div>
    </div>
  );
}

export default function DistributionTab({ hub }) {
  const { items, loading, loadError, feedUrl, busyKey, reload, retryHost } = hub;

  const byState = new Map(GROUPS.map((group) => [group.state, []]));
  for (const item of items) byState.get(hostState(item))?.push(item);

  return (
    <div className="space-y-6">
      <Header feedUrl={feedUrl} loading={loading} onReload={reload} />
      <ReadState
        loading={loading}
        loadError={loadError}
        empty={items.length === 0}
        emptyMessage="No transcripts yet, so nothing has been distributed."
      />

      {GROUPS.map((group) => (
        <Group
          key={group.state}
          group={group}
          items={byState.get(group.state) || []}
          onRetry={retryHost}
          busyKey={busyKey}
        />
      ))}
    </div>
  );
}

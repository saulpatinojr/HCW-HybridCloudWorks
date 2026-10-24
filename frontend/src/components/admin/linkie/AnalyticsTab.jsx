/**
 * Analytics — the traffic Linkie reports for the profile (#577).
 *
 * Read-only, and its own read: a failed stats call must not take the Links tab
 * with it, and the two are asked of different Linkie endpoints anyway.
 *
 * The read is useLinkieRead and the three states it can be in are one component
 * each — written inline the tab had eight exits, which is what Qlty counts when
 * a promise chain and a render both live in the same function.
 */
import React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertCircle, BarChart3, Loader2 } from 'lucide-react';
import {
  describeLinkieFailure,
  extractTrafficStats,
  trafficStatCards,
  unwrapLinkie,
} from '@/lib/linkie';
import { ltGetTrafficStats } from './linkieApi';
import useLinkieRead from './useLinkieRead';

/**
 * What Linkie sent, or why it cannot be read.
 *
 * The proxy answers HTTP 200 whatever Linkie said, so `ok` is the only signal;
 * without this a refusal renders as an empty analytics panel.
 */
export function readStats(response) {
  const unwrapped = unwrapLinkie(response);
  if (unwrapped.notConfigured || unwrapped.failed) {
    const reason = unwrapped.notConfigured ? unwrapped.reason : describeLinkieFailure(unwrapped);
    return { analytics: null, error: reason };
  }
  // The whole envelope is kept, not just the body: the "Raw analytics response"
  // panel is the operator's only view of what Linkie actually sent, and the
  // upstream status belongs in it.
  return { analytics: response, error: '' };
}

/**
 * Linkie's analytics endpoint takes a `page_id` (it was `link_in_bio_id` until
 * October 2026, when Linkie renamed profiles to pages). The page's own `_id`
 * is what Site-Main sent for the old name, and the current docs name `page_id`
 * as a required parameter of every analytics endpoint — see the note on #626
 * for why the old shape was never fully settled by repository evidence.
 */
const TRAFFIC_READ = Object.freeze({
  fetch: ltGetTrafficStats,
  parse: readStats,
  empty: Object.freeze({ analytics: null }),
});

/** Traffic for one profile, reloadable. */
function useTrafficStats(profileId) {
  const { result, loading, reload } = useLinkieRead(profileId, TRAFFIC_READ);
  return {
    loading,
    analytics: loading ? null : result.analytics,
    error: loading ? '' : result.error,
    reload,
  };
}

/** No profile to ask about — a different problem from "no traffic". */
function NoProfileNotice({ profileNotice }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-xs">
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span>{profileNotice || 'No Linkie profile selected — check the Settings tab.'}</span>
    </div>
  );
}

function ReadFailed({ error, onRetry }) {
  return (
    <div className="flex flex-col items-center py-8 gap-3">
      <AlertCircle className="h-6 w-6 text-destructive" />
      <p className="text-sm text-destructive">{error}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/** The summary cards, or the reason there are none to show. */
function StatCards({ stats }) {
  if (stats.length === 0) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
        <BarChart3 className="h-6 w-6 mx-auto mb-2 opacity-60" />
        Analytics connected, but no summary metrics were returned.
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {stats.map(({ label, value }) => (
        <Card key={label} className="p-4 text-center">
          <p className="text-2xl font-bold">{value}</p>
          <p className="text-xs text-muted-foreground mt-1">{label}</p>
        </Card>
      ))}
    </div>
  );
}

function TrafficReport({ analytics }) {
  return (
    <div className="space-y-4 max-w-3xl">
      <StatCards stats={trafficStatCards(extractTrafficStats(analytics))} />
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Raw analytics response</summary>
        <pre className="mt-2 p-3 rounded-lg bg-muted overflow-auto max-h-80">
          {JSON.stringify(analytics, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export default function AnalyticsTab({ profileId, profileNotice }) {
  const { loading, analytics, error, reload } = useTrafficStats(profileId);

  if (!profileId) return <NoProfileNotice profileNotice={profileNotice} />;
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error) return <ReadFailed error={error} onRetry={reload} />;
  return <TrafficReport analytics={analytics} />;
}

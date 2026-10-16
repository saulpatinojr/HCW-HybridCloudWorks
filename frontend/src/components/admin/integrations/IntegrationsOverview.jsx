/**
 * Overview tab — every service on one compact grid, worst first (#570).
 *
 * A tile's status comes from three things: the lights of the keys it uses
 * (from `cms/secrets`, read by this tab), this session's test of it, if any,
 * and otherwise the persisted record of its last test (`cms/integration-status`,
 * ADR 0033), so a service that failed yesterday is still first this morning.
 * A broken service sorts first, then one nobody has set up, so the tile to
 * look at is the top-left one.
 *
 * "Test all" runs each service's own test, one after another — never in
 * parallel — so it sends each provider the single request its card's beaker
 * would. YouTube is left out because its test spends quota; its tile says so.
 * The results are the page's (useServiceTests), so they are still there on the
 * Services tab, each with the time it ran, and each is recorded for next time.
 */

import React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { FlaskConical, Loader2, RefreshCw } from 'lucide-react';
import { getSessionizeSpeakerId } from '@/lib/adminSettings';
import { sortByStatus, SERVICE_STATUS } from './integrationView';
import { SERVICES } from './serviceRegistry';
import { relativeTime } from './StateDot';
import useServiceCards, { effectiveResult } from './useServiceCards';
import { KeyStatusNotices } from './TabNotice';

/** Sessionize takes its speaker id; every other test takes nothing. */
export const testArgFor = (service) =>
  service.setting === 'sessionizeSpeakerId' ? getSessionizeSpeakerId() : undefined;

// effectiveResult lives in useServiceCards.js now (shared with the Directory);
// re-exported so this module's callers and tests keep their import.
export { effectiveResult };

function StatusLine({ status, result, testing }) {
  const presentation = SERVICE_STATUS[status];
  if (testing) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Testing…
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span data-testid="service-status">
        <StatusBadge status={presentation.badge} size="xs" />
      </span>
      {result?.at ? (
        <span className="text-muted-foreground">
          {result.recorded ? 'last tested' : 'tested'} {relativeTime(result.at)}
        </span>
      ) : null}
    </span>
  );
}

function ServiceTile({ service, result, testing, onOpen }) {
  const Icon = service.icon;
  return (
    <Card className="p-3" data-service={service.id}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <button
            type="button"
            onClick={() => onOpen(service.group)}
            className="text-left text-sm font-semibold hover:underline"
            title={`Open ${service.name} on the Services tab`}
          >
            {service.name}
          </button>
          <div>
            <StatusLine status={service.status} result={result} testing={testing} />
          </div>
          {result?.ok === false ? (
            <p className="wrap-break-word text-xs text-destructive">{result.message}</p>
          ) : null}
          {service.skipInTestAll ? (
            <p className="text-xs text-muted-foreground">
              Not in Test all. {service.skipInTestAll}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export default function IntegrationsOverview({ tests, onOpenGroup }) {
  const { serviceCards, results, data, loading, error, reload } = useServiceCards(tests);
  const tiles = sortByStatus(serviceCards, results);
  const testable = SERVICES.filter((service) => service.test && !service.skipInTestAll);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Every service, broken and not-configured first. Test all asks each of the{' '}
          {testable.length} testable services in turn, one at a time. Each result is recorded, so
          the last verdict is still here after a reload.
          {tests.persistedState === 'failed'
            ? ' Earlier results could not be read this time; what you see is this session alone.'
            : ''}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" aria-hidden="true" /> Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => tests.runAll(SERVICES, testArgFor)}
            disabled={tests.runningAll}
          >
            {tests.runningAll ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <FlaskConical className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            )}
            {tests.runningAll ? 'Testing…' : 'Test all'}
          </Button>
        </div>
      </div>

      <KeyStatusNotices
        loading={loading}
        data={data}
        error={error}
        onRetry={reload}
        fallback="a status with no recorded test may be incomplete"
      />

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Services">
        {tiles.map((service) => (
          <li key={service.id}>
            <ServiceTile
              service={service}
              result={results[service.id]}
              testing={tests.testing.has(service.id)}
              onOpen={onOpenGroup}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

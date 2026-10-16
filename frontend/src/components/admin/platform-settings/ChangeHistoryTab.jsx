/**
 * Change history — every platform setting save, newest first (#571).
 *
 * Reads `GET cms/platform-settings/history`, which returns the
 * `platform_setting_updated` audit rows as `{ id, at, actor, setting, summary }`
 * and a `nextAfter` cursor when there may be more. The summary is what the
 * server recorded at save time — counts and choices, never contents — so the
 * table shows it as `key: value` chips rather than interpreting it.
 *
 * The tab mounts fresh whenever it is opened, so a save made on another tab
 * is listed on arrival; Refresh is for a save made elsewhere meanwhile.
 *
 * Race-safety: a reload (mount, filter change, Refresh) takes a new
 * generation and only the latest may write; a failed reload clears the rows
 * rather than leaving the previous filter's rows under the new one. Load more
 * is guarded by a ref, appends only if no reload has started since, and a
 * failure there keeps the rows already shown, which are still correct.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthReady } from '@/hooks/useAuthReady';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { History, Loader2, RefreshCw } from 'lucide-react';
import { getJSON } from '@/lib/api';
import { HISTORY_FILTERABLE, SELECT_CLASS, SETTING_LABELS } from './settingShared';

export const HISTORY_ROUTE = 'cms/platform-settings/history';
export const HISTORY_PAGE_SIZE = 25;

export function historyRoute({ setting = '', after = null } = {}) {
  const params = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
  if (setting) params.set('setting', setting);
  if (after) params.set('after', after);
  return `${HISTORY_ROUTE}?${params.toString()}`;
}

/** A recorded summary value as one short string. */
export function formatSummaryValue(value) {
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : 'none';
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

const formatWhen = (iso) => {
  const time = Date.parse(iso ?? '');
  return Number.isFinite(time) ? new Date(time).toLocaleString() : 'unknown time';
};

const errorText = (err) => err?.message || 'Could not load the change history.';

function useHistory(setting, authReady) {
  const [entries, setEntries] = useState([]);
  const [nextAfter, setNextAfter] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const generation = useRef(0);
  const moreInFlight = useRef(false);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    const current = () => mine === generation.current;
    setLoading(true);
    setError('');
    setMoreError('');
    try {
      const res = await getJSON(historyRoute({ setting }));
      if (!current()) return;
      setEntries(Array.isArray(res?.entries) ? res.entries : []);
      setNextAfter(res?.nextAfter ?? null);
    } catch (err) {
      if (!current()) return;
      setEntries([]);
      setNextAfter(null);
      setError(errorText(err));
    } finally {
      if (current()) setLoading(false);
    }
  }, [setting]);

  useEffect(() => {
    if (!authReady) return undefined;
    queueMicrotask(reload);
    return () => {
      // Unmounting or a newer filter: whatever is in flight may not write.
      generation.current += 1;
    };
  }, [reload, authReady]);

  const loadMore = useCallback(async () => {
    if (!nextAfter || moreInFlight.current) return;
    moreInFlight.current = true;
    const mine = generation.current;
    setLoadingMore(true);
    setMoreError('');
    try {
      const res = await getJSON(historyRoute({ setting, after: nextAfter }));
      if (mine !== generation.current) return;
      setEntries((previous) => [...previous, ...(Array.isArray(res?.entries) ? res.entries : [])]);
      setNextAfter(res?.nextAfter ?? null);
    } catch (err) {
      if (mine === generation.current) setMoreError(errorText(err));
    } finally {
      moreInFlight.current = false;
      setLoadingMore(false);
    }
  }, [nextAfter, setting]);

  return { entries, nextAfter, loading, error, loadingMore, moreError, reload, loadMore };
}

function SummaryChips({ summary }) {
  const pairs = Object.entries(summary ?? {});
  if (pairs.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Summary">
      {pairs.map(([key, value]) => (
        <li
          key={key}
          className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-xs"
        >
          {key}: {formatSummaryValue(value)}
        </li>
      ))}
    </ul>
  );
}

function HistoryTable({ entries }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border text-xs uppercase text-muted-foreground">
          <tr>
            <th scope="col" className="py-2 pr-4 font-medium">
              When
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Who
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Setting
            </th>
            <th scope="col" className="py-2 font-medium">
              Summary
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className="border-b border-border/60 align-top last:border-0">
              <td className="whitespace-nowrap py-2 pr-4">
                <time dateTime={entry.at ?? undefined}>{formatWhen(entry.at)}</time>
              </td>
              <td className="py-2 pr-4 font-mono text-xs">{entry.actor || 'unknown'}</td>
              <td className="whitespace-nowrap py-2 pr-4">
                {SETTING_LABELS[entry.setting] ?? entry.setting ?? 'unknown'}
              </td>
              <td className="py-2">
                <SummaryChips summary={entry.summary} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryBody({ history, filtered }) {
  if (history.loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading change history…
      </div>
    );
  }
  if (history.error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
      >
        {history.error}
      </div>
    );
  }
  if (history.entries.length === 0) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        {filtered
          ? 'No changes recorded for this setting yet.'
          : 'No settings changes recorded yet. Each save from this hub, the Newsletter Hub or the Sessionize speaker id on Integrations is listed here.'}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <HistoryTable entries={history.entries} />
      {history.moreError ? (
        <p role="alert" className="text-xs text-destructive">
          {history.moreError}
        </p>
      ) : null}
      {history.nextAfter ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={history.loadingMore}
          onClick={history.loadMore}
        >
          {history.loadingMore ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
          Load more
        </Button>
      ) : null}
    </div>
  );
}

export default function ChangeHistoryTab() {
  const { authReady } = useAuthReady();
  const [setting, setSetting] = useState('');
  const history = useHistory(setting, authReady);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <History className="h-5 w-5" /> Change history
        </CardTitle>
        <CardDescription>
          Who saved which setting and when, with what the save recorded: counts and choices, never
          the contents. Newest first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="history-setting">Setting</Label>
            <select
              id="history-setting"
              className={`${SELECT_CLASS} w-60`}
              value={setting}
              onChange={(event) => setSetting(event.target.value)}
            >
              <option value="">All settings</option>
              {HISTORY_FILTERABLE.map((id) => (
                <option key={id} value={id}>
                  {SETTING_LABELS[id]}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={history.loading}
            onClick={history.reload}
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
        <HistoryBody history={history} filtered={Boolean(setting)} />
      </CardContent>
    </Card>
  );
}

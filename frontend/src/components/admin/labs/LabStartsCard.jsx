/**
 * "Lab sessions started": how many visitor lab sessions the website has
 * started, for the owner's reports and letters. On the Labs hub Dashboard, behind
 * the admin sign-in like the rest of the hub. Nothing here is public.
 *
 * Loads itself once auth is ready (one GET of `cms/labs/starts`), behind a
 * generation guard so an answer that lands after unmount sets nothing. Words
 * are labStartsView.js's. The card says in plain words what is counted, what
 * is not, and the day counting began, because the figure will be quoted.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import EmptyState from '@/components/admin/shared/EmptyState';
import { getJSON } from '@/lib/api';
import { useAuthReady } from '@/hooks/useAuthReady';
import { LAB_STARTS_ROUTE, describeLabStarts } from './labStartsView';

/** The read, loaded once auth is ready, and again on `reload`. */
export function useLabStarts() {
  const { authReady } = useAuthReady();
  const [state, setState] = useState({ loading: true, read: null, error: null });
  const generation = useRef(0);

  // One read, applied only if it is still the latest one asked for.
  const fetchRead = useCallback((mine) => {
    getJSON(LAB_STARTS_ROUTE)
      .then((read) => {
        if (mine === generation.current) setState({ loading: false, read, error: null });
      })
      .catch((err) => {
        if (mine === generation.current) {
          setState({ loading: false, read: null, error: err?.message || 'The read failed.' });
        }
      });
  }, []);

  useEffect(() => {
    if (!authReady) return undefined;
    fetchRead(++generation.current);
    return () => {
      generation.current += 1;
    };
  }, [authReady, fetchRead]);

  const reload = useCallback(() => {
    setState({ loading: true, read: null, error: null });
    fetchRead(++generation.current);
  }, [fetchRead]);

  return { ...state, reload };
}

function CopyForLetter({ sentence }) {
  const [state, setState] = useState('idle');
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('No clipboard');
      await navigator.clipboard.writeText(sentence);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return (
    <div className="space-y-2">
      <p
        className="rounded-md border border-border bg-muted/40 p-3 text-xs select-all"
        data-testid="lab-starts-sentence"
      >
        {sentence}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={copy}>
          {state === 'copied' ? (
            <Check className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <Copy className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          )}
          Copy as text for a letter
        </Button>
        <span className="text-xs text-muted-foreground" role="status">
          {state === 'copied' ? 'Copied.' : null}
          {state === 'failed'
            ? 'The clipboard is not available here. Select the sentence above and copy it.'
            : null}
        </span>
      </div>
    </div>
  );
}

function Stat({ id, label, value }) {
  return (
    <div className="rounded-md border border-border p-3" data-stat={id}>
      <p className="text-lg font-bold leading-none">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

const COLUMNS = [
  ['today', 'Today'],
  ['last7', '7 days'],
  ['last30', '30 days'],
  ['total', 'Total'],
];

function PerLabTable({ rows }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs" data-testid="lab-starts-table">
        <caption className="sr-only">Lab sessions started, by lab</caption>
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th scope="col" className="py-1 pr-3 font-medium">
              Lab
            </th>
            {COLUMNS.map(([key, label]) => (
              <th key={key} scope="col" className="px-2 py-1 text-right font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.labId} className="border-b border-border/60" data-lab={row.labId}>
              <th scope="row" className="py-1 pr-3 font-normal">
                {row.title}
              </th>
              {COLUMNS.map(([key]) => (
                <td key={key} className="px-2 py-1 text-right">
                  {row[key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LabStartsCard() {
  const { loading, read, error, reload } = useLabStarts();
  const view = describeLabStarts(read);

  return (
    <Card className="space-y-4 p-4" data-testid="lab-starts-card">
      <div>
        <h2 className="text-sm font-semibold">Lab sessions started through the website</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Visitor lab sessions the site has started. Counts only; nothing about who started one is
          kept. Only signed-in admin accounts at editor level or above see this card.
        </p>
      </div>

      {loading ? <Spinner size="sm" label="Reading the lab session counts" /> : null}

      {!loading && (error || !view) ? (
        <EmptyState
          compact
          variant="error"
          title="The lab session counts could not be read"
          description={error || 'The answer was not in the expected shape.'}
          onRetry={reload}
        />
      ) : null}

      {!loading && view ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {view.stats.map((stat) => (
              <Stat key={stat.id} {...stat} />
            ))}
          </div>

          <p className="text-xs" data-testid="lab-starts-since">
            Counting since {view.sinceText}. Nothing earlier was recorded: a visitor session&apos;s
            record is deleted about two hours after it was last updated, so there is no history to
            count from. The last 7 and 30 days include today. Days are UTC days (up to{' '}
            {view.todayText}).
          </p>

          {view.rows.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="lab-starts-empty">
              No lab session has been started yet, so there is nothing to break down by lab.
            </p>
          ) : (
            <PerLabTable rows={view.rows} />
          )}

          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            <li>
              It counts sessions the site created, not people: someone who starts two sessions
              counts twice, because nothing that identifies a person is stored. A session counts
              even if the visitor then does nothing in it, and sessions started by the owner or a
              tester through the public Start button count too.
            </li>
            <li>
              A session is counted once, when the site starts it. A repeat visit that returns a
              session already running, a page view and a refused request are not counted.
            </li>
            <li>
              A signed-in member&apos;s lab started inside the lab pane, and the public validation
              runs, are not visitor sessions and are not counted.
            </li>
          </ul>

          <CopyForLetter sentence={view.sentence} />
        </>
      ) : null}
    </Card>
  );
}

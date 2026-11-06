/**
 * /admin/interviews — every interview made from the admin (ADR 0040, D5;
 * issue #1565): its guest, where it is in its making, its review status and
 * whether it is on the site. A row opens the interview's own page; "New
 * interview" opens the form.
 *
 * Reads GET cms/interviews (editor), which returns list rows only, never a
 * transcript or a consent record.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Plus, RefreshCw } from 'lucide-react';
import SharedPageHeader from '@/components/admin/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { useAuthReady } from '@/hooks/useAuthReady';
import { getJSON } from '@/lib/api';
import { STAGE_LABELS, STATUS_LABELS } from '@/components/admin/interviews/interviewModel';

const HELP = [
  'An interview is made here in three steps: fill in the guest and their agreement, give the site the recording (a file, a link) or a transcript you already have, then read and correct the questions and answers the site drafts.',
  'Nothing is published by itself. You send the interview to review, approve it, and publish it from its page, as with any other content.',
  'The recording is kept privately and is never shown on the site. The runbook “Add an interview” in the documentation explains each stage.',
];

function Row({ item }) {
  const updated = item.updatedAt || item.createdAt;
  return (
    <li className="rounded-md border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          to={`/admin/interviews/${encodeURIComponent(item.id)}`}
          className="font-medium underline"
        >
          {item.title || 'Untitled interview'}
        </Link>
        <span className="text-xs text-muted-foreground">
          {STATUS_LABELS[item.contentStatus] || item.contentStatus}
          {item.live ? ' · on the site' : ''}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {item.guest?.name || 'No guest named'}
        {item.guest?.role ? `, ${item.guest.role}` : ''}
      </p>
      <p className="text-xs">
        {STAGE_LABELS[item.stage] || item.stage}
        {item.stage === 'failed' && item.stageError ? `: ${item.stageError}` : ''}
        {updated ? ` · updated ${String(updated).slice(0, 10)}` : ''}
      </p>
    </li>
  );
}

export default function InterviewsPage() {
  const { authReady } = useAuthReady();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const answer = await getJSON('cms/interviews');
      setRows(Array.isArray(answer?.interviews) ? answer.interviews : []);
      setError('');
    } catch (failure) {
      setError(failure?.message || 'The interviews could not be read.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authReady) return;
    // Started from an async function, as useDocVault does: the read's own
    // setState calls come after the request, not in the effect's body.
    (async () => {
      await load();
    })();
  }, [authReady, load]);

  return (
    <div className="max-w-5xl space-y-6">
      <SharedPageHeader
        help={HELP}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" className="gap-1">
              <Link to="/admin/interviews/new">
                <Plus className="h-4 w-4" aria-hidden="true" /> New interview
              </Link>
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setLoading(true);
                load();
              }}
              disabled={loading}
              className="gap-1"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
            </Button>
          </div>
        }
      />
      {error && (
        <p role="alert" className="rounded-md border border-red-300 p-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {loading && rows.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading interviews…
        </p>
      )}
      {!loading && rows.length === 0 && !error && (
        <div className="rounded-md border p-6 text-sm">
          <p className="font-medium">No interviews yet.</p>
          <p className="text-muted-foreground">
            Start one with New interview: the guest&apos;s details, their agreement to publish, and
            a recording or a transcript.
          </p>
        </div>
      )}
      {rows.length > 0 && (
        <ul className="space-y-3" aria-label="Interviews">
          {rows.map((item) => (
            <Row key={item.id} item={item} />
          ))}
        </ul>
      )}
    </div>
  );
}

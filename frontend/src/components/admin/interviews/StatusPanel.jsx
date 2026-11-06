/**
 * Review and publishing for one interview (ADR 0040, D5, D9 and D10): its
 * status, the next move (Send to review, Approve, Publish, Unpublish), the
 * live address once published, and Delete recording. Publishing,
 * unpublishing and deleting the recording are publisher actions; the
 * buttons say so to an editor instead of failing (components/admin/RoleGate).
 */
import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import ConfirmModal from '@/components/admin/ConfirmModal';
import RoleGate from '@/components/admin/RoleGate';
import { Button } from '@/components/ui/button';
import { STATUS_LABELS, statusActions } from './interviewModel';

/**
 * @param {object} props
 * @param {object} props.doc
 * @param {string} props.busy
 * @param {(newStatus: string, label: string) => void} props.onTransition
 * @param {() => void} props.onPublish
 * @param {() => void} props.onUnpublish
 * @param {() => void} props.onDeleteAudio
 * @param {boolean} [props.blocked] - true while the page has unsaved edits
 */
export default function StatusPanel({
  doc,
  busy,
  onTransition,
  onPublish,
  onUnpublish,
  onDeleteAudio,
  blocked = false,
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = doc?.contentStatus || 'draft';
  const live = doc?.Live === true;
  const hasQa = Array.isArray(doc?.qa) && doc.qa.length > 0;
  const actions = statusActions(status, { live, hasQa });
  const audio = doc?.provenance?.audio;
  const path = doc?.curatedSubpagePath;

  const runAction = (action) => {
    if (action.id === 'publish') return onPublish();
    if (action.id === 'unpublish') return onUnpublish();
    return onTransition(action.to, action.to === 'approved' ? 'Approved' : 'Sent to review');
  };

  return (
    <section aria-labelledby="interview-status" className="space-y-3 rounded-md border p-4">
      <h2 id="interview-status" className="text-base font-semibold">
        Review and publish
      </h2>
      <p className="text-sm">
        Status: <strong data-testid="interview-status">{STATUS_LABELS[status] || status}</strong>
        {live ? ' (on the site)' : ''}
      </p>
      {live && path && (
        <p className="text-sm">
          <a
            href={path}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline"
          >
            Open the live page (new tab) <ExternalLink className="h-3 w-3" aria-hidden="true" />
          </a>
        </p>
      )}
      {!hasQa && !live && (
        <p className="text-sm text-muted-foreground">
          The interview can go to review once it has questions and answers.
        </p>
      )}
      {blocked && actions.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Save or undo your changes first, so what is reviewed is what you see.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <RoleGate key={action.id} minRole={action.minRole}>
            <Button
              size="sm"
              variant={action.id === 'unpublish' ? 'outline' : 'default'}
              disabled={Boolean(busy) || blocked}
              onClick={() => runAction(action)}
            >
              {busy === action.id || busy === action.to ? `${action.label}…` : action.label}
            </Button>
          </RoleGate>
        ))}
      </div>
      <div className="space-y-2 border-t pt-3">
        <h3 className="text-sm font-semibold">The recording</h3>
        {audio?.path ? (
          <>
            <p className="text-sm text-muted-foreground">
              The recording is kept privately for the site&apos;s records and is never published. It
              is deleted automatically after the retention period. Deleting it now keeps the
              transcript.
            </p>
            <RoleGate minRole="publisher">
              <Button
                size="sm"
                variant="destructive"
                disabled={Boolean(busy)}
                onClick={() => setConfirmDelete(true)}
              >
                Delete recording
              </Button>
            </RoleGate>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No recording is stored for this interview.
          </p>
        )}
      </div>
      <ConfirmModal
        open={confirmDelete}
        title="Delete the recording?"
        description="The recording is deleted from storage now. The transcript and the questions and answers stay. Storage can keep a recoverable copy for a short while (see the add-an-interview runbook), after which it is gone for good."
        confirmLabel="Delete recording"
        destructive
        onConfirm={() => {
          setConfirmDelete(false);
          onDeleteAudio();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </section>
  );
}

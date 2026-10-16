/**
 * Queue — what Publer is holding to post, and the hub's own records of it
 * (#575). Its one duty is the schedule that has not happened yet.
 *
 * Two lists, because they can disagree: Publer's queue is the truth about what
 * will publish, and the local `social_posts` records are what this hub believes
 * it scheduled. A post deleted in Publer's own UI leaves a record here, which
 * is the point of showing both.
 *
 * A local record can be edited and moved here (ADR 0033 Amplify slice):
 * PATCH cms/social-posts/{id} changes the caption or the time, and the
 * change feed pushes the new text and time to Publer for every post id it
 * holds. Deletes confirm first.
 *
 * The state is useSocialQueue; this file is the cards and the three bodies
 * the tab can show, first match wins (PR #841).
 */
import React, { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import ConfirmModal from '@/components/admin/ConfirmModal';
import EmptyState from '@/components/admin/shared/EmptyState';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { useToast } from '@/components/ui/use-toast';
import { AlertCircle, Clock, Loader2, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { sendJSON } from '@/lib/api';
import { firstText, fmtDate } from './socialView';
import { PlatformBadge } from './shared';
import useSocialQueue from './useSocialQueue';

/** A record's status as the shared vocabulary reads it. */
const recordStatus = (post) => {
  const status = String(post.status || 'scheduled');
  if (post.syncStatus === 'failed') {
    return {
      id: 'failed',
      label: 'Sync failed',
      tone: 'bad',
      help: post.syncError || 'Publer did not take the last change.',
    };
  }
  if (status === 'published')
    return { id: 'published', label: 'Published', tone: 'ok', help: 'Publer posted it.' };
  if (status === 'failed')
    return { id: 'failed', label: 'Failed', tone: 'bad', help: 'Publer could not post it.' };
  return {
    id: status,
    label: status.charAt(0).toUpperCase() + status.slice(1),
    tone: 'warn',
    help: 'Waiting for its time.',
  };
};

/** `YYYY-MM-DDTHH:MM` local, for a datetime-local input. */
function localInputValue(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** One post Publer is holding, with the delete that removes it there. */
function PublerQueueCard({ post, deleting, onDelete }) {
  const text = firstText([post.caption, post.text, post.description], '—');
  const provider = firstText([post.network, post.provider]);
  const accts = Array.isArray(post.accounts) ? post.accounts : [];
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium line-clamp-2">{text}</p>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            {provider && <PlatformBadge provider={provider} />}
            {accts.map((a, i) => (
              <Badge key={i} variant="outline" className="text-xs">
                {firstText([a?.name, a?.id], 'account')}
              </Badge>
            ))}
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {fmtDate(post.scheduled_at)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="secondary" className="capitalize text-xs">
            {firstText([post.status, post.state], 'scheduled')}
          </Badge>
          <DeleteButton
            label={`Delete Publer post ${text.slice(0, 40)}`}
            disabled={!post.id}
            busy={deleting}
            onClick={() => onDelete(post)}
          />
        </div>
      </div>
    </Card>
  );
}

/** One social_posts record this hub wrote when it scheduled something. */
function LocalRecordCard({ post, deleting, onDelete, onEdit }) {
  const editable = post.status !== 'published';
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium line-clamp-2">{post.caption || '—'}</p>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            {(post.platforms || []).map((platform) => (
              <PlatformBadge key={platform} provider={platform} />
            ))}
            {post.scheduledAt && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {fmtDate(post.scheduledAt)}
              </span>
            )}
            {post.syncStatus === 'pending' && (
              <span className="text-xs text-muted-foreground">Publer update pending</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={recordStatus(post)} size="xs" />
          {editable && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={`Edit post ${(post.caption || '').slice(0, 40)}`}
              title="Edit the caption or move the time"
              onClick={() => onEdit(post)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          <DeleteButton
            label={`Delete record ${(post.caption || '').slice(0, 40)}`}
            busy={deleting}
            onClick={() => onDelete(post)}
          />
        </div>
      </div>
    </Card>
  );
}

/** The trash button both cards use, spinner and all. */
function DeleteButton({ label, busy, disabled = false, onClick }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-destructive hover:bg-destructive/10"
      disabled={disabled || busy}
      aria-label={label}
      onClick={onClick}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
    </Button>
  );
}

/** Edit a record's caption and, while it is still scheduled, its time. */
function EditRecordDialog({ post, onClose, onSaved }) {
  const { toast } = useToast();
  const [caption, setCaption] = useState(post.caption || '');
  const [when, setWhen] = useState(localInputValue(post.scheduledAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canMove = post.status === 'scheduled' && Boolean(post.scheduledAt);

  const save = async (event) => {
    event.preventDefault();
    const body = {};
    if (caption.trim() !== (post.caption || '')) body.caption = caption.trim();
    if (
      canMove &&
      when &&
      new Date(when).toISOString() !== new Date(post.scheduledAt).toISOString()
    ) {
      if (new Date(when).getTime() <= Date.now()) {
        setError('That time has passed. Pick a time in the future.');
        return;
      }
      body.scheduledAt = new Date(when).toISOString();
    }
    if (Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await sendJSON(`cms/social-posts/${encodeURIComponent(post.id)}`, 'PATCH', body);
      toast({
        title: 'Post updated',
        description:
          res?.publer?.push === 'change-feed'
            ? 'Publer is being updated now.'
            : 'Publer has not reported this post yet; the next sync carries the change.',
      });
      onSaved(res?.item || { ...post, ...body });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={save} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Edit post</DialogTitle>
            <DialogDescription>
              The change is pushed to Publer for every account this post went to.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="social-edit-caption">Caption</Label>
            <Textarea
              id="social-edit-caption"
              rows={4}
              maxLength={5000}
              value={caption}
              onChange={(event) => setCaption(event.target.value)}
            />
          </div>
          {canMove && (
            <div className="space-y-1.5">
              <Label htmlFor="social-edit-when">
                Posts at ({Intl.DateTimeFormat().resolvedOptions().timeZone})
              </Label>
              <Input
                id="social-edit-when"
                type="datetime-local"
                value={when}
                onChange={(event) => setWhen(event.target.value)}
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !caption.trim()}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function QueueLoading() {
  return (
    <div className="flex items-center justify-center py-12">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

function QueueUnavailable({ error, refresh }) {
  return (
    <EmptyState
      variant="error"
      title="The queue could not be read"
      description={error}
      onRetry={refresh}
    />
  );
}

/** Publer's queue above, the hub's own records below, and the two dialogs. */
function QueueLists({
  publerPosts,
  publerNotice,
  localPosts,
  deletingId,
  pendingDelete,
  setPendingDelete,
  editing,
  setEditing,
  refresh,
  confirmDelete,
  applyEdit,
}) {
  const totalPubler = publerPosts.length;
  const totalLocal = localPosts.length;

  return (
    <div className="space-y-6">
      {/* Publer live queue */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Publer Queue
            {totalPubler > 0 && (
              <Badge variant="secondary" className="ml-2 text-xs">
                {totalPubler}
              </Badge>
            )}
          </h3>
          <Button variant="ghost" size="sm" onClick={refresh} className="gap-1.5 h-7">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>

        {publerNotice && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {publerNotice}
          </p>
        )}

        {!publerNotice && totalPubler === 0 && (
          <EmptyState
            compact
            title="No scheduled posts in Publer"
            description="Compose a post with a time and it appears here until Publer posts it."
          />
        )}

        {publerPosts.map((post, index) => (
          <PublerQueueCard
            key={post.id ?? `publer-${index}`}
            post={post}
            deleting={deletingId === post.id}
            onDelete={(target) => setPendingDelete({ kind: 'publer', post: target })}
          />
        ))}
      </div>

      {/* Local social-post records */}
      {totalLocal > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            Local Records
            <Badge variant="secondary" className="ml-2 text-xs">
              {totalLocal}
            </Badge>
          </h3>
          {localPosts.map((post) => (
            <LocalRecordCard
              key={post.id}
              post={post}
              deleting={deletingId === post.id}
              onDelete={(target) => setPendingDelete({ kind: 'local', post: target })}
              onEdit={setEditing}
            />
          ))}
        </div>
      )}

      <ConfirmModal
        open={Boolean(pendingDelete)}
        title={
          pendingDelete?.kind === 'publer' ? 'Delete this post from Publer?' : 'Remove this record?'
        }
        description={
          pendingDelete?.kind === 'publer'
            ? 'Publer will not post it. This cannot be undone.'
            : 'The record is removed here and the post is deleted from Publer when Publer has it. This cannot be undone.'
        }
        confirmLabel="Delete"
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />

      {editing && (
        <EditRecordDialog post={editing} onClose={() => setEditing(null)} onSaved={applyEdit} />
      )}
    </div>
  );
}

/** The three bodies the tab can show, first match wins. */
const QUEUE_VIEWS = [
  [(q) => q.loading, QueueLoading],
  [(q) => Boolean(q.error), QueueUnavailable],
  [() => true, QueueLists],
];

export default function QueueTab() {
  const queue = useSocialQueue();
  const [, View] = QUEUE_VIEWS.find(([when]) => when(queue));
  return <View {...queue} />;
}

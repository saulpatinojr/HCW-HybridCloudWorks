/**
 * One calendar item, opened: what it is, when, its status, and the actions
 * its kind allows (ADR 0033 Amplify slice).
 *
 *   content     Edit (editor) · Open (queue) · Reschedule · Unschedule · Share
 *               (Social compose with ?contentId=) · failed: Retry on Publish
 *   social      Edit caption · Reschedule · Duplicate (compose with the same
 *               content) · Cancel (deletes the record and its Publer post)
 *   newsletter  Open the issue in the Newsletter Hub (cancel and reschedule
 *               live there, beside the preview)
 *   everything else  Open its hub
 *
 * Destructive actions confirm first. Every action the dialog performs is
 * reported back through `onDone`, which refetches.
 */
import React, { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
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
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { useToast } from '@/components/ui/use-toast';
import {
  CalendarClock,
  CalendarX,
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  RotateCcw,
  Share2,
  Trash2,
} from 'lucide-react';
import RoleGate from '@/components/admin/RoleGate';
import { deleteSocialPost, patchSocialPost, unscheduleContent } from './calendarApi';
import {
  browserTimeZone,
  formatWhen,
  itemStatus,
  kindMeta,
  socialComposeHref,
} from './calendarModel';

/** `YYYY-MM-DDTHH:MM` local, for a datetime-local input. */
function localInputValue(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The PATCH body for a social edit, or `{ error }`; empty when nothing changed. */
export function socialPatchBody(item, { caption, when, canMove }) {
  const body = {};
  if (caption.trim() !== (item.meta?.caption || item.title || '')) body.caption = caption.trim();
  if (canMove && when && new Date(when).toISOString() !== new Date(item.start).toISOString()) {
    if (new Date(when).getTime() <= Date.now()) {
      return { error: 'That time has passed. Pick a time in the future.' };
    }
    body.scheduledAt = new Date(when).toISOString();
  }
  return { body };
}

function SocialEditor({ item, onDone, onClose }) {
  const { toast } = useToast();
  const [caption, setCaption] = useState(item.meta?.caption || item.title || '');
  const [when, setWhen] = useState(localInputValue(item.start));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canMove = item.status === 'scheduled';

  const save = async (event) => {
    event.preventDefault();
    const patch = socialPatchBody(item, { caption, when, canMove });
    if (patch.error) {
      setError(patch.error);
      return;
    }
    if (Object.keys(patch.body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await patchSocialPost(item.sourceId, patch.body);
      toast({
        title: 'Post updated',
        description:
          res?.publer?.push === 'change-feed'
            ? 'Publer is being updated now.'
            : 'Publer has not reported this post yet; the next sync carries the change.',
      });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="cal-social-caption">Caption</Label>
        <Textarea
          id="cal-social-caption"
          rows={4}
          maxLength={5000}
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
        />
      </div>
      {canMove && (
        <div className="space-y-1.5">
          <Label htmlFor="cal-social-when">Posts at ({browserTimeZone()})</Label>
          <Input
            id="cal-social-when"
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
          Back
        </Button>
        <Button type="submit" disabled={busy || !caption.trim()}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A link styled as a button. */
function LinkAction({ to, icon: Icon, children, primary = false }) {
  return (
    <Button asChild variant={primary ? 'default' : 'outline'} size="sm" className="gap-1.5">
      <Link to={to}>
        <Icon className="h-3.5 w-3.5" /> {children}
      </Link>
    </Button>
  );
}

/** A content item's actions, the two schedule writes gated so an editor on the calendar learns their role before the round trip. */
function ContentActions({ item, busy, onReschedule, onUnschedule }) {
  const pending = item.status !== 'published';
  return (
    <>
      <LinkAction to={`/admin/editor/${encodeURIComponent(item.sourceId)}`} icon={Pencil}>
        Edit
      </LinkAction>
      <LinkAction to={item.href} icon={ExternalLink}>
        Open
      </LinkAction>
      <LinkAction to={socialComposeHref(item.sourceId)} icon={Share2}>
        Schedule social
      </LinkAction>
      {/* saveContentSchedule and unscheduleContent are publisher
          (lib/content-workflow/schedule.js); the calendar itself is editor. */}
      {pending && (
        <RoleGate minRole="publisher" reason="Changing the publish time needs the publisher role.">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={onReschedule}
            disabled={busy}
          >
            <CalendarClock className="h-3.5 w-3.5" /> Reschedule
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={onUnschedule}
            disabled={busy}
          >
            <CalendarX className="h-3.5 w-3.5" /> Unschedule
          </Button>
        </RoleGate>
      )}
      {item.status === 'failed' && (
        <LinkAction to="/admin/publish" icon={RotateCcw} primary>
          Retry on Publish
        </LinkAction>
      )}
    </>
  );
}

function SocialActions({ item, busy, onEdit, onCancel }) {
  const pending = item.status !== 'published';
  return (
    <>
      {pending && (
        <Button variant="outline" size="sm" className="gap-1.5" onClick={onEdit} disabled={busy}>
          <Pencil className="h-3.5 w-3.5" /> Edit / reschedule
        </Button>
      )}
      <LinkAction to={socialComposeHref(item.meta?.contentId)} icon={Copy}>
        Duplicate
      </LinkAction>
      <LinkAction to={item.href} icon={ExternalLink}>
        Open queue
      </LinkAction>
      {pending && (
        <Button
          variant="destructive"
          size="sm"
          className="gap-1.5"
          onClick={onCancel}
          disabled={busy}
        >
          <Trash2 className="h-3.5 w-3.5" /> Cancel post
        </Button>
      )}
    </>
  );
}

function Actions({ item, busy, onReschedule, onEdit, onConfirm }) {
  if (item.kind === 'content') {
    return (
      <ContentActions
        item={item}
        busy={busy}
        onReschedule={() => onReschedule(item)}
        onUnschedule={() => onConfirm('unschedule')}
      />
    );
  }
  if (item.kind === 'social') {
    return (
      <SocialActions
        item={item}
        busy={busy}
        onEdit={onEdit}
        onCancel={() => onConfirm('cancel-social')}
      />
    );
  }
  const label = item.kind === 'newsletter' ? 'Open the issue' : `Open ${kindMeta(item.kind).label}`;
  return (
    <LinkAction to={item.href} icon={ExternalLink}>
      {label}
    </LinkAction>
  );
}

export default function ItemPreviewDialog({ item, onClose, onDone, onReschedule }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState(null); // 'unschedule' | 'cancel-social'
  const [busy, setBusy] = useState(false);
  if (!item) return null;
  const meta = kindMeta(item.kind);
  const { Icon } = meta;

  const run = async (label, action, done) => {
    setBusy(true);
    try {
      await action();
      toast({ title: label, description: done });
      onDone();
    } catch (err) {
      toast({ title: `${label} failed`, description: err.message, variant: 'destructive' });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <>
      <Dialog open onOpenChange={(isOpen) => !isOpen && onClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {item.title}
            </DialogTitle>
            <DialogDescription>
              {meta.label} · {formatWhen(item.start, item.allDay)} ({browserTimeZone()})
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={itemStatus(item)} />
            {item.meta?.provider && (
              <span className="text-muted-foreground">{item.meta.provider}</span>
            )}
            {item.meta?.platforms?.length > 0 && (
              <span className="text-muted-foreground">{item.meta.platforms.join(', ')}</span>
            )}
            {item.meta?.contentStatus && (
              <span className="text-xs text-muted-foreground">
                ({item.meta.contentStatus.replace(/_/g, ' ')})
              </span>
            )}
          </div>

          {item.meta?.error && (
            <p
              role="alert"
              className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
            >
              {item.meta.error}
            </p>
          )}

          {item.kind === 'social' && item.meta?.url && (
            <p className="truncate text-xs text-muted-foreground" title={item.meta.url}>
              {item.meta.url}
            </p>
          )}

          {editing ? (
            <SocialEditor item={item} onDone={onDone} onClose={() => setEditing(false)} />
          ) : (
            <div className="flex flex-wrap gap-2">
              <Actions
                item={item}
                busy={busy}
                onReschedule={onReschedule}
                onEdit={() => setEditing(true)}
                onConfirm={setConfirm}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmModal
        open={confirm === 'unschedule'}
        title="Unschedule this content?"
        description="The publish time is cleared. The content keeps its status and returns to the Unscheduled panel."
        confirmLabel="Unschedule"
        destructive={false}
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          run(
            'Unscheduled',
            () => unscheduleContent(item.sourceId),
            `“${item.title}” is back in the Unscheduled panel.`
          )
        }
      />
      <ConfirmModal
        open={confirm === 'cancel-social'}
        title="Cancel this social post?"
        description="The record is deleted here and the post is removed from Publer when Publer has it. This cannot be undone."
        confirmLabel="Cancel post"
        onCancel={() => setConfirm(null)}
        onConfirm={() =>
          run(
            'Post canceled',
            () => deleteSocialPost(item.sourceId),
            'The post is gone from the queue.'
          )
        }
      />
    </>
  );
}

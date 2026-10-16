/**
 * Current Posts — what is on the profile now, and the two edits Linkie allows
 * (#577).
 *
 * Only the URL of an existing post can be changed; everything else about it is
 * fixed once created, which is why the row has one pencil and one bin and no
 * form. Split out of LinksTab with the form: a list, its four empty states and
 * a row editor in one function measured 20.
 */
import React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AlertCircle, Loader2, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { extractPostImage } from '@/lib/linkie';
import { listState } from './linkieView';

function Destructive({ children }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-xs">
      <AlertCircle className="h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

function NoProfile({ profileNotice }) {
  return profileNotice ? <Destructive>{profileNotice}</Destructive> : null;
}

function Loading() {
  return (
    <div className="flex items-center justify-center py-8">
      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

function ReadFailed({ error }) {
  return <Destructive>{error} — check the Settings tab.</Destructive>;
}

function NoPosts() {
  return <p className="text-sm text-muted-foreground py-4 text-center">No posts yet.</p>;
}

/**
 * The one thing the list area says when it has no rows to show, dispatched
 * through `listState` rather than asked as four conditions in a row — the same
 * shape the Recording Hub's HostLine uses, and for the same reason.
 */
const NOTICES = Object.freeze({
  'no-profile': NoProfile,
  loading: Loading,
  error: ReadFailed,
  empty: NoPosts,
});

function ListNotice({ state, error, profileNotice }) {
  const Notice = NOTICES[state];
  return Notice ? <Notice error={error} profileNotice={profileNotice} /> : null;
}

/** The row while its URL is being edited — the only field Linkie lets us change. */
function EditRow({ value, onChange, onSave, onCancel, busy }) {
  return (
    <div className="flex items-center gap-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1"
        aria-label="Post URL"
      />
      <Button size="sm" disabled={busy} onClick={onSave}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
      </Button>
      <Button size="sm" variant="outline" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function PostSummary({ post }) {
  const postImage = extractPostImage(post);
  return (
    <div className="flex-1 min-w-0 flex items-center gap-3">
      {/*
        Rendered from whichever candidate key the post carries, so the owner's
        real posts show which one Linkie uses (#501).
      */}
      {postImage && (
        <img
          src={postImage}
          alt=""
          className="h-10 w-10 shrink-0 rounded object-cover border"
          loading="lazy"
        />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{post.text || post.provider}</p>
        <p className="text-xs text-muted-foreground truncate">{post.url}</p>
        <Badge variant="outline" className="text-xs mt-1">
          {post.provider} · {post.post_type}
        </Badge>
      </div>
    </div>
  );
}

function PostRow({ post, busy, onEdit, onDelete }) {
  return (
    <div className="flex items-center gap-3">
      <PostSummary post={post} />
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={busy || !post._id}
          title="Edit URL — the only field Linkie lets you change"
          onClick={onEdit}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive hover:bg-destructive/10"
          disabled={busy || !post._id}
          title="Delete"
          onClick={onDelete}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
}

export default function PostList({
  posts,
  loading,
  error,
  canWrite,
  profileNotice,
  busyId,
  editingId,
  editingUrl,
  onEditingUrlChange,
  onStartEdit,
  onCancelEdit,
  onSaveUrl,
  onDelete,
  onReload,
}) {
  const state = listState({ canWrite, loading, error, posts });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Current Posts
          {posts.length > 0 && (
            <Badge variant="secondary" className="ml-2 text-xs">
              {posts.length}
            </Badge>
          )}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={onReload}
          disabled={!canWrite}
          className="gap-1.5 h-7"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>

      <ListNotice state={state} error={error} profileNotice={profileNotice} />

      {posts.map((post, index) => (
        <Card key={post._id || index} className="p-3">
          {editingId === post._id ? (
            <EditRow
              value={editingUrl}
              onChange={onEditingUrlChange}
              onSave={() => onSaveUrl(post._id)}
              onCancel={onCancelEdit}
              busy={busyId === post._id}
            />
          ) : (
            <PostRow
              post={post}
              busy={busyId === post._id}
              onEdit={() => onStartEdit(post)}
              onDelete={() => onDelete(post._id)}
            />
          )}
        </Card>
      ))}
    </div>
  );
}

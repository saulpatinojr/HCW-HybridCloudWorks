import { getJSON } from '@/lib/api';
import { getEditedAtMs } from './editorDocModel';

// ── Remote document watch ────────────────────────────────────────────────────
// The Firestore onSnapshot listener becomes fetch-plus-poll: an immediate
// load, then a periodic re-fetch. The same handler drives both, so the
// external-edit-conflict detection (remote blogEditedAt newer than our load
// time) works exactly as it did with realtime pushes — just with up to one
// poll interval of latency.
//
// `refs` are useEditorState's initializedRef, loadTimeRef and
// lastSeenEditedAtMsRef. `handlers` are the state setters it hands over:
// onFirstLoad(data, remoteEditedAtMs), onRemoteChange(data, wasRemoteUpdateAfterLoad),
// setLoadError and setLoading.

function applyRemoteDoc(watch, data) {
  if (watch.cancelled) return;
  const { refs, handlers } = watch;
  handlers.setLoadError(null);
  const remoteEditedAtMs = getEditedAtMs(data);

  if (!refs.initializedRef.current) {
    refs.initializedRef.current = true;
    refs.lastSeenEditedAtMsRef.current = remoteEditedAtMs;
    handlers.onFirstLoad(data, remoteEditedAtMs);
    return;
  }

  // Nothing changed since the last tick — including the case where this is
  // our own save coming back, because `handleSave` records the marker the
  // server returned the moment it returns it.
  //
  // The poll has no change detection at all, so this branch used to fall
  // through and reset `orderedImageUrls` — user-mutable state that is only
  // persisted on save — from the remote document every twenty seconds,
  // discarding an in-progress reorder. It also re-rendered the whole editor
  // on every tick while idle. (T-209)
  //
  // `blogEditedAt` is the only change marker here, and `saveEditorDraft` is
  // its only writer, so an out-of-band status change does not wake this.
  // That is correct for what the poll is: a detector for "another editor
  // saved this document".
  if (remoteEditedAtMs === refs.lastSeenEditedAtMsRef.current) return;

  refs.lastSeenEditedAtMsRef.current = remoteEditedAtMs;

  // Anything that reaches here is a marker we have not seen and did not
  // write, i.e. somebody else's save.
  //
  // What used to be here was a one-shot `pendingLocalSaveRef` boolean,
  // consumed by whatever the *next* response happened to carry. Under
  // `onSnapshot` that was reliably our own write, milliseconds later. Under
  // a twenty-second poll it can be a collaborator's — and the branch then
  // cleared `externallyModified` and adopted THEIR `blogEditedAt` as our
  // baseline, so our next save passed the server's equality check and
  // overwrote them, with no warning to either person. (T-208)
  const wasRemoteUpdateAfterLoad =
    remoteEditedAtMs > 0 &&
    refs.loadTimeRef.current &&
    remoteEditedAtMs > refs.loadTimeRef.current.getTime();

  handlers.onRemoteChange(data, wasRemoteUpdateAfterLoad);
}

function isPermissionError(message) {
  return message.includes('Forbidden') || message.includes('401') || message.includes('403');
}

function handleLoadFailure(watch, err) {
  if (watch.cancelled) return;
  const { refs, handlers } = watch;
  const message = String(err?.message || '');
  if (message.includes('not found')) {
    // Missing doc mirrors the !snap.exists() path: stop loading quietly.
    handlers.setLoading(false);
    return;
  }
  console.error('Error loading document:', err);
  // Only surface the error before first load — a failed background
  // poll on an already-open editor shouldn't blank the page.
  if (!refs.initializedRef.current) {
    handlers.setLoadError(
      isPermissionError(message)
        ? 'Missing or insufficient permissions. Please sign in with an admin account.'
        : 'Unable to load this document right now. Please try again.'
    );
    handlers.setLoading(false);
  }
}

async function fetchRemoteDoc(watch) {
  // getJSON allows 20 s and the poll below fires every 20 s, so ticks can
  // overlap. Two in flight at once can resolve out of order and render an
  // older document over a newer one — which here is worse than a stale
  // view, because `applyRemoteDoc` compares the response's `blogEditedAt`
  // against our load time to decide whether someone else edited the doc.
  // (T-309)
  if (watch.inFlight) return;
  watch.inFlight = true;
  try {
    const res = await getJSON(`cms/content/item?contentId=${encodeURIComponent(watch.blogId)}`);
    if (res.item) applyRemoteDoc(watch, res.item);
  } catch (err) {
    handleLoadFailure(watch, err);
  } finally {
    // `finally`, not the end of `try` — the failure handler returns early on
    // a missing doc and on cancellation, and leaving the flag set on either
    // path would stop the poll permanently.
    watch.inFlight = false;
  }
}

// Starts the load-and-poll for one document. Returns the effect cleanup.
export function watchRemoteDoc(blogId, refs, handlers) {
  refs.initializedRef.current = false;
  refs.loadTimeRef.current = new Date();
  const watch = { blogId, refs, handlers, cancelled: false, inFlight: false };

  fetchRemoteDoc(watch);
  const pollId = setInterval(() => fetchRemoteDoc(watch), 20_000);

  return () => {
    watch.cancelled = true;
    clearInterval(pollId);
  };
}

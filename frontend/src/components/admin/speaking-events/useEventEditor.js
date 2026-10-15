/**
 * The one override editor the Upcoming, Past and Sources tabs share (#573):
 * which row is open, its form, and the save and delete writes. Held by the
 * page, so a form opened on one tab is still open on the next.
 *
 * Race-safety, as #555 hardened the Newsletter Hub's writes: an in-flight ref
 * on save (a double click sends one upsert) and one per document on delete (a
 * double click sends one delete). The ref is checked before any await, which a
 * disabled button alone cannot promise — React re-renders after the click.
 *
 * CONFIRMATIONS ARE STATE, NOT A BROWSER DIALOG (ADR 0033 §2). A delete asks
 * first through `pendingDelete`, and closing or opening another row while the
 * form has unsaved edits asks through `pendingDiscard`; the page renders both
 * with ConfirmModal. Before this a click on another row's Enrich silently
 * threw away whatever was typed in the open form.
 *
 * After a write the stored overrides are re-read through their generation
 * guard; `stored.refresh` never throws, so the write's own outcome is what
 * this hook reports.
 *
 * The two writes are module-level functions over the hook's context, the
 * shape useCertifications uses: the hook holds state, the functions hold the
 * exits, and the hook stays inside Qlty's return-count budget.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { postJSON } from '@/lib/api';
import {
  EMPTY_FORM,
  buildSpeakingEventPayload,
  formFromManual,
  formFromSessionize,
} from './eventModel';

export const DELETE_CONFIRM = {
  title: 'Delete this stored event?',
  description:
    'A Sessionize event keeps showing from Sessionize without its custom data; a manual entry is gone for good. The public page changes at the next publish.',
};

export const DISCARD_CONFIRM = {
  title: 'Discard unsaved changes?',
  description: 'The edits in the open form have not been saved and will be lost.',
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Upsert the open form once; the editor closes when the write lands. */
async function saveEvent(ctx) {
  if (ctx.savingRef.current) return;
  ctx.savingRef.current = true;
  const docId =
    ctx.editingId === 'new' ? `event-${ctx.editingEvent?.id || Date.now()}` : ctx.editingId;
  ctx.setSaving(docId);
  ctx.setError('');
  try {
    const data = buildSpeakingEventPayload(ctx.editingEvent, ctx.form);
    await postJSON('upsertSpeakerEvent', { docId, data, merge: true });
    await ctx.stored.refresh();
    ctx.close();
  } catch (err) {
    ctx.setError(`Save failed: ${err?.message}`);
  } finally {
    ctx.savingRef.current = false;
    ctx.setSaving(null);
  }
}

/** Delete one stored document once; the editor closes if it was open on it. */
async function removeEvent(ctx, docId) {
  if (ctx.deletingRef.current.has(docId)) return;
  ctx.deletingRef.current.add(docId);
  ctx.setDeleting(docId);
  ctx.setError('');
  try {
    await postJSON('deleteSpeakerEvent', { docId });
    await ctx.stored.refresh();
    // Read the editor as it is now, not as it was when Delete was clicked.
    if (ctx.editingIdRef.current === docId) ctx.close();
  } catch (err) {
    ctx.setError(`Delete failed: ${err?.message}`);
  } finally {
    ctx.deletingRef.current.delete(docId);
    ctx.setDeleting((current) => (current === docId ? null : current));
  }
}

export default function useEventEditor(stored) {
  // editingId: null=closed, 'new'=new override or manual entry, else a stored docId
  // editingEvent: the Sessionize event row being enriched (null for manual entries)
  const [editingId, setEditingIdState] = useState(null);
  const [editingEvent, setEditingEvent] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [openedForm, setOpenedForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [pendingOpen, setPendingOpen] = useState(null);
  const editingIdRef = useRef(null);
  const savingRef = useRef(false);
  const deletingRef = useRef(new Set());
  const dirtyRef = useRef(false);

  const dirty = useMemo(
    () => editingId !== null && !same(form, openedForm),
    [editingId, form, openedForm]
  );
  // Mirrored into a ref after render so the open/close handlers read the
  // current answer without the ref being written during render.
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  const open = useCallback((id, event, nextForm) => {
    editingIdRef.current = id;
    setEditingIdState(id);
    setEditingEvent(event);
    setForm(nextForm);
    setOpenedForm(nextForm);
  }, []);

  const close = useCallback(() => open(null, null, EMPTY_FORM), [open]);

  /** Open now, or ask first when the open form has unsaved edits. */
  const guardedOpen = (id, event, nextForm) => {
    if (dirtyRef.current) {
      setPendingOpen({ id, event, form: nextForm });
      return;
    }
    open(id, event, nextForm);
  };

  const openEnrich = (sessionizeEvent) =>
    guardedOpen(
      sessionizeEvent._storedDoc ? sessionizeEvent._storedDoc._docId : 'new',
      sessionizeEvent,
      formFromSessionize(sessionizeEvent)
    );
  const openManual = () =>
    guardedOpen('new', null, { ...EMPTY_FORM, _manualName: '', _manualDate: '' });
  const openEditManual = (fd) => guardedOpen(fd._docId, null, formFromManual(fd));

  const requestClose = () => {
    if (dirtyRef.current) setPendingOpen({ id: null, event: null, form: EMPTY_FORM });
    else close();
  };

  const confirmDiscard = () => {
    const next = pendingOpen;
    setPendingOpen(null);
    if (next) open(next.id, next.event, next.form);
  };

  // What the writes read and set: the open form as it is on this render, and
  // the refs that guard a second click.
  const ctx = {
    stored,
    editingId,
    editingEvent,
    form,
    close,
    savingRef,
    deletingRef,
    editingIdRef,
    setSaving,
    setDeleting,
    setError,
  };
  const save = () => saveEvent(ctx);
  const remove = (docId) => removeEvent(ctx, docId);

  const requestRemove = (docId) => {
    if (deletingRef.current.has(docId)) return;
    setPendingDelete(docId);
  };

  const confirmRemove = () => {
    const docId = pendingDelete;
    setPendingDelete(null);
    return docId ? remove(docId) : Promise.resolve();
  };

  const cancelConfirm = () => {
    setPendingDelete(null);
    setPendingOpen(null);
  };

  return {
    editingId,
    editingEvent,
    form,
    setForm,
    dirty,
    isOpen: editingId !== null,
    openEnrich,
    openManual,
    openEditManual,
    close,
    requestClose,
    save,
    remove,
    requestRemove,
    confirmRemove,
    confirmDiscard,
    cancelConfirm,
    pendingDelete,
    pendingDiscard: pendingOpen !== null,
    saving,
    deleting,
    error,
    clearError: () => setError(''),
  };
}

/**
 * The writes the review page makes on the item it shows: save the board's
 * fields, save then approve, and delete a framework. Every one reports its
 * outcome — a toast, an inline message for the board, a real `saving` state
 * for the buttons — and navigates only after a write that landed (ADR 0033
 * §1, bug 7).
 *
 * Split out of ReviewPage (PR #841) so the page is one return over a view
 * table and these can be exercised without the boards.
 */
import { useCallback, useState } from 'react';
import { postJSON } from '@/lib/api';
import { getPublishTargetForType } from '@/lib/contentModel';

export function useReviewActions({ blogId, transitions, navigate, toast }) {
  const [frameworkDeleteOpen, setFrameworkDeleteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [boardError, setBoardError] = useState(null);

  /** Save the board's fields; true when the write landed. */
  const saveFields = useCallback(
    async (formData, noun) => {
      setSaving('save');
      setBoardError(null);
      let landed = false;
      try {
        await postJSON('updateContentItem', { contentId: blogId, updates: formData });
        toast({ title: `${noun} saved` });
        landed = true;
      } catch (err) {
        setBoardError(`Save failed: ${err?.message || 'Unknown error'}`);
        toast({ title: `${noun} not saved`, description: err?.message, variant: 'destructive' });
      } finally {
        setSaving(false);
      }
      return landed;
    },
    [blogId, toast]
  );

  /** Save, then approve; navigate only when both landed. */
  const publishFields = useCallback(
    async (formData, type, noun) => {
      if (!(await saveFields(formData, noun))) return;
      setSaving('publish');
      setBoardError(null);
      try {
        const result = await transitions.approve(blogId, {
          publishTarget: getPublishTargetForType(type),
          reviewNotes: `${noun} review complete and sent to publish stage`,
        });
        if (!result) {
          setBoardError(transitions.errors[blogId] || 'Approve failed.');
          return;
        }
        navigate(`/admin/review-queue?contentType=${type}`);
      } finally {
        setSaving(false);
      }
    },
    [blogId, navigate, saveFields, transitions]
  );

  const doFrameworkDelete = async () => {
    setFrameworkDeleteOpen(false);
    setSaving('delete');
    setBoardError(null);
    try {
      // deleteContentItem writes the audit row itself (`audits`,
      // content_deleted, with the actor the guard verified), so no client
      // row is written beside it (AP-F13, #937).
      await postJSON('deleteContentItem', { contentId: blogId });
      toast({ title: 'Framework deleted' });
      navigate('/admin/review-queue?contentType=framework');
    } catch (err) {
      setBoardError(`Delete failed: ${err?.message || 'Unknown error'}`);
      toast({ title: 'Framework not deleted', description: err?.message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return {
    saving,
    boardError,
    frameworkDeleteOpen,
    setFrameworkDeleteOpen,
    saveFields,
    publishFields,
    doFrameworkDelete,
  };
}

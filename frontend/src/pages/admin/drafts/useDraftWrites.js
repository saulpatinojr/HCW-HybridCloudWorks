/**
 * The Drafts page's writes: Save, Send to In Review, Back to Drafts and
 * Delete. Each carries the etag of the version on screen. A 412 (code
 * CONFLICT: another tab or device saved first) keeps the owner's text and
 * raises the conflict banner; any other refusal is shown as the API worded
 * it. Nothing here retries a write.
 */
import { useCallback, useState } from 'react';
import { postJSON, sendJSON } from '@/lib/api';
import { DRAFTS_ROUTE, deleteRefusalMessage, draftRoute, toPayload } from './draftForm';

const isConflict = (err) => err?.status === 412 || err?.code === 'CONFLICT';

/**
 * @param {{
 *   editor: ReturnType<typeof import('./useOpenDraft').useOpenDraft>,
 *   list: ReturnType<typeof import('./useDraftList').useDraftList>,
 *   toast: (message: object) => void,
 * }} deps
 */
export function useDraftWrites({ editor, list, toast }) {
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const { current, form } = editor;

  const clearErrors = useCallback(() => {
    setActionError(null);
    setConflict(null);
  }, []);

  /** One write; `onDone` receives the API's answer. */
  const runWrite = async (name, write, onDone) => {
    setBusy(name);
    setActionError(null);
    try {
      const result = await write();
      setConflict(null);
      onDone(result);
    } catch (err) {
      if (isConflict(err)) setConflict(err.message);
      else setActionError(err.message || 'Something went wrong; nothing was changed.');
    } finally {
      setBusy(null);
    }
  };

  /** A write that answers `{ draft }`: show it as saved and put it in the list. */
  const showAnswer =
    (message) =>
    ({ draft }) => {
      editor.show(draft);
      list.upsert(draft);
      if (message) toast(message);
    };

  const save = () => {
    const fields = toPayload(form);
    if (!fields.title) {
      setActionError('Give the draft a title before saving it.');
      return;
    }
    const write = current.id
      ? () => sendJSON(draftRoute(current.id), 'PUT', { fields, etag: current.etag })
      : () => postJSON(DRAFTS_ROUTE, { fields });
    runWrite('save', write, showAnswer());
  };

  /**
   * Send the draft to In Review under its ETag; the answer says where it went
   * and that nothing was published.
   */
  const sendToReview = () =>
    runWrite(
      'send',
      () => postJSON(`${draftRoute(current.id)}/send-to-review`, { etag: current.etag }),
      showAnswer({
        title: 'Sent to In Review',
        description: 'It is on the Review Queue under In Review. Nothing was published.',
      })
    );

  /** From the editor or from a list row, which carries its own etag. */
  const backToDrafts = (target) =>
    runWrite(
      'back',
      () => postJSON(`${draftRoute(target.id)}/back-to-drafts`, { etag: target.etag }),
      showAnswer({ title: 'Back in Drafts', description: 'It is editable here again.' })
    );

  /** Delete asks first; a live or past-review article is refused here, as the API would. */
  const askDelete = () => {
    const refusal = deleteRefusalMessage(current);
    if (refusal) setActionError(refusal);
    else setConfirmingDelete(true);
  };

  const confirmDelete = () => {
    setConfirmingDelete(false);
    const { id, etag } = current;
    // Never saved: nothing on the server to delete.
    if (!id) {
      editor.close();
      return;
    }
    runWrite(
      'delete',
      () => sendJSON(draftRoute(id), 'DELETE', { etag }),
      ({ stage }) => {
        list.remove(id);
        editor.close();
        toast({
          title: 'Deleted',
          description:
            stage === 'in_review'
              ? 'The draft and its In Review item are gone.'
              : 'The draft is gone.',
        });
      }
    );
  };

  return {
    busy,
    actionError,
    conflict,
    confirmingDelete,
    clearErrors,
    save,
    sendToReview,
    backToDrafts,
    askDelete,
    confirmDelete,
    cancelDelete: () => setConfirmingDelete(false),
  };
}

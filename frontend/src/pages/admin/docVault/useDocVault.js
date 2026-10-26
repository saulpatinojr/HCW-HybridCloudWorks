/**
 * The Doc Vault page's data: the list (loaded once auth is ready, again on
 * Refresh and after a write), the open document with its earlier versions,
 * and the writes. Every write that changes an existing document carries the
 * etag of the version on screen; the API answers 412 (code CONFLICT) when
 * another tab or device saved first, and the page keeps the owner's text and
 * offers a reload. Nothing here retries a write, and nothing here keeps a
 * document's text anywhere but in state.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { getJSON, postJSON, sendJSON } from '@/lib/api';
import {
  DOC_VAULT_ROUTE,
  docRoute,
  restoreVersionRoute,
  trashListRoute,
  untrashRoute,
  versionRoute,
} from './docVaultModel';

/** What the toast says for each way a save can end. */
const SAVED = {
  created: { title: 'Added to the vault', description: 'It is saved here and nowhere else.' },
  versioned: {
    title: 'Saved as a new version',
    description: 'The earlier text is kept in History.',
  },
  unchanged: { title: 'Nothing to save', description: 'The text is the same as the saved one.' },
  restored: { title: 'Brought back from Trash', description: 'It is in the vault again.' },
};

const NO_LIST = Object.freeze({ documents: [], counts: {}, tags: [], total: 0, truncated: false });

const isConflict = (error) => error?.status === 412 || error?.code === 'CONFLICT';
const isNotProvisioned = (error) => error?.code === 'NOT_PROVISIONED';
const sentence = (error) => error?.message || 'Something went wrong; nothing was changed.';

/**
 * @param {{ authReady: boolean, toast: (message: object) => void }} deps
 */
export function useDocVault({ authReady, toast }) {
  const [view, setViewName] = useState('active');
  const [list, setList] = useState(NO_LIST);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [notProvisioned, setNotProvisioned] = useState(false);

  const [current, setCurrent] = useState(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(null);
  const [preview, setPreview] = useState(null);

  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [conflict, setConflict] = useState(null);

  // The newest open and list requests win: a slow answer for a document or
  // view the owner has since left must not replace the one on screen.
  const openToken = useRef(0);
  const listToken = useRef(0);

  const loadList = useCallback(async (which) => {
    const token = (listToken.current += 1);
    try {
      const answer = await getJSON(which === 'trash' ? trashListRoute : DOC_VAULT_ROUTE);
      if (token !== listToken.current) return;
      setList({
        documents: Array.isArray(answer?.documents) ? answer.documents : [],
        counts: answer?.counts ?? {},
        tags: Array.isArray(answer?.tags) ? answer.tags : [],
        total: Number(answer?.total) || 0,
        truncated: Boolean(answer?.truncated),
      });
      setListError(null);
      setNotProvisioned(false);
    } catch (error) {
      if (token !== listToken.current) return;
      if (isNotProvisioned(error)) setNotProvisioned(true);
      else setListError(sentence(error));
    } finally {
      if (token === listToken.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authReady) return;
    // Started from an async function, as useDraftList does: the list's own
    // setState calls come after the request, not in the effect's body.
    (async () => {
      await loadList(view);
    })();
  }, [authReady, view, loadList]);

  const reload = useCallback(() => {
    setLoading(true);
    return loadList(view);
  }, [loadList, view]);

  const clearErrors = useCallback(() => {
    setActionError(null);
    setConflict(null);
    setOpenError(null);
  }, []);

  /** Open a document with its earlier versions. Resolves to the document, or null if it did not open. */
  const open = useCallback(async (id) => {
    const token = (openToken.current += 1);
    setOpening(true);
    setOpenError(null);
    setPreview(null);
    try {
      const answer = await getJSON(docRoute(id));
      if (token !== openToken.current) return null;
      setCurrent({ document: answer.document, versions: answer.versions ?? [] });
      return answer.document;
    } catch (error) {
      if (token === openToken.current) {
        setCurrent(null);
        setOpenError(sentence(error));
      }
      return null;
    } finally {
      if (token === openToken.current) setOpening(false);
    }
  }, []);

  const close = useCallback(() => {
    openToken.current += 1;
    setCurrent(null);
    setPreview(null);
    setOpening(false);
    setOpenError(null);
  }, []);

  const setView = useCallback(
    (next) => {
      if (next === view) return;
      close();
      clearErrors();
      setLoading(true);
      setViewName(next);
    },
    [view, close, clearErrors]
  );

  /** Look at an earlier version (with its text) without changing anything. */
  const viewVersion = useCallback(
    async (version) => {
      if (!current) return;
      setActionError(null);
      try {
        const answer = await getJSON(versionRoute(current.document.id, version));
        setPreview(answer.version);
      } catch (error) {
        setActionError(sentence(error));
      }
    },
    [current]
  );

  const closePreview = useCallback(() => setPreview(null), []);

  /**
   * One write. `onDone` gets the API's answer and returns what the write
   * resolves to; a refusal is shown, never retried, and resolves to null.
   */
  const runWrite = useCallback(async (name, write, onDone) => {
    setBusy(name);
    setActionError(null);
    try {
      const answer = await write();
      setConflict(null);
      return await onDone(answer);
    } catch (error) {
      if (isConflict(error)) setConflict(sentence(error));
      else if (isNotProvisioned(error)) setNotProvisioned(true);
      else setActionError(sentence(error));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  /** After a write that changed the open document: show it, with its versions, and refresh the list. */
  const showSaved = useCallback(
    async (answer, message) => {
      await open(answer.document.id);
      loadList(view);
      if (message) toast(message);
      return answer;
    },
    [open, loadList, view, toast]
  );

  /** A document pasted into the form: new, or the next version of the one with this title. */
  const create = (fields) =>
    runWrite(
      'save',
      () => postJSON(DOC_VAULT_ROUTE, { fields }),
      (answer) => showSaved(answer, SAVED[answer.outcome])
    );

  /** An edit of the open document. */
  const update = (fields) =>
    runWrite(
      'save',
      () => sendJSON(docRoute(current.document.id), 'PUT', { fields, etag: current.document.etag }),
      (answer) => showSaved(answer, SAVED[answer.outcome])
    );

  /** Make an earlier version the newest. */
  const restoreVersion = (version) =>
    runWrite(
      'restore',
      () =>
        postJSON(restoreVersionRoute(current.document.id), {
          version,
          etag: current.document.etag,
        }),
      (answer) =>
        showSaved(answer, {
          title: `Version ${version} is the newest again`,
          description: 'The text it replaced is kept in History.',
        })
    );

  /** Move the open document to Trash. */
  const moveToTrash = () =>
    runWrite(
      'trash',
      () => sendJSON(docRoute(current.document.id), 'DELETE', { etag: current.document.etag }),
      () => {
        close();
        loadList(view);
        toast({ title: 'Moved to Trash', description: `You can put it back for 30 days.` });
        return true;
      }
    );

  /** Take the open document out of Trash. */
  const putBack = () =>
    runWrite(
      'untrash',
      () => postJSON(untrashRoute(current.document.id), { etag: current.document.etag }),
      (answer) => {
        close();
        loadList(view);
        toast({ title: 'Put back', description: 'It is in the vault again, with its history.' });
        return answer;
      }
    );

  /** Remove the open document, which is in Trash, for good. */
  const deleteForever = () =>
    runWrite(
      'forever',
      () =>
        sendJSON(docRoute(current.document.id), 'DELETE', {
          etag: current.document.etag,
          permanent: true,
        }),
      () => {
        close();
        loadList(view);
        toast({
          title: 'Deleted for good',
          description:
            'The document and its history are gone from the vault. Backup copies are kept for up to 35 days, then deleted automatically.',
        });
        return true;
      }
    );

  return {
    view,
    setView,
    list,
    loading,
    listError,
    notProvisioned,
    reload,
    current,
    opening,
    openError,
    open,
    close,
    preview,
    viewVersion,
    closePreview,
    busy,
    actionError,
    conflict,
    clearErrors,
    create,
    update,
    restoreVersion,
    moveToTrash,
    putBack,
    deleteForever,
  };
}

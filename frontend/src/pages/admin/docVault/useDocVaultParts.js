/**
 * The parts useDocVault is built from: the list, the open document, and the
 * writes. Each was written inline in useDocVault.js until it grew too long
 * to follow; the rules in that file's header (etags on every write, a 412
 * kept as a conflict, nothing retried) are kept here unchanged.
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

export const NO_LIST = Object.freeze({
  documents: [],
  counts: {},
  tags: [],
  total: 0,
  truncated: false,
});

const isConflict = (error) => error?.status === 412 || error?.code === 'CONFLICT';
const isNotProvisioned = (error) => error?.code === 'NOT_PROVISIONED';
const sentence = (error) => error?.message || 'Something went wrong; nothing was changed.';

/** The list as the page holds it, from the API's answer. */
const listFromAnswer = (answer) => ({
  documents: Array.isArray(answer?.documents) ? answer.documents : [],
  counts: answer?.counts ?? {},
  tags: Array.isArray(answer?.tags) ? answer.tags : [],
  total: Number(answer?.total) || 0,
  truncated: Boolean(answer?.truncated),
});

/** The documents of a view, loaded once auth is ready and again on demand. */
export function useVaultList(authReady, view) {
  const [list, setList] = useState(NO_LIST);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(null);
  const [notProvisioned, setNotProvisioned] = useState(false);
  // The newest list request wins: a slow answer for a view the owner has
  // since left must not replace the one on screen.
  const listToken = useRef(0);

  const loadList = useCallback(async (which) => {
    const token = (listToken.current += 1);
    const latest = () => token === listToken.current;
    try {
      const answer = await getJSON(which === 'trash' ? trashListRoute : DOC_VAULT_ROUTE);
      if (!latest()) return;
      setList(listFromAnswer(answer));
      setListError(null);
      setNotProvisioned(false);
    } catch (error) {
      if (!latest()) return;
      if (isNotProvisioned(error)) setNotProvisioned(true);
      else setListError(sentence(error));
    } finally {
      if (latest()) setLoading(false);
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

  return {
    list,
    loading,
    setLoading,
    listError,
    notProvisioned,
    setNotProvisioned,
    loadList,
    reload,
  };
}

/** The open document, its earlier versions, and an earlier version being looked at. */
export function useOpenDocument() {
  const [current, setCurrent] = useState(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState(null);
  const [preview, setPreview] = useState(null);
  // The newest open request wins, as the list's does.
  const openToken = useRef(0);

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

  const closePreview = useCallback(() => setPreview(null), []);

  return {
    current,
    opening,
    openError,
    setOpenError,
    preview,
    setPreview,
    open,
    close,
    closePreview,
  };
}

/**
 * The writes on the open document (and the new one from the form), with the
 * busy name, the last refusal and any conflict. `listPart` and `docPart` are
 * what the two hooks above return; `view` and `toast` are the page's.
 */
export function useVaultWrites({ listPart, docPart, view, toast }) {
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [conflict, setConflict] = useState(null);
  const { current, open, close, setPreview } = docPart;
  const { loadList, setNotProvisioned } = listPart;

  /** Look at an earlier version (with its text) without changing anything. */
  const viewVersion = useCallback(
    async (version) => {
      if (current) {
        setActionError(null);
        try {
          const answer = await getJSON(versionRoute(current.document.id, version));
          setPreview(answer.version);
        } catch (error) {
          setActionError(sentence(error));
        }
      }
    },
    [current, setPreview]
  );

  /**
   * One write. `onDone` gets the API's answer and returns what the write
   * resolves to; a refusal is shown, never retried, and resolves to null.
   */
  const runWrite = useCallback(
    async (name, write, onDone) => {
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
    },
    [setNotProvisioned]
  );

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

  /** After a write that took the open document out of this view: close it, refresh, and say so. */
  const showRemoved = (message, value) => {
    close();
    loadList(view);
    toast(message);
    return value;
  };

  const target = () => docRoute(current.document.id);
  const etag = () => current.document.etag;

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
      () => sendJSON(target(), 'PUT', { fields, etag: etag() }),
      (answer) => showSaved(answer, SAVED[answer.outcome])
    );

  /** Make an earlier version the newest. */
  const restoreVersion = (version) =>
    runWrite(
      'restore',
      () => postJSON(restoreVersionRoute(current.document.id), { version, etag: etag() }),
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
      () => sendJSON(target(), 'DELETE', { etag: etag() }),
      () =>
        showRemoved(
          { title: 'Moved to Trash', description: `You can put it back for 30 days.` },
          true
        )
    );

  /** Take the open document out of Trash. */
  const putBack = () =>
    runWrite(
      'untrash',
      () => postJSON(untrashRoute(current.document.id), { etag: etag() }),
      (answer) =>
        showRemoved(
          { title: 'Put back', description: 'It is in the vault again, with its history.' },
          answer
        )
    );

  /** Remove the open document, which is in Trash, for good. */
  const deleteForever = () =>
    runWrite(
      'forever',
      () => sendJSON(target(), 'DELETE', { etag: etag(), permanent: true }),
      () =>
        showRemoved(
          {
            title: 'Deleted for good',
            description:
              'The document and its history are gone from the vault. Backup copies are kept for up to 35 days, then deleted automatically.',
          },
          true
        )
    );

  const clearWriteErrors = useCallback(() => {
    setActionError(null);
    setConflict(null);
  }, []);

  return {
    busy,
    actionError,
    conflict,
    clearWriteErrors,
    viewVersion,
    create,
    update,
    restoreVersion,
    moveToTrash,
    putBack,
    deleteForever,
  };
}

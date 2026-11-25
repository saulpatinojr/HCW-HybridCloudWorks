/**
 * The Doc Vault page's data: the list (loaded once auth is ready, again on
 * Refresh and after a write), the open document with its earlier versions,
 * and the writes. Every write that changes an existing document carries the
 * etag of the version on screen; the API answers 412 (code CONFLICT) when
 * another tab or device saved first, and the page keeps the owner's text and
 * offers a reload. Nothing here retries a write, and nothing here keeps a
 * document's text anywhere but in state.
 */
import { useCallback, useState } from 'react';
import { useOpenDocument, useVaultList, useVaultWrites } from './useDocVaultParts';

/**
 * @param {{ authReady: boolean, toast: (message: object) => void }} deps
 */
export function useDocVault({ authReady, toast }) {
  const [view, setViewName] = useState('active');
  const listPart = useVaultList(authReady, view);
  const docPart = useOpenDocument();
  const writes = useVaultWrites({ listPart, docPart, view, toast });
  const { close, setOpenError } = docPart;
  const { setLoading } = listPart;
  const { clearWriteErrors } = writes;

  const clearErrors = useCallback(() => {
    clearWriteErrors();
    setOpenError(null);
  }, [clearWriteErrors, setOpenError]);

  const setView = useCallback(
    (next) => {
      if (next === view) return;
      close();
      clearErrors();
      setLoading(true);
      setViewName(next);
    },
    [view, close, clearErrors, setLoading]
  );

  return {
    view,
    setView,
    list: listPart.list,
    loading: listPart.loading,
    listError: listPart.listError,
    notProvisioned: listPart.notProvisioned,
    reload: listPart.reload,
    current: docPart.current,
    opening: docPart.opening,
    openError: docPart.openError,
    open: docPart.open,
    close,
    preview: docPart.preview,
    viewVersion: writes.viewVersion,
    closePreview: docPart.closePreview,
    busy: writes.busy,
    actionError: writes.actionError,
    conflict: writes.conflict,
    clearErrors,
    create: writes.create,
    update: writes.update,
    restoreVersion: writes.restoreVersion,
    moveToTrash: writes.moveToTrash,
    putBack: writes.putBack,
    deleteForever: writes.deleteForever,
  };
}

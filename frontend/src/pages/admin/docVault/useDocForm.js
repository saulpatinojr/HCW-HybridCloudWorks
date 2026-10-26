/**
 * The paste / edit form's state: which form is open (none, a new document or
 * an edit of the open one), what is typed, and whether that differs from where
 * it started. The text lives only here until it is saved; nothing is kept in
 * the browser's storage, so a private letter is never left behind on the
 * machine by a form that was closed.
 */
import { useCallback, useState } from 'react';
import { emptyForm, formFromDocument, formProblem, isDirty } from './docVaultModel';

export function useDocForm() {
  const [mode, setMode] = useState(null);
  const [form, setForm] = useState(emptyForm());
  const [original, setOriginal] = useState(emptyForm());

  const begin = useCallback((nextMode, start) => {
    setForm(start);
    setOriginal(start);
    setMode(nextMode);
  }, []);

  /** A blank form for a document to paste; `category` is the filter in force, if any. */
  const startNew = useCallback(
    (category) => begin('paste', emptyForm(category || undefined)),
    [begin]
  );

  /** The open document's own fields, to edit. */
  const startEdit = useCallback((doc) => begin('edit', formFromDocument(doc)), [begin]);

  const change = useCallback(
    (field, value) => setForm((previous) => ({ ...previous, [field]: value })),
    []
  );

  const cancel = useCallback(() => setMode(null), []);

  return {
    mode,
    form,
    dirty: mode !== null && isDirty(form, original),
    problem: mode === null ? null : formProblem(form),
    startNew,
    startEdit,
    change,
    cancel,
  };
}

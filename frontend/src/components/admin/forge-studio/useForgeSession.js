/**
 * One Forge Studio session (ADR 0033 §7 slice 2): the brief, the content
 * document it becomes, the forge job that writes the first draft, the AI
 * actions over the draft text, and the saves. Held at page level so the
 * four workspace tabs read and write the same state; `?contentId=` on the
 * URL names the document so a reload comes back to it.
 *
 * Three modules behind this hook, each pure enough to test alone:
 *   forgeSessionReducer.js   the state and every transition over it
 *   forgeJobs.js             the server calls, one route or one job each
 *   forgeSessionActions.js   the operations, sequencing the two above
 *
 * The hook wires them: a reducer for the state, a `ctx` the operations read
 * the session through, and one stable callback per operation.
 */
import { useCallback, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import * as ops from './forgeSessionActions';
import { forgeSessionReducer, initialState, isDirty } from './forgeSessionReducer';

export { FORGE_JOB_MAX_WAIT_MS, describeJob } from './forgeJobs';
export { textOf } from './forgeSessionReducer';

/**
 * @param {object} options
 * @param {string} [options.initialContentId] from `?contentId=`
 * @param {(id: string) => void} [options.onContentId] mirror the id to the URL
 */
export function useForgeSession({ initialContentId = '', onContentId } = {}) {
  const [state, dispatch] = useReducer(forgeSessionReducer, initialContentId, initialState);

  // The operations read the session as it stands through refs, so each
  // callback below is created once rather than on every keystroke. The refs
  // move in a layout effect, inside the commit that renders the state: a
  // passive effect runs after paint, and a document that arrived from a read
  // was on screen while `ctx.get()` still held the session without it, so a
  // click in that gap sent nothing (#1072). This page is never pre-rendered,
  // so the server-render warning a layout effect carries does not arise.
  const stateRef = useRef(state);
  const onContentIdRef = useRef(onContentId);
  useLayoutEffect(() => {
    stateRef.current = state;
    onContentIdRef.current = onContentId;
  });

  const ctx = useMemo(
    () => ({
      dispatch,
      get: () => stateRef.current,
      onContentId: (id) => onContentIdRef.current?.(id),
    }),
    []
  );

  const start = useCallback((mode, extras) => ops.start(ctx, mode, extras), [ctx]);
  const setTitle = useCallback((title) => dispatch({ type: 'setTitle', title }), []);
  const setBrief = useCallback((field, value) => dispatch({ type: 'setBrief', field, value }), []);
  const setBriefFields = useCallback((fields) => dispatch({ type: 'setBriefFields', fields }), []);
  const setText = useCallback((field, value) => dispatch({ type: 'setText', field, value }), []);
  const clearMessages = useCallback(() => dispatch({ type: 'clearMessages' }), []);
  const loadDoc = useCallback((contentId) => ops.loadDoc(ctx, contentId), [ctx]);
  const saveAsDraft = useCallback((options) => ops.saveAsDraft(ctx, options), [ctx]);
  const generate = useCallback((options) => ops.generate(ctx, options), [ctx]);
  const assist = useCallback((action, input) => ops.assist(ctx, action, input), [ctx]);
  const clearAssist = useCallback(() => dispatch({ type: 'clearAssist' }), []);
  const save = useCallback(() => ops.save(ctx), [ctx]);
  const sendToReview = useCallback(() => ops.sendToReview(ctx), [ctx]);
  const reset = useCallback(() => ops.reset(ctx), [ctx]);

  return {
    ...state,
    dirty: isDirty(state),
    start,
    setTitle,
    setBrief,
    setBriefFields,
    setText,
    clearMessages,
    loadDoc,
    saveAsDraft,
    generate,
    assist,
    clearAssist,
    save,
    sendToReview,
    reset,
  };
}

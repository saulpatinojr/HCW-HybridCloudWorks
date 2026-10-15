/**
 * Warn before leaving the Drafts page with unsaved changes.
 *
 * Two exits, two guards:
 *   - Closing the tab, reloading, or typing another address: `beforeunload`,
 *     which shows the browser's own prompt. The browser owns that one; no
 *     modal can stand in for it.
 *   - Following a link inside the app (the admin sidebar, a "Review" link):
 *     the app is mounted under `BrowserRouter`, not a data router, so
 *     react-router's `useBlocker` is unavailable. A capture-phase click
 *     listener on the document runs before React's own listeners on the root
 *     element, so cancelling there stops the router from ever seeing the
 *     click. Only plain left clicks on same-origin links are asked about; a
 *     new-tab click leaves this tab, and its edits, where they are.
 *
 * THE QUESTION IS STATE, NOT A BROWSER DIALOG (ADR 0033 §2; AP-F12, #936).
 * The cancelled click's link is kept as the pending leave, the page renders
 * ConfirmModal with LEAVE_CONFIRM, and `confirmLeave` replays the click with
 * the guard stood down for it — so the link does everything it would have:
 * the router follows it and the phone drawer's own handler closes the
 * drawer. The browser's confirm blocked the thread, was read by a screen
 * reader as nothing to do with the page, and on a phone opened as a system
 * sheet over a drawer the tap had been meant to close.
 *
 * Switching drafts inside the page is the page's own confirm, not this.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

export const UNSAVED_MESSAGE = 'This draft has unsaved changes. Leave without saving them?';

/** What the page's ConfirmModal shows for a pending leave. */
export const LEAVE_CONFIRM = {
  title: 'Leave this draft?',
  description: UNSAVED_MESSAGE,
  confirmLabel: 'Leave without saving',
};

/** A plain left click: no modifier asking for a new tab or window. */
const NEW_TAB_MODIFIERS = ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'];

function isPlainLeftClick(event) {
  if (event.defaultPrevented || event.button !== 0) return false;
  return !NEW_TAB_MODIFIERS.some((key) => event[key]);
}

/** The link the click is on, when it opens in this tab; else null. */
function sameTabLink(event) {
  const anchor = event.target?.closest?.('a[href]');
  const sameTab = anchor && (!anchor.target || anchor.target === '_self');
  return sameTab && !anchor.hasAttribute('download') ? anchor : null;
}

/** Does following this link leave the page for another route of this app? */
function leavesThisPage(anchor) {
  const here = window.location;
  let url;
  try {
    url = new URL(anchor.href, here.href);
  } catch {
    return false;
  }
  return (
    url.origin === here.origin && (url.pathname !== here.pathname || url.search !== here.search)
  );
}

/** The link a click would follow to another route of this app, or null. */
export function inAppNavigationTarget(event) {
  if (!isPlainLeftClick(event)) return null;
  const anchor = sameTabLink(event);
  return anchor && leavesThisPage(anchor) ? anchor : null;
}

export function isInAppNavigation(event) {
  return inAppNavigationTarget(event) !== null;
}

/** The route of a same-origin link as the router takes it: path, query, hash. */
function routeOf(anchor) {
  const url = new URL(anchor.href, window.location.href);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * @param {boolean} dirty
 * @returns {{ leaving: boolean, confirmLeave: () => void, cancelLeave: () => void }}
 *   `leaving` while a cancelled click waits on the owner's answer.
 */
export function useUnsavedGuard(dirty) {
  const navigate = useNavigate();
  // The cancelled click, while the owner is asked: the route it was going to
  // and its link, so the click can be replayed on confirm.
  const [pending, setPending] = useState(null);
  // Set for the one replayed click, so the guard lets it through.
  const standDownRef = useRef(false);

  // A draft saved while the question is open has nothing left to lose: the
  // question is withdrawn, and must not come back with the next keystroke
  // that makes the draft dirty again. Adjusted during render from the
  // previous value, as React documents, rather than in an effect that would
  // paint the stale question first.
  const [wasDirty, setWasDirty] = useState(dirty);
  if (wasDirty !== dirty) {
    setWasDirty(dirty);
    if (!dirty) setPending(null);
  }

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event) => {
      event.preventDefault();
      // Required by some browsers for the prompt to appear at all.
      event.returnValue = UNSAVED_MESSAGE;
      return UNSAVED_MESSAGE;
    };
    const onClick = (event) => {
      if (standDownRef.current) return;
      const anchor = inAppNavigationTarget(event);
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      setPending({ to: routeOf(anchor), anchor });
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  const cancelLeave = useCallback(() => setPending(null), []);

  const confirmLeave = useCallback(() => {
    if (!pending) return;
    setPending(null);
    if (pending.anchor.isConnected) {
      // Replay the click the guard cancelled, this once let through. The
      // dispatch is synchronous, so the guard is back up before this returns.
      standDownRef.current = true;
      try {
        pending.anchor.click();
      } finally {
        standDownRef.current = false;
      }
    } else {
      // The link is gone (its list re-rendered); the router takes the route.
      navigate(pending.to);
    }
  }, [navigate, pending]);

  return { leaving: pending !== null, confirmLeave, cancelLeave };
}

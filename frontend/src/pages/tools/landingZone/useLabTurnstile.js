/**
 * The Cloudflare Turnstile widget on the builder's pane, for "Validate on
 * the lab" (ADR 0032 decision 6, revised 2026-09-28). The server takes a
 * public job only with a token this widget issued for the `lab-validate`
 * action on the site (functions/src/lib/labs/public-lock.js).
 *
 * ONLY WHILE THE LAB IS OPEN. `active` is the caller's "the server said open
 * and this build has a site key"; until it is true nothing loads, so a closed
 * lab, and every other page, never contacts Cloudflare. When it turns false
 * (a refusal shut the door, or the control unmounted) the widget is removed.
 *
 * MANAGED MODE, SEEN ONLY WHEN NEEDED. The widget's mode is the dashboard's
 * (Managed); `appearance: 'interaction-only'` keeps it invisible unless
 * Cloudflare wants the visitor to act, when it appears in the container below
 * the button and the line beside the button says so.
 *
 * ONE TOKEN PER SUBMISSION. A token is single use and lives five minutes.
 * Cloudflare refreshes an expired one by itself (`refresh-expired` defaults
 * to `auto`), `take()` hands the current one over exactly once, and `renew()`
 * asks for a fresh one after the submission answered, whatever it answered,
 * because the server spent the old one at siteverify.
 *
 * `phase` is what the line reads: `idle` (not active), `loading` (the script
 * is loading or the check is running), `interactive` (Cloudflare wants the
 * visitor), `ready` (a token is held), `spent` (handed to a submission), or
 * `error` (the script or the check failed; Cloudflare retries by itself).
 * `containerRef` goes on the element the widget draws into, which the caller
 * renders whenever `active` is true.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { LAB_TURNSTILE_ACTION } from '@/lib/turnstile';

/** The render options: the site key, the fixed action, and a callback per phase. */
const widgetOptions = (siteKey, set, action = LAB_TURNSTILE_ACTION) => ({
  sitekey: siteKey,
  action,
  appearance: 'interaction-only',
  'response-field': false,
  callback: (token) => set('ready', token),
  'expired-callback': () => set('loading'),
  'before-interactive-callback': () => set('interactive'),
  'timeout-callback': () => set('interactive'),
  'error-callback': () => set('error'),
});

/**
 * Load Cloudflare's script and draw the widget into the container; the
 * returned function removes it. `held` is the hook's widget record (the API,
 * the widget id, the current token), shared with `takeToken` and
 * `renewWidget` below. Nothing is written once the cleanup has run.
 */
function mountWidget({
  held,
  siteKey,
  load,
  containerRef,
  setPhase,
  action = LAB_TURNSTILE_ACTION,
}) {
  let live = true;
  const set = (next, token = null) => {
    if (live) {
      held.token = token;
      setPhase(next);
    }
  };
  load().then(
    (api) => {
      if (live && containerRef.current) {
        held.api = api;
        held.id = api.render(containerRef.current, widgetOptions(siteKey, set, action));
      }
    },
    () => set('error')
  );
  return () => {
    live = false;
    if (held.api && held.id) held.api.remove(held.id);
    held.api = null;
    held.id = null;
    held.token = null;
    // A later activation starts from "checking", not from this one's end.
    setPhase('loading');
  };
}

/** The token, handed over once; null when none is held. */
function takeToken(held, setPhase) {
  const { token } = held;
  held.token = null;
  if (token) setPhase('spent');
  return token;
}

/** A fresh check, after a submission answered. A no-op once the widget is gone. */
function renewWidget(held, setPhase) {
  if (held.api && held.id) {
    held.token = null;
    setPhase('loading');
    held.api.reset(held.id);
  }
}

/**
 * @param {object} args
 * @param {boolean} args.active  the lab is open and this build has a site key
 * @param {string} args.siteKey
 * @param {() => Promise<object>} args.load  resolves to Cloudflare's `turnstile` API
 */
export function useLabTurnstile({ active, siteKey, load, action = LAB_TURNSTILE_ACTION }) {
  const containerRef = useRef(null);
  const widget = useRef({ api: null, id: null, token: null });
  // Only callbacks write this; while the widget is off, `idle` is derived
  // below rather than set, so the effect never sets state synchronously.
  const [phase, setPhase] = useState('loading');
  const on = Boolean(active && siteKey);

  useEffect(
    () =>
      on
        ? mountWidget({ held: widget.current, siteKey, load, containerRef, setPhase, action })
        : undefined,
    [on, siteKey, load, action]
  );

  const take = useCallback(() => takeToken(widget.current, setPhase), []);
  const renew = useCallback(() => renewWidget(widget.current, setPhase), []);

  return { containerRef, phase: on ? phase : 'idle', take, renew };
}

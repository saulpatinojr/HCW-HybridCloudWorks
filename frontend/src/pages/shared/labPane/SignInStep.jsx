/**
 * The lab page's sign-in step: sign in with the organization's accounts, or,
 * when the server allows it, start a short visitor workspace in this browser.
 * Split out of LabPanePage.jsx when that file grew too long.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import LabPreflightCard from '@/components/labs/LabPreflightCard';
import { markSignedIn } from '@/components/labs/labSignIn';
import { fetchVisitorSessionStatus, startVisitorSession } from '@/lib/publicApi';
import { loadTurnstile, turnstileSiteKey, VISITOR_TURNSTILE_ACTION } from '@/lib/turnstile';
import { useLabTurnstile } from '@/pages/tools/landingZone/useLabTurnstile';
import {
  DEFAULT_TURNSTILE,
  MUTED,
  PRIMARY,
  SECONDARY,
  SIGN_IN_HEADING,
  SIGN_IN_PENDING_SENTENCE,
  VISITOR_CAPACITY_FULL_REASON,
  VISITOR_START_BUTTON,
  VISITOR_START_REREAD_MS,
} from './labPaneWords';

/** "I've already signed in": record it, which shows the pane. No argument, so the click event is not taken for a time. */
const alreadySignedIn = () => markSignedIn();

/** The guest box: start a visitor workspace, or why one cannot start now. */
function VisitorAccess({ status, containerRef, checkReady, starting, error, onStart }) {
  return (
    <div className="flex flex-col gap-2 p-4 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
      <h3 className="text-sm font-semibold text-slate-950 dark:text-white">
        Guest / Visitor Access
      </h3>
      <p className={`text-xs ${MUTED}`}>
        Outside the organization? Start an ephemeral 60-minute workspace right in this browser pane.
      </p>
      {status.open ? (
        <div className="flex flex-col gap-2 mt-1">
          <div ref={containerRef} data-testid="visitor-check-container" />
          <button
            type="button"
            onClick={onStart}
            disabled={starting || !checkReady}
            data-testid="start-visitor-session-button"
            className={`${PRIMARY} self-start`}
          >
            {starting ? 'Starting session…' : VISITOR_START_BUTTON}
          </button>
        </div>
      ) : (
        <p
          className="text-xs text-amber-700 dark:text-amber-400"
          data-testid="visitor-session-closed-notice"
        >
          {status.reason || VISITOR_CAPACITY_FULL_REASON}
        </p>
      )}
      {error ? (
        <p className="text-xs text-rose-600 dark:text-rose-400" data-testid="visitor-session-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default function SignInStep({
  lab,
  signInHref,
  backTo,
  pending,
  onStart,
  onVisitorSessionStarted,
  turnstile = DEFAULT_TURNSTILE,
}) {
  const [visitorStatus, setVisitorStatus] = useState(null);
  const [visitorStarting, setVisitorStarting] = useState(false);
  const [visitorError, setVisitorError] = useState(null);
  // The server's sentence when a status read is refused for too many requests (429). The last
  // status the pane read is kept, so the guest box does not vanish (#1464).
  const [visitorNotice, setVisitorNotice] = useState(null);
  const mounted = useRef(true);
  const rereadTimer = useRef(null);

  const readVisitorStatus = useCallback(
    () =>
      fetchVisitorSessionStatus()
        .then((st) => {
          if (!mounted.current || !st) return;
          setVisitorNotice(null);
          setVisitorStatus(st);
          if (st.session) {
            onVisitorSessionStarted?.(st.session);
          }
        })
        .catch((err) => {
          if (mounted.current && err?.status === 429 && err.message) setVisitorNotice(err.message);
        }),
    [onVisitorSessionStarted]
  );

  useEffect(() => {
    mounted.current = true;
    readVisitorStatus();
    return () => {
      mounted.current = false;
      clearTimeout(rereadTimer.current);
    };
  }, [readVisitorStatus]);

  const turnstileActive = Boolean(visitorStatus?.configured && visitorStatus?.open);
  const {
    containerRef,
    phase: turnstilePhase,
    take: takeTurnstileToken,
    renew: renewTurnstile,
  } = useLabTurnstile({
    active: turnstileActive,
    siteKey: turnstile?.siteKey ?? turnstileSiteKey(),
    load: turnstile?.load ?? loadTurnstile,
    action: VISITOR_TURNSTILE_ACTION,
  });

  const handleStartVisitor = async () => {
    setVisitorStarting(true);
    setVisitorError(null);
    try {
      const turnstileToken = takeTurnstileToken();
      if (!turnstileToken) {
        setVisitorError('Please complete the verification check.');
        setVisitorStarting(false);
        return;
      }
      const res = await startVisitorSession({ labId: lab.id, turnstileToken });
      onVisitorSessionStarted?.({
        id: res.sessionId,
        labId: res.labId,
        accessUrl: res.accessUrl,
        expiresAt: res.expiresAt,
      });
    } catch (err) {
      renewTurnstile();
      setVisitorError(err?.message || 'Failed to start visitor session');
      setVisitorStarting(false);
      // A start of this visitor's is still being set up: wait, then read the status again, which
      // opens the session once it is running (#1464).
      if (err?.code === 'VISITOR_START_IN_PROGRESS') {
        clearTimeout(rereadTimer.current);
        rereadTimer.current = setTimeout(readVisitorStatus, VISITOR_START_REREAD_MS);
      }
    }
  };

  return (
    <section
      aria-labelledby="lab-sign-in-heading"
      data-testid="lab-sign-in"
      className="glass rounded-xl p-6 flex flex-col gap-4 max-w-2xl"
    >
      <div className="flex flex-col gap-1.5">
        <h2 id="lab-sign-in-heading" className="text-lg font-bold text-slate-950 dark:text-white">
          {SIGN_IN_HEADING}
        </h2>
        <p className="text-sm text-slate-700 dark:text-slate-300">
          Sign-in opens in a new tab. When it finishes, that tab brings you back to this lab, and
          the workspace opens here as well.
        </p>
        <p className={`text-sm ${MUTED}`}>
          Lab workspaces are for members of the HybridCloudWorks organization on GitHub.
        </p>
      </div>

      {visitorStatus?.configured ? (
        <VisitorAccess
          status={visitorStatus}
          containerRef={containerRef}
          checkReady={turnstilePhase === 'ready' || turnstilePhase === 'idle'}
          starting={visitorStarting}
          error={visitorError}
          onStart={handleStartVisitor}
        />
      ) : null}
      {visitorNotice ? (
        <p
          className="text-xs text-amber-700 dark:text-amber-400"
          data-testid="visitor-session-notice"
          role="status"
        >
          {visitorNotice}
        </p>
      ) : null}

      {/* Pre-flight card with duration, toolchains, terminal preview and trust disclosures */}
      <LabPreflightCard compact headingLevel="h3" />

      {pending ? (
        <p role="status" className="text-sm text-slate-900 dark:text-slate-100">
          {SIGN_IN_PENDING_SENTENCE}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        {signInHref ? (
          <a
            href={signInHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onStart}
            data-testid="lab-sign-in-link"
            className={PRIMARY}
          >
            Sign in with GitHub <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : null}
        <button type="button" onClick={alreadySignedIn} className={SECONDARY}>
          I&apos;ve already signed in
        </button>
        <Link to={backTo} className={SECONDARY}>
          Back to labs
        </Link>
      </div>
    </section>
  );
}

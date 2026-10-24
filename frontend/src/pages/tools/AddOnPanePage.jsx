/**
 * One AddOn's page: an independently built tool shown in a sandboxed pane
 * at `/tools/<id>` (ADR 0035; the HCW AddOn Integration Standard,
 * docs/standards/addon-integration-standard.md). Structured like the lab
 * pane page (pages/shared/LabPanePage.jsx) without the sign-in step: the
 * tool is anonymous, the site holds no session for it and sends it
 * nothing.
 *
 * WHAT THE PANE LOADS. The AddOn's own origin, `https://<id>.lab.hybridcloudworks.com`
 * (`addonPaneUrl`), one exact origin per row in the site's `frame-src`
 * (csp.test.js reads `addonOrigins()`). The AddOn's own pages carry a
 * `frame-ancestors` that names the site, and the lab host redirects a
 * top-level visit to this page, so the pane is the one way in.
 *
 * WHAT THE PANE SAYS. The AddOn posts `{ type: 'hcw-addon', id, state }`
 * to the site's origins (never `*`), on transitions only. The page takes a
 * message only from the AddOn's origin, only from this pane's own window,
 * and only with the type, this row's id and a state it knows
 * (`addonMessageState`); nothing else in it is read, except `navigate`
 * (`addonMessageNavigate`), which is read only when the row grants
 * `navigate` and names one of ADDON_NAVIGATION_TARGETS, and which the page
 * acts on through the router itself: the AddOn's `frame-ancestors 'none'`
 * on the site would block an in-frame link to the site, and a sandboxed
 * frame may never navigate the top window. A message means the frame
 * loaded, so it stops the load watchdog; the state is shown on the toolbar
 * in words; `unavailable` shows the page's own unavailable section. When
 * the frame loads, focus moves into it.
 *
 * THE SANDBOX is `allow-scripts allow-same-origin allow-forms`, plus
 * `allow-downloads` for a row with `downloads` (the report bundle and the
 * sample file; Chromium blocks a download from a sandboxed frame without
 * it) and `allow-popups` for `popups` (discouraged: a popup inherits the
 * sandbox). Never `allow-top-navigation`. `allow-same-origin` is required:
 * without it the frame is an opaque origin, its own `fetch('/api/…')`
 * arrives with `Origin: null`, exact-origin CORS refuses it, and the
 * human-verification widget cannot bind to its hostname. The AddOn is
 * always another origin, so scripts plus same-origin cannot lift the
 * sandbox (`sandboxFor`). `allow` grants the clipboard and fullscreen to
 * the AddOn's origin only when the row names them (`allowFor`).
 *
 * UNAVAILABLE. Before the pane opens, the page asks the status proxy
 * (`GET public/addons/<id>/status`, at most a minute old). The pane opens
 * only when that read says configured and reachable. Anything else (not
 * configured, unreachable, the route missing, the read failing), a frame
 * that has not loaded within ADDON_PANE_LOAD_TIMEOUT_MS, and the AddOn
 * reporting `unavailable` all show one sentence, never the error. The lab
 * host's own answer for a stopped AddOn is the same sentence.
 *
 * COMING. A row whose status is `coming` renders its heading, summary and
 * `comingReason` with a link home: a real page, pre-rendered as such, with
 * no frame and no status read.
 *
 * PRE-RENDER. One page per catalogue row (scripts/prerender-entry.jsx). The
 * first render reads no storage and no clock: the status read starts in an
 * effect, so the built HTML is the heading and the opening sentence, and
 * hydration matches it.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, Navigate, useNavigate } from 'react-router';
import { addonById, addonFrameUrl, addonPanePath } from '@/data/addons/catalogue';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchAddonStatus } from '@/lib/publicApi';
import { staticRoutes } from '@/lib/routeFactory';
import { safeUrl } from '@/lib/safeUrl';

/** The one sentence for every way the tool can be missing; the lab host's 503 body is the same. */
export const ADDON_UNAVAILABLE_SENTENCE = "This tool isn't available right now.";
export const ADDON_OPENING_SENTENCE = 'Opening the tool…';

/** A frame that has not loaded in this long is treated as unavailable. */
export const ADDON_PANE_LOAD_TIMEOUT_MS = 30_000;

/** The canonical origin, as scripts/prerender.mjs writes it. */
const SITE_ORIGIN = 'https://hybridcloudworks.com';

/** `usePublicData` key for one AddOn's status read. */
export const addonStatusKey = (addonId) => `addons:${addonId}:status`;

/**
 * The states an AddOn reports, and the words the toolbar shows for each.
 * `unavailable` has no words here: it shows the unavailable section.
 */
export const ADDON_PANE_STATE_WORDS = Object.freeze({
  loading: 'Opening the tool…',
  ready: 'Tool ready',
  working: 'Working…',
});
export const ADDON_PANE_STATES = Object.freeze(['loading', 'ready', 'working', 'unavailable']);

/** The `type` an AddOn puts on every message it posts. */
export const ADDON_MESSAGE_TYPE = 'hcw-addon';

/** The site paths a `navigate` message may name, and nothing else. */
export const ADDON_NAVIGATION_TARGETS = Object.freeze([
  staticRoutes.contact,
  staticRoutes.landingZone,
  staticRoutes.labs,
]);

const BASE_SANDBOX = Object.freeze(['allow-scripts', 'allow-same-origin', 'allow-forms']);

/** The pane's sandbox for a row: the base flags, plus what the row's capabilities add. */
export function sandboxFor(addon) {
  const flags = [...BASE_SANDBOX];
  const granted = addon?.capabilities ?? [];
  if (granted.includes('downloads')) flags.push('allow-downloads');
  if (granted.includes('popups')) flags.push('allow-popups');
  return flags.join(' ');
}

/**
 * The pane's `allow` list: the clipboard and fullscreen, each to the AddOn's
 * origin and only when the row names it; '' when it names none. `clipboard`
 * grants read and write; `clipboard-write` grants write only, which is all a
 * "Copy report" button needs (website issue #1354).
 */
export function allowFor(addon) {
  const granted = addon?.capabilities ?? [];
  const entries = [];
  if (granted.includes('clipboard')) {
    entries.push(`clipboard-read ${addon.origin}`, `clipboard-write ${addon.origin}`);
  } else if (granted.includes('clipboard-write')) {
    entries.push(`clipboard-write ${addon.origin}`);
  }
  if (granted.includes('fullscreen')) entries.push(`fullscreen ${addon.origin}`);
  return entries.join('; ');
}

/**
 * The site's theme as the visitor sees it: the `dark` class the theme provider
 * puts on the document, read directly so this page needs no provider. `null`
 * when there is no document (a pre-render), which leaves the pane URL bare.
 */
export function siteTheme() {
  if (typeof document === 'undefined') return null;
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/**
 * The AddOn's state from a `message` event, or null for anything else: a
 * message from another origin, from a window that is not this pane's frame,
 * without the AddOn's type, for another id, or without a state the page
 * knows. Nothing else in the message is read here.
 */
export function addonMessageState(event, frame, addon) {
  if (!addon || event?.origin !== addon.origin) return null;
  if (!frame || event.source !== frame.contentWindow) return null;
  const { data } = event;
  if (data === null || typeof data !== 'object' || data.type !== ADDON_MESSAGE_TYPE) return null;
  if (data.id !== addon.id) return null;
  return ADDON_PANE_STATES.includes(data.state) ? data.state : null;
}

/**
 * The site path a `navigate` message asks for, or null: only on a message
 * `addonMessageState` accepts, only when the row grants `navigate`, and
 * only for one of ADDON_NAVIGATION_TARGETS, compared exactly.
 */
export function addonMessageNavigate(event, frame, addon) {
  if (addonMessageState(event, frame, addon) === null) return null;
  if (!addon.capabilities.includes('navigate')) return null;
  const target = event.data.navigate;
  return typeof target === 'string' && ADDON_NAVIGATION_TARGETS.includes(target) ? target : null;
}

/** What the status read says about the tool: 'checking', 'available' or 'unavailable'. */
export function addonService({ data, loading, error }) {
  if (error) return 'unavailable';
  if (loading && data === null) return 'checking';
  return data?.configured === true && data.reachable === true ? 'available' : 'unavailable';
}

const SERVICE_WORDS = Object.freeze({
  checking: 'Checking…',
  available: 'Available',
  unavailable: 'Unavailable',
});

const MUTED = 'text-slate-600 dark:text-slate-400';
const BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';
const SECONDARY = `${BUTTON} border border-slate-300 dark:border-slate-600 text-slate-900 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800`;

/** useSyncExternalStore subscription to the document's full-screen changes. */
const subscribeFullscreen = (onChange) => {
  document.addEventListener('fullscreenchange', onChange);
  return () => document.removeEventListener('fullscreenchange', onChange);
};
/** Whether something is full screen right now. */
const readFullscreen = () => Boolean(document.fullscreenElement);
/** Whether this document may go full screen at all. */
const readFullscreenEnabled = () => document.fullscreenEnabled === true;
/** The server snapshot for both: nothing is full screen in pre-rendered HTML. */
const serverFalse = () => false;
/** A subscription for a value that never changes (fullscreenEnabled). */
const noSubscription = () => () => {};

export default function AddOnPanePage({ addonId, addon: addonProp }) {
  const addon = addonProp ?? addonById(addonId);
  if (!addon) return <Navigate to={staticRoutes.home} replace />;
  if (addon.status === 'coming') return <ComingAddOn key={addon.id} addon={addon} />;
  return <AddOnPane key={addon.id} addon={addon} />;
}

/** Title, description and canonical for one row's page. */
function PageHead({ addon }) {
  return (
    <Helmet>
      <title>{`${addon.title} — Tools | Hybrid Cloud Works`}</title>
      <meta name="description" content={addon.summary} />
      <link rel="canonical" href={`${SITE_ORIGIN}${addonPanePath(addon)}`} />
    </Helmet>
  );
}

/** The breadcrumb, heading, status chip (children) and summary. */
function PageHeader({ addon, children }) {
  return (
    <header className="flex flex-col gap-3">
      <p className="flex flex-wrap gap-x-1.5 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
        <span>Tools</span>
        <span aria-hidden="true">/</span>
        <span>{addon.title}</span>
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="display-heading text-2xl sm:text-3xl text-slate-950 dark:text-white">
          {addon.title}
        </h1>
        {children}
      </div>
      <p className={`${MUTED} max-w-3xl`}>{addon.summary}</p>
    </header>
  );
}

/** A `coming` row: the explainer, with no frame and no status read. */
function ComingAddOn({ addon }) {
  return (
    <>
      <PageHead addon={addon} />
      <div className="relative z-10 max-w-350 mx-auto w-full px-4 md:px-8 py-8 flex flex-col gap-8">
        <PageHeader addon={addon}>
          <span
            data-testid="addon-status"
            className="rounded-full border border-slate-300 dark:border-slate-600 px-2.5 py-0.5 text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            Coming soon
          </span>
        </PageHeader>
        <section
          data-testid="addon-coming"
          className="glass rounded-xl p-6 flex flex-col gap-3 max-w-2xl"
        >
          <p className="font-semibold text-slate-900 dark:text-slate-100">{addon.comingReason}</p>
          <Link to={staticRoutes.home} className={`${SECONDARY} self-start`}>
            Back to home
          </Link>
        </section>
      </div>
    </>
  );
}

/** An `available` row: the status read, then opening, unavailable or the pane. */
function AddOnPane({ addon }) {
  const status = usePublicData(() => fetchAddonStatus(addon.id), addonStatusKey(addon.id));
  const service = addonService(status);

  return (
    <>
      <PageHead addon={addon} />
      <div className="relative z-10 max-w-350 mx-auto w-full px-4 md:px-8 py-8 flex flex-col gap-8">
        <PageHeader addon={addon}>
          {/* Words, never colour alone (SYSTEM_STATUS is the model). */}
          <span
            data-testid="addon-status"
            data-status={service}
            className="rounded-full border border-slate-300 dark:border-slate-600 px-2.5 py-0.5 text-xs font-semibold text-slate-700 dark:text-slate-300"
          >
            {SERVICE_WORDS[service]}
          </span>
        </PageHeader>
        <PaneBody service={service} addon={addon} />
      </div>
    </>
  );
}

/** Exactly one of: opening, unavailable, or the pane. */
function PaneBody({ service, addon }) {
  if (service === 'checking') {
    return (
      <p role="status" className={`text-sm ${MUTED}`} data-testid="addon-opening">
        {ADDON_OPENING_SENTENCE}
      </p>
    );
  }
  if (service === 'unavailable') return <Unavailable />;
  return <Pane addon={addon} />;
}

/** The one unavailable section, with the sentence and a way home. */
function Unavailable() {
  return (
    <section
      data-testid="addon-unavailable"
      className="glass rounded-xl p-6 flex flex-col gap-3 max-w-2xl"
    >
      <p role="status" className="font-semibold text-slate-900 dark:text-slate-100">
        {ADDON_UNAVAILABLE_SENTENCE}
      </p>
      <p className={`text-sm ${MUTED}`}>Try again in a few minutes.</p>
      <Link to={staticRoutes.home} className={`${SECONDARY} self-start`}>
        Back to home
      </Link>
    </section>
  );
}

/**
 * The AddOn's latest state, from the messages the pane's frame posts
 * (`addonMessageState` decides which count); null until it says anything.
 * A `navigate` the page accepts (`addonMessageNavigate`) goes to the router.
 */
function useAddonState(frameRef, addon) {
  const [state, setState] = useState(null);
  const navigate = useNavigate();
  useEffect(() => {
    const onMessage = (event) => {
      const next = addonMessageState(event, frameRef.current, addon);
      if (next === null) return;
      setState(next);
      const target = addonMessageNavigate(event, frameRef.current, addon);
      if (target !== null) navigate(target);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frameRef, addon, navigate]);
  return state;
}

/** The toolbar and the frame. */
function Pane({ addon }) {
  const paneRef = useRef(null);
  const frameRef = useRef(null);
  // The theme the frame is given, read once when the page first renders. Fixed
  // on purpose: changing a frame's `src` reloads it, and a reload would throw
  // away the report the visitor has open in the pane. A theme toggle therefore
  // takes effect in an open pane the next time the page loads.
  const [frameTheme] = useState(siteTheme);
  const [loaded, setLoaded] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const paneState = useAddonState(frameRef, addon);
  const fullscreenEnabled = useSyncExternalStore(
    noSubscription,
    readFullscreenEnabled,
    serverFalse
  );
  const fullscreen = useSyncExternalStore(subscribeFullscreen, readFullscreen, serverFalse);

  // A frame that never loads says nothing; the watchdog says it for it. Any
  // state the AddOn sends means the frame loaded.
  const heard = paneState !== null;
  useEffect(() => {
    if (loaded || heard || timedOut) return undefined;
    const timer = window.setTimeout(() => setTimedOut(true), ADDON_PANE_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [loaded, heard, timedOut]);

  // Full screen is the pane, this page's own element: never the AddOn's page
  // on its own, which the lab host would redirect.
  /** Enter or leave full screen on the pane element. */
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
    } else {
      paneRef.current?.requestFullscreen?.().catch(() => {});
    }
  };

  if (timedOut || paneState === 'unavailable') return <Unavailable />;

  const src = safeUrl(addonFrameUrl(addon, frameTheme));
  return (
    <div className="flex flex-col gap-2">
      <section
        ref={paneRef}
        aria-label={`Tool: ${addon.title}`}
        data-testid="addon-pane"
        className="flex flex-col rounded-xl overflow-hidden border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 h-[calc(100dvh-14rem)] min-h-128"
      >
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-700">
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {addon.title}
          </span>
          {/* Not a live region: the tool's own status line in the pane is
              announced, and this would say the same thing a second time. */}
          <span data-testid="addon-pane-state" className={`mr-auto text-xs ${MUTED}`}>
            {paneState ? (ADDON_PANE_STATE_WORDS[paneState] ?? '') : ''}
          </span>
          {fullscreenEnabled ? (
            <button type="button" onClick={toggleFullscreen} className={SECONDARY}>
              {fullscreen ? 'Exit full screen' : 'Open full screen'}
            </button>
          ) : null}
          <Link to={staticRoutes.home} className={SECONDARY}>
            Back to home
          </Link>
        </div>
        {src ? (
          <iframe
            ref={frameRef}
            src={src}
            title={addon.title}
            sandbox={sandboxFor(addon)}
            allow={allowFor(addon)}
            onLoad={() => {
              setLoaded(true);
              // Focus moves into the tool on open (the standard's section 7): keyboard and
              // screen-reader users continue in the pane, not at the toolbar behind it. Only
              // while focus is still where the page left it: a visitor who has already moved
              // to a control keeps it, and the load does not interrupt their typing.
              const active = document.activeElement;
              if (active === null || active === document.body) frameRef.current?.focus();
            }}
            className="block w-full flex-1 border-0"
          />
        ) : null}
      </section>
      <p className={`text-xs ${MUTED}`}>
        Anything you upload goes to the tool and is held in memory for at most two hours; you can
        delete it from inside the tool at any time. This is not a production service.
      </p>
    </div>
  );
}

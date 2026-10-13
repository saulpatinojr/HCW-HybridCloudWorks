/**
 * Everything the Recording Hub reads and writes, in one place (#576).
 *
 * The hub is organised by duty now, and two of those duties are two views of
 * one list: approving a transcript on **Transcripts** is what queues its
 * publish to Podbean, which is the only thing **Distribution** has to show. A
 * per-tab read would let them disagree about the same transcript, so this
 * lives at page level the way CertificationsPage owns useCertifications and
 * ListenAndLearnPage owns useListenAndLearn.
 *
 * The other reads are here for the same reason rather than by habit:
 *
 *  - the Plaud connection decides whether **Recordings** can list the live
 *    library at all, and **Settings** is where it is connected — so connecting
 *    on one must light up the other;
 *  - the podcast feed read answers both **Episodes** (the show) and
 *    **Distribution** (the feed URL), from one call;
 *  - the Podbean overview (#1115) — what the host says now about the episodes
 *    the records name, and their downloads — is read once Distribution first
 *    asks for it, not on mount: it is a Podbean read (cached server-side for
 *    fifteen minutes), and four of the five tabs never show it.
 *
 * Race-safe the way #555 hardened the Newsletter Hub:
 *
 *  - every transcript read carries a generation, so a reload that resolves
 *    after a newer one paints nothing rather than restoring rows a review has
 *    already changed;
 *  - unmounting (or auth going away) supersedes whatever is in flight;
 *  - a FAILED read leaves the error and does not silently keep stale rows
 *    beside it;
 *  - writes are guarded per transcript: a second approve or retry on one whose
 *    first write has not answered is ignored, not sent twice.
 *
 * The hook only holds state. The reads and writes below are module-level
 * functions over one state bag, each with a single exit — the shape
 * useCertifications documents, and the reason this stays inside Qlty's
 * complexity and return-count budgets as it grows.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getJSON, postJSON } from '@/lib/api';
import { describeSkip } from './recordingView';

/**
 * The Plaud connection as the hub knows it. `unknown` is a check that could
 * not run (a thrown read) — not `disconnected`, which is a check that ran and
 * said so. Conflating the two pinned the tab to "not connected" for a whole
 * session when the first read raced the sign-in.
 */
export const CONNECTION = Object.freeze({
  checking: 'checking',
  connected: 'connected',
  disconnected: 'disconnected',
  unknown: 'unknown',
});

const EMPTY = Object.freeze([]);

// ── reads ────────────────────────────────────────────────────────────────────

/**
 * The Plaud MCP server document as the fields this hub renders.
 *
 * Split from the read so the read is a try/catch and nothing else: the
 * optional chaining below is one branch per field to a complexity counter, and
 * together they put the read over the budget the repository's own gate
 * enforces.
 */
function readPlaudDoc(plaud) {
  return {
    status: plaudStatus(plaud),
    hasRefreshToken: plaud?.hasOauthRefreshToken === true,
    refreshState: rotationRecord(plaud),
  };
}

/** Connected only when the server says so AND a token is stored. */
function plaudStatus(plaud) {
  // The API returns hasOauthToken; the token value itself is write-only.
  const ok = plaud?.status === 'connected' && plaud?.hasOauthToken === true;
  return ok ? CONNECTION.connected : CONNECTION.disconnected;
}

/**
 * What the 12-hour refresh timer has actually done, which nothing on this page
 * could say before (#358). Without it the rotation has no witness at all: the
 * timer logs its success at Information, and host verbosity was cut to Warning
 * by T-719, so the trace is not ingested either.
 */
function rotationRecord(plaud) {
  return {
    lastTokenRefresh: plaud?.lastTokenRefresh ?? null,
    expiresAt: plaud?.oauthExpiresAt ?? null,
    error: plaud?.lastTokenRefreshError ?? null,
  };
}

/** One read of the MCP server list, as the connection this hub shows. */
async function fetchConnection() {
  let outcome;
  try {
    const res = await getJSON('cms/config/mcp-servers');
    outcome = readPlaudDoc((res.items || []).find((d) => d.id === 'plaud'));
  } catch {
    // Unknown, not disconnected — and the rotation panel is cleared with it.
    // A thrown read would otherwise leave Settings showing the LAST successful
    // rotation as though it were current, under a banner saying the connection
    // is unknown: one panel confident and the other not, about the same read.
    outcome = { status: CONNECTION.unknown, hasRefreshToken: false, refreshState: null };
  }
  return outcome;
}

/** One GET of the transcript list, as `{ rows }` or `{ error }` — never throws. */
async function fetchTranscripts() {
  let outcome;
  try {
    const res = await getJSON('cms/podcast/transcripts');
    outcome = { rows: Array.isArray(res?.items) ? res.items : [] };
  } catch (error) {
    outcome = { error: error?.message || 'Could not load transcripts' };
  }
  return outcome;
}

/** The show's published episodes and its feed URL, from one public read. */
async function fetchEpisodes() {
  let outcome;
  try {
    const res = await getJSON('public/podcasts?provider=main');
    outcome = {
      episodes: Array.isArray(res?.items) ? res.items : [],
      feedUrl: res?.mainFeedUrl || res?.feedUrl || null,
    };
  } catch (error) {
    outcome = { error: error?.message || 'Could not load episodes', episodes: EMPTY };
  }
  return outcome;
}

/**
 * One GET of the Podbean overview, as `{ data }` or `{ error }` — never throws.
 * `refresh` is the hub's Refresh button: the route reads Podbean live instead
 * of serving its fifteen-minute cache.
 */
async function fetchHostOverview(refresh) {
  let outcome;
  try {
    const res = await getJSON(
      refresh ? 'cms/podcast/host/overview?refresh=1' : 'cms/podcast/host/overview'
    );
    outcome = { data: res && typeof res === 'object' ? res : {} };
  } catch (error) {
    outcome = { error: error?.message || 'Could not read Podbean' };
  }
  return outcome;
}

/** The overview before anything has asked for it. */
export const HOST_OVERVIEW_IDLE = Object.freeze({ data: null, loading: false, error: '' });

async function readConnection(state) {
  const outcome = await fetchConnection();
  if (!state.alive.current) return;
  state.setConnection(outcome.status);
  state.setHasRefreshToken(outcome.hasRefreshToken);
  state.setRefreshState(outcome.refreshState);
}

/**
 * Read as generation `mine`. A superseded read paints nothing — a reload that
 * answers after a review landed would otherwise restore the rows the review
 * changed.
 */
async function readTranscripts(state) {
  const mine = ++state.generation.current;
  state.setLoading(true);
  const outcome = await fetchTranscripts();
  if (mine !== state.generation.current || !state.alive.current) return;
  if (outcome.error) {
    state.setLoadError(outcome.error);
  } else {
    state.setItems(outcome.rows);
    state.setLoadError('');
  }
  state.setLoading(false);
}

/**
 * Read the Podbean overview as generation `mine`, like the transcripts: a
 * Refresh that answers after a later one paints nothing. A failed read leaves
 * the error and no rows — stale download counts beside "could not read" would
 * be the same half-confident panel #358 removed from Settings.
 */
async function readHostOverview(state, { refresh = false } = {}) {
  const mine = ++state.hostGeneration.current;
  state.setHostOverview((prev) => ({ ...prev, loading: true }));
  const outcome = await fetchHostOverview(refresh);
  if (mine !== state.hostGeneration.current || !state.alive.current) return;
  state.setHostOverview(
    outcome.error
      ? { data: null, loading: false, error: outcome.error }
      : { data: outcome.data, loading: false, error: '' }
  );
}

async function readEpisodes(state) {
  const outcome = await fetchEpisodes();
  if (!state.alive.current) return;
  state.setEpisodes(outcome.episodes);
  state.setEpisodesError(outcome.error || '');
  if (!outcome.error) state.setFeedUrl(outcome.feedUrl);
  state.setEpisodesLoading(false);
}

/** Both podcast reads, deferred so the first render commits before state moves. */
function startPodcastReads(state) {
  const timer = setTimeout(() => {
    readTranscripts(state);
    readEpisodes(state);
  }, 0);
  return () => clearTimeout(timer);
}

// ── writes ───────────────────────────────────────────────────────────────────

/** Mark a transcript busy, or release it, in the ref the guard reads. */
function setBusy(state, key) {
  state.busy.current = key;
  state.setBusyKey(key);
}

/** One line about what the review route did with the host publish it queued. */
function hostNoteFor(res) {
  // 200 or 202: authedFetch returns the body for any 2xx, and the review route
  // answers 202 with `jobId` (and `host.pending`) while the host publish it
  // queued is in flight, 200 when there was nothing to queue.
  const host = res?.host && typeof res.host === 'object' ? res.host : null;
  if (res?.jobId) return ` Publishing to Podbean (job ${res.jobId}).`;
  if (host?.skipped) return ` Host publish skipped: ${describeSkip(host)}.`;
  return '';
}

async function openDetail(state, id) {
  if (state.busy.current) return;
  setBusy(state, `open:${id}`);
  let failure = null;
  try {
    const res = await getJSON(`cms/podcast/transcripts/${encodeURIComponent(id)}`);
    if (state.alive.current) state.setDetail(res.item);
  } catch (err) {
    failure = err?.message;
  }
  if (failure) {
    state.toast({
      title: 'Could not load the transcript',
      description: failure,
      variant: 'destructive',
    });
  }
  setBusy(state, '');
}

async function writeReview(state, item, status) {
  // Ignore a second click while the first is unanswered rather than sending
  // the approval twice.
  if (state.busy.current) return;
  setBusy(state, `review:${item.id}`);
  let failure = null;
  try {
    const res = await postJSON('cms/podcast/transcripts/review', { id: item.id, status });
    state.toast({
      title: status === 'published' ? 'Transcript approved' : 'Returned to draft',
      description: `${item.title || item.id}.${hostNoteFor(res)}`,
    });
  } catch (err) {
    failure = err?.message;
  }
  if (failure) {
    state.toast({ title: 'Review not saved', description: failure, variant: 'destructive' });
  }
  setBusy(state, '');
  await readTranscripts(state);
}

async function retryHost(state, item) {
  if (state.busy.current) return;
  setBusy(state, `retry:${item.id}`);
  let failure = null;
  try {
    await postJSON(`cms/podcast/transcripts/${encodeURIComponent(item.id)}/publish`, {});
    state.toast({ title: 'Host publish retried', description: item.title || item.id });
  } catch (err) {
    failure = err?.message || '';
  }
  if (failure !== null) reportRetryFailure(state, failure);
  setBusy(state, '');
  await readTranscripts(state);
}

/**
 * A failed host retry, with the one case that is not a failure.
 *
 * A deployment that predates the publish route (#437 slice 2) answers 404 for
 * the path, which authedFetch reports as "… failed with HTTP 404". Say so
 * plainly rather than as a failure.
 */
function reportRetryFailure(state, message) {
  const notHere = /HTTP 404/.test(message);
  state.toast({
    title: notHere ? 'Host retry is not available yet' : 'Host retry failed',
    description: notHere
      ? 'This deployment does not have the publish route yet; retry once it is deployed.'
      : message,
    variant: notHere ? undefined : 'destructive',
  });
}

// ── the hook ─────────────────────────────────────────────────────────────────

export default function useRecordingHub(ready, toast) {
  const [connection, setConnection] = useState(CONNECTION.checking);
  const [hasRefreshToken, setHasRefreshToken] = useState(false);
  // null until the first read answers; Settings renders nothing for it rather
  // than claiming a rotation has never happened (#358).
  const [refreshState, setRefreshState] = useState(null);

  const [items, setItems] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [detail, setDetail] = useState(null);
  const [busyKey, setBusyKey] = useState('');

  const [episodes, setEpisodes] = useState(EMPTY);
  const [feedUrl, setFeedUrl] = useState(null);
  const [episodesLoading, setEpisodesLoading] = useState(true);
  const [episodesError, setEpisodesError] = useState('');

  // The Podbean overview (#1115): read once Distribution asks (`hostWanted`)
  // and auth is ready, then on Refresh.
  const [hostOverview, setHostOverview] = useState(HOST_OVERVIEW_IDLE);
  const [hostWanted, setHostWanted] = useState(false);

  // Bumped by every transcript read; a read whose number is no longer current
  // has been superseded and must paint nothing.
  const generation = useRef(0);
  const hostGeneration = useRef(0);
  const alive = useRef(true);
  const busy = useRef('');
  // The latest-ref pattern: `useToast` hands back a new function every render,
  // and a write must reach the current one without that identity becoming a
  // dependency of every read below. Assigned in an effect, never during render.
  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  const state = useMemo(
    () => ({
      setConnection,
      setHasRefreshToken,
      setRefreshState,
      setItems,
      setLoading,
      setLoadError,
      setDetail,
      setBusyKey,
      setEpisodes,
      setFeedUrl,
      setEpisodesLoading,
      setEpisodesError,
      setHostOverview,
      generation,
      hostGeneration,
      alive,
      busy,
      toast: (...args) => toastRef.current?.(...args),
    }),
    []
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Supersede anything in flight: its `mine` can never match again.
      generation.current += 1;
      hostGeneration.current += 1;
    };
  }, []);

  // Both effect bodies are module-level functions above. Their early exits
  // belong to those functions rather than to this one, which is what keeps the
  // hook inside Qlty's return-count budget as it grows.
  useEffect(() => {
    if (ready) readConnection(state);
  }, [ready, state]);

  useEffect(() => (ready ? startPodcastReads(state) : undefined), [ready, state]);

  // Once, when both hold: `hostWanted` only ever goes true, and a tab that
  // asks before auth is ready gets its read the moment auth arrives.
  useEffect(() => {
    if (ready && hostWanted) readHostOverview(state);
  }, [ready, hostWanted, state]);

  const recheckConnection = useCallback(() => {
    setConnection(CONNECTION.checking);
    readConnection(state);
  }, [state]);

  return {
    connection,
    hasRefreshToken,
    refreshState,
    recheckConnection,
    markConnected: useCallback(({ refreshSupplied } = {}) => {
      setConnection(CONNECTION.connected);
      if (refreshSupplied) setHasRefreshToken(true);
    }, []),

    items,
    loading,
    loadError,
    detail,
    busyKey,
    reload: useCallback(() => readTranscripts(state), [state]),
    open: useCallback((id) => openDetail(state, id), [state]),
    closeDetail: useCallback(() => setDetail(null), []),
    review: useCallback((item, status) => writeReview(state, item, status), [state]),
    retryHost: useCallback((item) => retryHost(state, item), [state]),

    episodes,
    feedUrl,
    episodesLoading,
    episodesError,

    hostOverview,
    loadHostOverview: useCallback(() => setHostWanted(true), []),
    refreshHostOverview: useCallback(() => readHostOverview(state, { refresh: true }), [state]),
  };
}

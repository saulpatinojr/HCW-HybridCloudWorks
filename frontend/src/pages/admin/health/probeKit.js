/**
 * What every probe module shares (ADR 0033 §1 Platform, §8): the hubs, the
 * deep links a probe sends the reader to, the one result shape, and the
 * builders for the three probe kinds — so a probe group under probeGroups/
 * is a list of facts and nothing else.
 */
import { getSessionizeSpeakerId } from '@/lib/adminSettings';
import { classifyFailure, describeAge, toSystemStatus } from '@/lib/status';
import { serviceById } from '@/components/admin/integrations/serviceRegistry';

export const HUBS = Object.freeze({
  pipeline: 'Pipeline',
  creative: 'Creative',
  amplify: 'Amplify',
  enhanced: 'Enhanced',
  spotlight: 'Spotlight',
  platform: 'Platform',
});

// ── Deep links ───────────────────────────────────────────────────────────────

export const INTEGRATIONS = (group) => ({
  to: `/admin/integrations?tab=services&group=${group}`,
  label: 'Integrations',
});
export const KEYS = { to: '/admin/integrations?tab=keys', label: 'Keys' };
/** A fix link to one Platform Settings tab. */
export const SETTINGS = (tab) => ({
  to: `/admin/platform-settings?tab=${tab}`,
  label: 'Platform Settings',
});
export const AI_ENGINE = { to: '/admin/ai-engine', label: 'AI Engine' };
export const LABS = { to: '/admin/labs?tab=agents', label: 'Labs' };
export const NEWSLETTER = { to: '/admin/newsletter-hub?tab=settings', label: 'Newsletter Hub' };
export const QUEUE = { to: '/admin/review-queue', label: 'Review Queue' };
export const GALLERY = { to: '/admin/image-gallery', label: 'Image Gallery' };
export const FORGE = { to: '/admin/forge-studio', label: 'Forge Studio' };
export const LIVE_PAGES = { to: '/admin/live-pages', label: 'Live Pages' };
export const ALERTS = { to: '/admin/health?tab=alerts', label: 'Alerts' };
export const IDENTITY = { to: '/admin/integrations?tab=identity', label: 'Identity' };

// ── Results ──────────────────────────────────────────────────────────────────

export const stamp = () => new Date().toISOString();

/** One result. `status` is an id from lib/status.js. */
export const result = (status, summary, extra = {}) => ({
  status: toSystemStatus(status).id,
  summary,
  checkedAt: stamp(),
  ...extra,
});

/**
 * A check that has not run, said as unknown with NO time: it is not evidence,
 * so a stored result from an earlier check is shown in its place
 * (probeRegistry.js resolveProbe), rather than "not run" hiding it.
 */
export const notRun = (summary) => result('unknown', summary, { checkedAt: null });

/**
 * Critical or offline for a failed check: the transition rule in
 * lib/status.js, re-exported so the probe modules keep one import.
 */
export { classifyFailure };

/** "12 min ago" — lib/status.js describeAge, under the name the probes use. */
export const ago = describeAge;

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The message an error carries, or the error itself when it has none. */
export const messageOf = (error) => error?.message || error;

/**
 * The result while the ops-health snapshot is missing: a failed read is the
 * failure's own verdict (offline when nothing answered, critical when the
 * route refused), and a read still under way is not evidence yet.
 */
export const snapshotMissing = (ctx) =>
  ctx?.ops?.error
    ? result(
        classifyFailure(ctx.ops.error),
        `The ops-health snapshot could not be read: ${ctx.ops.error}`
      )
    : notRun('Waiting for the ops-health snapshot.');

// ── Builders ─────────────────────────────────────────────────────────────────

/**
 * A probe backed by an Integrations service card: the same `test` function,
 * so the two pages cannot disagree about whether Publer answers.
 */
export function fromService(id, { hub, covers, impact, action, safe = true, costNote } = {}) {
  const service = serviceById(id);
  if (!service) throw new Error(`probeRegistry: no service '${id}'`);
  return {
    id,
    label: service.name,
    hub,
    covers,
    impact,
    action,
    href: INTEGRATIONS(service.group),
    kind: 'live',
    safe: safe && !service.skipInTestAll,
    costNote: costNote ?? service.skipInTestAll ?? null,
    run: async () => {
      try {
        const arg =
          service.setting === 'sessionizeSpeakerId' ? await getSessionizeSpeakerId() : undefined;
        return result('healthy', await service.test(arg));
      } catch (error) {
        const message = error?.message || `${service.name} did not answer.`;
        // The error itself, not just its sentence: the API client keeps the
        // HTTP status on it, and a 503 is offline whatever the words say.
        return result(classifyFailure(error?.message ? error : message), message);
      }
    },
  };
}

export const snapshotProbe = (entry) => ({ kind: 'snapshot', safe: true, ...entry });
export const sessionProbe = (entry) => ({ kind: 'session', ...entry });
export const liveProbe = (entry) => ({ kind: 'live', safe: true, ...entry });

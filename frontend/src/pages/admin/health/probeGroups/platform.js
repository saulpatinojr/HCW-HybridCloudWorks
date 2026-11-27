/** The Platform hub's probes (ADR 0033 §1 Platform, §8): Cosmos, Blob, configuration, Key Vault, Qlty, Cloudflare, pricing, the session. */
import {
  GALLERY,
  IDENTITY,
  KEYS,
  KODA,
  SETTINGS,
  fromService,
  liveProbe,
  result,
  sessionProbe,
  snapshotProbe,
} from '../probeKit';
import {
  RATE_LIMIT_RUNBOOK_URL,
  checkRateLimit,
} from '@/components/admin/cloudflare/rateLimitCheck';
import { tabHref as cloudflareTabHref } from '@/components/admin/cloudflare/tabs';
import {
  evaluateContentAgent,
  evaluateCosmos,
  evaluateIdentitySession,
  evaluateNightlyExport,
  evaluateRegistrySession,
  evaluateRuntimeConfig,
  evaluateStorage,
} from '../probeEvaluators';
import { runBlob, runUnresolvedSecrets } from '../probeRunners';

/**
 * A probe of this session's identity; its Test re-runs the page's identity
 * check. Its result is evidence for as long as the token it read: about
 * ninety minutes, the life of an Entra access token, not the day other
 * session checks keep (lib/status.js FRESHNESS_MS).
 */
const identityProbe = (entry) =>
  sessionProbe({
    hub: 'platform',
    href: IDENTITY,
    safe: true,
    freshForMs: 90 * 60 * 1000,
    run: (ctx) => ctx.actions.rerunIdentity(),
    ...entry,
  });

export const PLATFORM_PROBES = [
  snapshotProbe({
    id: 'cosmos',
    label: 'Cosmos DB',
    hub: 'platform',
    covers: 'Whether the ops-health snapshot, ten queries across six containers, answers.',
    impact: 'Nothing on the admin reads or writes.',
    action: 'Check the Cosmos account and the Function App identity.',
    href: { to: '/admin/health?tab=overview', label: 'Overview' },
    evaluate: evaluateCosmos,
  }),
  liveProbe({
    id: 'blob',
    label: 'Blob storage',
    hub: 'platform',
    covers: 'One default cover fetched through /api/public/media.',
    impact: 'Covers and audio do not load on the public site.',
    action: 'Check the storage account and the media route.',
    href: SETTINGS('content'),
    run: runBlob,
  }),
  snapshotProbe({
    id: 'storage',
    label: 'Storage usage',
    hub: 'platform',
    covers: 'How many generated image rows exist (a cheap proxy for Blob usage).',
    impact: 'Informational.',
    action: 'Archive from the Image Gallery when it grows.',
    href: GALLERY,
    evaluate: evaluateStorage,
  }),
  snapshotProbe({
    id: 'runtime-config',
    label: 'Runtime configuration',
    hub: 'platform',
    covers:
      'The configuration generation this worker runs and whether its Key Vault references resolved.',
    impact: 'An unresolved reference turns a feature off silently.',
    action: 'Seed the named key on Keys, or check the vault firewall and RBAC.',
    href: KEYS,
    evaluate: evaluateRuntimeConfig,
  }),
  snapshotProbe({
    id: 'content-agent',
    label: 'Content agent (Koda)',
    hub: 'platform',
    covers:
      "Koda's key (present, active, last used), the admin switches that are off, and its refusals in the last day by reason.",
    impact:
      'Refusals with a live key mean Koda is calling something it may not; a revoked key being called means a stale copy is in use.',
    action:
      'Open Koda’s tab on the Agents page: rotate or revoke the key, or turn a switch back on.',
    href: KODA,
    evaluate: evaluateContentAgent,
  }),
  snapshotProbe({
    id: 'nightly-export',
    label: 'Nightly export',
    hub: 'platform',
    covers:
      "Whether last night's Cosmos export wrote its run manifest, how old the newest completed run is, and whether every authored container (brain_records among them) is in it. Read by the worker from the private cosmos-export blob container; names and counts only.",
    impact:
      'A missing or late run means the out-of-account backup is behind: a restore would lose what was written since the last manifest. A missing authored container is a container with no backup at all.',
    action:
      'Check the failed platform jobs below and the cosmosExportCompleted events; the Cosmos restore runbook (docs/runbooks/cosmos-restore.md) says how to read a run.',
    href: { to: '/admin/health?tab=overview', label: 'Overview' },
    evaluate: evaluateNightlyExport,
  }),
  liveProbe({
    id: 'unresolved-secrets',
    label: 'Unresolved Key Vault references',
    hub: 'platform',
    covers: 'The count /api/health reports, with the names from the snapshot.',
    impact: 'Each one is an integration quietly off.',
    action: 'Seed the key on Keys.',
    href: KEYS,
    run: runUnresolvedSecrets,
  }),
  fromService('qlty', {
    hub: 'platform',
    covers: 'The Code and Security tab.',
    impact: 'That tab says Qlty is not configured.',
    action: 'Rotate the token on Keys.',
  }),
  // The admin token behind the Cloudflare page and Claude Network Guy (#1905):
  // a read of the zone, which changes nothing and costs nothing.
  fromService('cloudflare', {
    hub: 'platform',
    covers: 'Whether the Cloudflare admin token can read the site’s zone.',
    impact:
      'The Cloudflare page and Claude Network Guy cannot read or change the zone. The site itself keeps running: visitors do not go through this token.',
    action: 'Paste a new admin token on Keys, or check it is still limited to the right zone.',
  }),
  // #1909: the API rate limit rule lives only in Cloudflare, so this is what
  // notices it going. Same verdict as the Cloudflare page's Overview.
  liveProbe({
    id: 'cloudflare-rate-limit',
    label: 'Cloudflare API rate limit',
    hub: 'platform',
    covers:
      'Whether the zone’s rate limiting phase (http_ratelimit) has a rule switched on, read through the Cloudflare page’s own route. It changes nothing.',
    impact:
      'With no rule on, one address can send the API as many requests as it likes. The site keeps running.',
    action:
      'Make the rule, or switch it back on, on the Cloudflare page’s Rules tab; Part 4 of the Cloudflare admin runbook has the values.',
    href: { to: cloudflareTabHref('rules'), label: 'Cloudflare Rules' },
    docs: { href: RATE_LIMIT_RUNBOOK_URL, label: 'Runbook, Part 4' },
    run: async () => {
      const check = await checkRateLimit();
      return result(check.status, check.sentence);
    },
  }),
  fromService('cloud-pricing', {
    hub: 'platform',
    covers: 'The daily price snapshot behind the public comparison page.',
    impact: 'The comparison shows stale or no prices.',
    action: 'Press Refresh now on the Cloud pricing card; check the AWS and GCP keys.',
  }),
  identityProbe({
    id: 'identity-token',
    label: 'Session token',
    covers: 'Audience, role, scope and version of the token this session sends.',
    impact: 'Every API call from this browser is refused.',
    action: 'Sign out and in; if it persists, check the app registrations on Identity.',
    evaluate: evaluateIdentitySession,
  }),
  identityProbe({
    id: 'admin-registry',
    label: 'Admin registry lookup',
    covers: 'Whether the admins container lists this principal.',
    impact: 'Writes are refused even with a valid token.',
    action: 'Add or reactivate the admin row.',
    evaluate: evaluateRegistrySession,
  }),
];

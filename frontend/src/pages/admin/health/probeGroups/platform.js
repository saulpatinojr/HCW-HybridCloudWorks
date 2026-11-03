/** The Platform hub's probes (ADR 0033 §1 Platform, §8): Cosmos, Blob, configuration, Key Vault, Qlty, pricing, the session. */
import {
  GALLERY,
  IDENTITY,
  KEYS,
  KODA,
  SETTINGS,
  fromService,
  liveProbe,
  sessionProbe,
  snapshotProbe,
} from '../probeKit';
import {
  evaluateContentAgent,
  evaluateCosmos,
  evaluateIdentitySession,
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
    action: 'Open the Koda tab: rotate or revoke the key, or turn a switch back on.',
    href: KODA,
    evaluate: evaluateContentAgent,
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

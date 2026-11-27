/**
 * The browser's mirror of what the Cloudflare page may not change (#1905),
 * held to the server's own list. functions/src/lib/cloudflare/protected.js
 * imports nothing, so it is read here directly, as agentKeys.test.js reads
 * the server's key list; the CI filter runs this file when it changes.
 */
import { describe, expect, it } from 'vitest';
import * as server from '../../../../../functions/src/lib/cloudflare/protected.js';
import {
  APEX_WILDCARD_REASON,
  DEFAULT_ZONE,
  EDITABLE_PHASES,
  MANAGED_ZONE_NAMES,
  OWNER_ONLY_SETTINGS,
  PROTECTED_DNS_PREFIXES,
  PROTECTED_PHASES,
  READ_ONLY_PHASE_REASON,
  REDACTED_VALUE,
  ZONE_APEX,
  dnsNameLock,
  editablePhaseList,
  holdsHiddenValue,
  isEditablePhase,
  ownerOnlyReason,
  phaseLock,
  otherManagedZone,
  protectedPhaseList,
  protectedPrefixList,
  resolveZone,
} from './cloudflareLocks';

/** The status answer as the server builds it from its own lists. */
const SERVER_STATUS = {
  zone: { name: server.ZONE_APEX },
  protected: {
    dnsNames: server.PROTECTED_DNS_NAMES.map(({ name, reason }) => ({ name, reason })),
    dnsPrefixes: server.PROTECTED_DNS_PREFIXES.map(({ prefix, reason }) => ({ prefix, reason })),
    phases: server.PROTECTED_PHASES.map(({ phase, reason }) => ({ phase, reason })),
    editablePhases: server.EDITABLE_PHASES.map(({ phase, description }) => ({
      phase,
      description,
    })),
    ownerOnlySettings: server.OWNER_ONLY_SETTINGS.map(({ setting, reason }) => ({
      setting,
      reason,
    })),
  },
};

describe('the mirror holds the same lists as the server', () => {
  it('names the same zone, Terraform phases, editable phases, owner-only settings and prefixes', () => {
    expect(ZONE_APEX).toBe(server.ZONE_APEX);
    expect(PROTECTED_PHASES.map((item) => item.phase)).toEqual(
      server.PROTECTED_PHASES.map((item) => item.phase)
    );
    expect(EDITABLE_PHASES).toEqual(server.EDITABLE_PHASES);
    expect(OWNER_ONLY_SETTINGS.map((item) => item.setting)).toEqual(
      server.OWNER_ONLY_SETTINGS.map((item) => item.setting)
    );
    expect(PROTECTED_DNS_PREFIXES.map((item) => item.prefix)).toEqual(
      server.PROTECTED_DNS_PREFIXES.map((item) => item.prefix)
    );
  });

  it('uses the same sentences and marker', () => {
    expect(READ_ONLY_PHASE_REASON).toBe(server.READ_ONLY_PHASE_REASON);
    expect(APEX_WILDCARD_REASON).toBe(server.APEX_WILDCARD_REASON);
    expect(REDACTED_VALUE).toBe(server.REDACTED_VALUE);
  });

  it('gives each Terraform phase a reason of its own', () => {
    for (const item of PROTECTED_PHASES) expect(item.reason).toMatch(/\w.{30,}/);
  });
});

describe('the DNS lock matches the server’s check exactly', () => {
  const NAMES = [
    '@',
    'www',
    'WWW.',
    'blog',
    'shop.blog',
    'api-azure',
    'asuid.api-azure',
    'x.api-azure',
    'docs2',
    'lab',
    'labs',
    'x.lab',
    'a.b.coder.lab',
    '_acme-challenge',
    '_acme-challenge.blog',
    '_acme-challenge-2.blog',
    '_cf-custom-hostname.go',
    'www.go',
    '*',
    '*.blog',
    '*.www',
    '*.api-azure',
    '*._acme-challenge',
    '*.lab',
    '*.x.lab',
    '*.docs',
    '*.notes',
    `*.${server.ZONE_APEX}`,
    `notes.${server.ZONE_APEX}`,
    `podcast.${server.ZONE_APEX}`,
  ];

  it.each(NAMES)('%s', (name) => {
    expect(dnsNameLock(name, { status: SERVER_STATUS })).toBe(server.dnsNameProtection(name));
  });

  it('holds before the status is read, for the certificate check and the zone wildcard', () => {
    expect(dnsNameLock('_acme-challenge.blog')).toBe(PROTECTED_DNS_PREFIXES[0].reason);
    expect(dnsNameLock('*')).toBe(APEX_WILDCARD_REASON);
    expect(protectedPrefixList(null).map((item) => item.prefix)).toEqual(['_acme-challenge']);
  });
});

describe('the phase lock matches the server’s allow-list', () => {
  const PHASES = [
    ...server.EDITABLE_PHASES.map((item) => item.phase),
    ...server.PROTECTED_PHASES.map((item) => item.phase),
    'http_request_origin',
    'http_request_cache_settings',
    'http_request_cloud_connector',
    'http_request_snippets',
    'http_request_firewall_managed',
    'ddos_l7',
    'http_request_new_kind',
  ];

  it.each(PHASES)('%s', (phase) => {
    expect(phaseLock(phase, { status: SERVER_STATUS })).toBe(server.phaseProtection(phase));
    expect(isEditablePhase(phase, SERVER_STATUS)).toBe(server.isEditablePhase(phase));
  });

  it('lists the editable phases from the status, or the mirror before it is read', () => {
    expect(editablePhaseList(SERVER_STATUS).map((item) => item.phase)).toEqual(
      server.EDITABLE_PHASES.map((item) => item.phase)
    );
    expect(editablePhaseList(null)).toHaveLength(6);
    expect(isEditablePhase('http_ratelimit')).toBe(true);
  });
});

describe('owner-only settings and hidden values', () => {
  it('reads the server’s reason from the status, and the mirror’s before it', () => {
    expect(ownerOnlyReason('ssl', SERVER_STATUS)).toBe(server.ownerOnlySettingReason('ssl'));
    expect(ownerOnlyReason('SSL')).toMatch(/Only you change this one/);
    expect(ownerOnlyReason('brotli', SERVER_STATUS)).toBeNull();
  });

  it('finds a hidden value anywhere in a list of rules', () => {
    const rules = [
      {
        action_parameters: {
          headers: { 'x-api-key': { operation: 'set', value: REDACTED_VALUE } },
        },
      },
    ];
    expect(holdsHiddenValue(rules)).toBe(true);
    expect(holdsHiddenValue([{ expression: 'true', action: 'block' }])).toBe(false);
    expect(holdsHiddenValue(null)).toBe(false);
  });
});

describe('the managed zones (#1911)', () => {
  /** The status answer for a zone, as the server builds it from its own lists. */
  const statusFor = (zone) => ({
    zone: { name: zone.name },
    managed: { name: zone.name, role: zone.role },
    protected: {
      dnsNames: zone.dnsNames.map(({ name, reason }) => ({ name, reason })),
      dnsPrefixes: zone.dnsPrefixes.map(({ prefix, reason }) => ({ prefix, reason })),
      phases: zone.phases.map(({ phase, reason }) => ({ phase, reason })),
      wildcardReason: zone.wildcardReason,
    },
  });

  it('names the same zones as the server, in its order, the site’s first', () => {
    expect(MANAGED_ZONE_NAMES).toEqual(server.MANAGED_ZONES.map((zone) => zone.name));
    expect(DEFAULT_ZONE).toBe(server.SITE_ZONE);
  });

  it('keeps no copy of a zone’s role or reasons: those come from the status answer', () => {
    for (const zone of server.MANAGED_ZONES) {
      expect(JSON.stringify(MANAGED_ZONE_NAMES)).not.toContain(zone.role);
    }
  });

  it('reads a zone from an address in any letter case, and the site’s for anything else', () => {
    expect(resolveZone('HybridCloudInsights.com')).toBe(server.LAB_ZONE);
    for (const value of [null, '', 'example.com', `${server.LAB_ZONE}.`, 'constructor']) {
      expect(resolveZone(value), String(value)).toBe(server.SITE_ZONE);
    }
  });

  const LAB_NAMES = [
    '@',
    'www',
    'note',
    '_acme-challenge',
    '_acme-challenge.lab',
    '*._acme-challenge.lab',
    '*',
    '*.lab',
    '*.x.lab',
    '*.foo',
    '*.www',
    'labs',
    'lab',
    'x.lab',
    'a.b.lab',
    '_atproto',
    '_dmarc',
    '_domainkey',
    '_foo.www',
    's1._domainkey',
    'www._x',
    'a_b',
    'www.',
    `x.${server.LAB_ZONE}`,
  ];
  it.each(LAB_NAMES)('locks %s in the lab zone exactly as the server does', (name) => {
    const lab = server.managedZone(server.LAB_ZONE);
    expect(dnsNameLock(name, { status: statusFor(lab) })).toBe(
      server.dnsNameProtection(name, lab.name)
    );
  });

  it('locks the phases exactly as the server does in each zone, and lists no Terraform phase in the lab zone', () => {
    for (const zone of server.MANAGED_ZONES) {
      const status = {
        ...statusFor(zone),
        protected: {
          ...statusFor(zone).protected,
          editablePhases: SERVER_STATUS.protected.editablePhases,
        },
      };
      for (const phase of [
        'http_request_late_transform',
        'http_ratelimit',
        'http_request_origin',
      ]) {
        expect(phaseLock(phase, { status }), `${zone.name} ${phase}`).toBe(
          server.phaseProtection(phase, zone.name)
        );
      }
    }
    expect(protectedPhaseList(statusFor(server.managedZone(server.LAB_ZONE)))).toEqual([]);
    expect(protectedPhaseList(null).map((item) => item.phase)).toEqual([
      'http_request_late_transform',
    ]);
  });
});

describe('a wildcard over a locked name, in the site’s zone too (#1911 review F1)', () => {
  it.each([
    '*.go',
    '*.api-azure',
    '*.coder.lab',
    '*.lab',
    '*.x.coder.lab',
    '*.blog',
    '*.shop.blog',
  ])('%s matches the server', (name) => {
    expect(dnsNameLock(name, { status: SERVER_STATUS })).toBe(server.dnsNameProtection(name));
  });
});

describe('trailing dots and names from the other zone match the server (#1911 review R4)', () => {
  const SITE = server.SITE_ZONE;
  const LAB = server.LAB_ZONE;
  const NAMES = [
    'www.',
    'www..',
    `${SITE}.`,
    `${SITE}..`,
    `x.${SITE}`,
    `X.${SITE}...`,
    LAB,
    `${LAB}.`,
    `_dmarc.${LAB}..`,
    `x.${LAB}`,
    `x${SITE}`,
    'blog',
    '@',
  ];

  it.each(NAMES)('%s: the other zone, in each zone', (name) => {
    for (const zone of [SITE, LAB]) {
      expect(otherManagedZone(name, zone), zone).toBe(server.otherManagedZone(name, zone));
    }
  });

  it.each(NAMES.filter((name) => !name.includes(LAB)))(
    '%s: the lock in the site’s zone',
    (name) => {
      expect(dnsNameLock(name, { status: SERVER_STATUS })).toBe(server.dnsNameProtection(name));
    }
  );
});

/**
 * jobs.roles.test.js — the jobs platform is a second door onto every pipeline
 * it wraps, and this suite is what keeps that door's lock matched to the
 * first one's.
 *
 * T-701: `registerJobType` used to default `spec.role` to 'editor'. Every one
 * of the eight registered types omitted the field, so every one inherited
 * editor — including `publish-content`, whose worker calls
 * `processPublishContent(…, markLive: true)` directly. That function is
 * guard-free by design because the role check lives in the HTTP wrapper
 * (`POST /api/publishContent`, publisher). The result was that an
 * editor-level token could publish live by enqueuing a job.
 *
 * Two properties are asserted here rather than one, because fixing only the
 * publish type would leave the mechanism that produced it intact:
 *   1. a type cannot register without an explicit, valid role; and
 *   2. `publish-content` is a publisher, matching its HTTP twin.
 */
import { describe, it, expect } from 'vitest';
import { registerJobType, listJobTypes } from './jobs.js';
import { ROLE_NAMES, roleLevel } from './auth/roles.js';

// Importing the registration modules populates the process-wide registry.
import '../functions/cloud-tools-jobs.js';
import '../functions/cosmos-export.js';
import '../functions/forge-jobs.js';
import '../functions/inspect-jobs.js';
import '../functions/interviews-jobs.js';
import '../functions/listen-and-learn-jobs.js';
import '../functions/podcast-jobs.js';
import '../functions/publish-jobs.js';
import '../functions/rss-jobs.js';
import '../functions/search-console-http.js';

const worker = async () => ({});

describe('registerJobType role requirement', () => {
  it('refuses a type with no role, rather than defaulting to editor', () => {
    expect(() => registerJobType('no-role-type', { worker })).toThrow(/spec\.role must be one of/);
  });

  it('refuses an unknown role name', () => {
    expect(() => registerJobType('bad-role-type', { worker, role: 'administrator' })).toThrow(
      /spec\.role must be one of/
    );
    // The message names the valid set, so the fix is visible from the failure.
    expect(() => registerJobType('bad-role-type2', { worker, role: '' })).toThrow(/publisher/);
  });

  it('accepts every role the hierarchy defines', () => {
    for (const role of ROLE_NAMES) {
      expect(() => registerJobType(`ok-${role.replace(/_/g, '-')}`, { worker, role })).not.toThrow();
    }
  });
});

describe('registered job types', () => {
  const types = listJobTypes().filter((t) => !/^(no|bad|ok)-/.test(t.type));

  it('covers the eight real types and each declares a valid role', () => {
    expect(types.length).toBeGreaterThanOrEqual(8);
    for (const spec of types) {
      expect(ROLE_NAMES, `${spec.type} declares an unknown role`).toContain(spec.role);
      // Nothing real should be enqueueable below editor.
      expect(roleLevel(spec.role), `${spec.type} is below editor`).toBeGreaterThanOrEqual(
        roleLevel('editor')
      );
    }
  });

  it('gates the three interview jobs at editor, matching the cms/interviews routes that queue them (ADR 0040)', () => {
    for (const type of ['interview-fetch-audio', 'interview-transcribe', 'interview-draft']) {
      const spec = types.find((t) => t.type === type);
      expect(spec, type).toBeDefined();
      expect(spec.role, type).toBe('editor');
      // Two short ids, or an id and a URL under 800 characters: never a transcript.
      expect(spec.maxPayloadBytes, type).toBeLessThanOrEqual(1024);
    }
    // Under the 30-minute Flex Consumption function timeout, with the sweeper's grace in mind.
    expect(types.find((t) => t.type === 'interview-transcribe').timeoutMs).toBe(25 * 60 * 1000);
  });

  it('gates sync-search-console at editor, matching POST cms/search-console/run that queues it (#1612)', () => {
    const spec = types.find((t) => t.type === 'sync-search-console');
    expect(spec).toBeDefined();
    expect(spec.role).toBe('editor');
    // No payload: the run reads its settings, never the caller's text.
    expect(spec.maxPayloadBytes).toBeLessThanOrEqual(64);
  });

  it('gates publish-content at publisher, matching POST /api/publishContent', () => {
    const publish = types.find((t) => t.type === 'publish-content');
    expect(publish).toBeDefined();
    expect(publish.role).toBe('publisher');
    // The assertion that actually matters: enqueuing must not be a cheaper
    // route to a live publish than the HTTP endpoint is.
    expect(roleLevel(publish.role)).toBe(roleLevel('publisher'));
  });
});

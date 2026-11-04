/**
 * The Labs Hub's pure helpers (#577).
 *
 * `fleetState` is the one worth the file. It names three states where the page
 * previously computed two-and-a-half inline, and the middle one is the point:
 * an agent that HAS heartbeated and stopped is a different problem from one
 * that never connected, and the Agents tab offers a different fix for each.
 * Collapsing them sent an operator to reinstall something already installed.
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_ID_PATTERN,
  OBJECT_ID_PATTERN,
  STATUS_STYLES,
  fleetState,
  fleetStatusWord,
  formatDuration,
  formatTime,
  labStatusInfo,
  registrationToast,
  validateAgentRegistration,
} from './labsView';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const online = (id) => ({ id, agentId: id, lastSeenAt: new Date(NOW - 5_000).toISOString() });
const stale = (id) => ({ id, agentId: id, lastSeenAt: new Date(NOW - 600_000).toISOString() });

describe('fleetState', () => {
  it('is online when at least one agent has heartbeated recently', () => {
    const fleet = fleetState([online('a1'), stale('a2')], NOW);
    expect(fleet.state).toBe('online');
    expect(fleet.online.map((a) => a.agentId)).toEqual(['a1']);
    expect(fleet.label).toBe('1 agent(s) connected');
  });

  it('is stale when agents exist but none is reachable', () => {
    // The distinction the Agents tab is built on: this is installed and
    // stopped, so the fix is on the box, not another install.
    const fleet = fleetState([stale('a1')], NOW);
    expect(fleet.state).toBe('stale');
    expect(fleet.online).toEqual([]);
    expect(fleet.label).toMatch(/registered but offline/i);
  });

  it('is none when nothing has ever connected', () => {
    const fleet = fleetState([], NOW);
    expect(fleet.state).toBe('none');
    expect(fleet.label).toMatch(/No agent connected yet/i);
  });
});

describe('formatDuration', () => {
  it('is a dash until a job has both ends', () => {
    expect(formatDuration({})).toBe('—');
    expect(formatDuration({ createdAt: '2026-09-16T12:00:00Z' })).toBe('—');
  });

  it('measures from claimedAt when there is one, else createdAt', () => {
    // The queue wait is not the run, so a job that sat queued for an hour and
    // ran for two seconds is a two-second job.
    const job = {
      createdAt: '2026-09-16T11:00:00Z',
      claimedAt: '2026-09-16T12:00:00Z',
      finishedAt: '2026-09-16T12:00:02Z',
    };
    expect(formatDuration(job)).toBe('2.0s');
    expect(formatDuration({ createdAt: job.claimedAt, finishedAt: job.finishedAt })).toBe('2.0s');
  });

  it('switches to minutes past sixty seconds', () => {
    expect(
      formatDuration({ createdAt: '2026-09-16T12:00:00Z', finishedAt: '2026-09-16T12:01:30Z' })
    ).toBe('2m 30s');
  });

  it('refuses a finish before its start rather than reporting a negative', () => {
    expect(
      formatDuration({ createdAt: '2026-09-16T12:00:00Z', finishedAt: '2026-09-16T11:00:00Z' })
    ).toBe('—');
  });
});

describe('formatTime', () => {
  it('is a dash for nothing, rather than "Invalid Date"', () => {
    expect(formatTime(null)).toBe('—');
    expect(formatTime(undefined)).toBe('—');
    expect(formatTime('')).toBe('—');
  });
});

describe('validateAgentRegistration (#740)', () => {
  const OID = '99999999-5b4a-4938-8271-605f4e3d2c1b';
  const ok = { agentId: 'vps-hostinger-01', oid: OID, jobTypes: ['shell-echo'] };

  it('passes what the API accepts, including an upper-case GUID it lower-cases', () => {
    expect(validateAgentRegistration(ok)).toBeNull();
    expect(validateAgentRegistration({ ...ok, oid: OID.toUpperCase() })).toBeNull();
  });

  it.each([
    ['capitals in the agent id', { agentId: 'VPS-01' }, /certificate CN/],
    ['a leading hyphen', { agentId: '-vps' }, /certificate CN/],
    ['a 64-character agent id', { agentId: 'a'.repeat(64) }, /certificate CN/],
    ['an empty agent id', { agentId: '' }, /certificate CN/],
    ['a GUID without hyphens', { oid: OID.replace(/-/g, '') }, /GUID/],
    ['a GUID in braces', { oid: `{${OID}}` }, /GUID/],
    ['no job type', { jobTypes: [] }, /at least one job type/],
  ])('refuses %s', (_label, over, message) => {
    expect(validateAgentRegistration({ ...ok, ...over })).toMatch(message);
  });

  it('holds the same patterns as the API, so the form never refuses what the API takes', () => {
    // Mirrors functions/src/lib/labs/agent-registry.js. The API re-validates;
    // a looser pattern here would only cost a round trip, a stricter one would
    // make a valid id unregistrable from this page.
    expect(AGENT_ID_PATTERN.source).toBe('^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$');
    expect(OBJECT_ID_PATTERN.source).toBe(
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    );
    expect(OBJECT_ID_PATTERN.flags).toBe('i');
  });
});

describe('registrationToast (#740)', () => {
  const agent = { agentId: 'vps-hostinger-01', oid: '99999999-5b4a-4938-8271-605f4e3d2c1b' };

  it('names what happened: registered, updated, or nothing to change', () => {
    expect(
      registrationToast({ created: true, changed: true, agent: { ...agent, active: true } }).title
    ).toBe('Agent registered');
    expect(
      registrationToast({ created: false, changed: true, agent: { ...agent, active: true } })
    ).toEqual({
      title: 'Agent updated',
      description: `vps-hostinger-01 is now bound to ${agent.oid}.`,
    });
    expect(
      registrationToast({ created: false, changed: false, agent: { ...agent, active: true } }).title
    ).toBe('Already registered');
  });

  it('says so when the agent is still deactivated, because a registration never reactivates it', () => {
    for (const changed of [true, false]) {
      expect(
        registrationToast({ changed, agent: { ...agent, active: false } }).description
      ).toMatch(/still deactivated/);
    }
  });
});

describe('the concept statuses (ADR 0033)', () => {
  it('styles exactly the statuses the runner writes: no running', () => {
    // JOB_STATUSES in functions/src/lib/labs.js, which the snapshot sends.
    expect(Object.keys(STATUS_STYLES).sort()).toEqual(
      ['queued', 'claimed', 'succeeded', 'failed', 'timeout', 'cancelled'].sort()
    );
  });

  it('reads the fleet in the shared vocabulary', () => {
    expect(fleetStatusWord(fleetState([online('a1')], NOW))).toBe('healthy');
    expect(fleetStatusWord(fleetState([stale('a1')], NOW))).toBe('degraded');
    expect(fleetStatusWord(fleetState([], NOW))).toBe('offline');
  });

  it('says an available lab is listed and a held one since when, and why', () => {
    expect(labStatusInfo({ status: 'available' })).toMatchObject({ id: 'available', tone: 'ok' });
    const held = labStatusInfo({
      status: 'coming',
      comingSince: '2026-10-03',
      comingReason: 'the image lacks helm',
    });
    expect(held).toMatchObject({ id: 'coming', tone: 'warn' });
    expect(held.help).toContain('2026-10-03');
    expect(held.help).toContain('the image lacks helm');
  });
});

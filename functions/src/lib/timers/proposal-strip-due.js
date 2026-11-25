/**
 * proposal-strip-due.js — finding the talk proposals that are due to be
 * stripped, and stripping one under its ETag, for the yearly clean-up in
 * proposal-strip.js (which says why and exports dueProposalsQuery again).
 */
import {
  ACCEPTED_STATUS,
  callCycleYear,
  isCycleOver,
  isStripDue,
  latestFinishedCycle,
  stripProposal,
} from '../developer-api/proposal-cycle.js';
import { CFS_CONTAINER } from '../developer-api/cfs.js';

/** How many times one proposal is read and written before it is left for the next run. */
const WRITE_ATTEMPTS = 2;

/** The proposals of one event that are not accepted and not yet stripped; with `sentBefore`, only those sent before it. */
export function dueProposalsQuery({ limit, sentBefore = null }) {
  const clauses = [
    "c.docType = 'cfs-submission'",
    'c.eventId = @eventId',
    `(NOT IS_DEFINED(c.status) OR c.status != '${ACCEPTED_STATUS}')`,
    '(NOT IS_DEFINED(c.strippedAt) OR IS_NULL(c.strippedAt))',
  ];
  if (sentBefore) clauses.push('c.submittedAt < @sentBefore');
  return `SELECT TOP ${limit} c.id, c.eventId, c.docType, c.status, c.submittedAt, c.strippedAt FROM c WHERE ${clauses.join(' AND ')}`;
}

/** The due proposals of one call, at most `limit`, judged again in memory on what came back. */
export async function findDue({ store, nowMs }, call, limit) {
  // A call that closed decides the year for all its proposals: none are due
  // until that year is over. One that never closed decides nothing, so only
  // proposals sent in a finished year can be due.
  const callYear = callCycleYear(call, nowMs);
  if (callYear !== null && !isCycleOver(callYear, nowMs)) return [];
  const sentBefore = callYear === null ? new Date(Date.UTC(latestFinishedCycle(nowMs) + 1, 0, 1)).toISOString() : null;
  const parameters = [{ name: '@eventId', value: call.eventId }];
  if (sentBefore) parameters.push({ name: '@sentBefore', value: sentBefore });
  const rows = await store.queryDocs(CFS_CONTAINER, dueProposalsQuery({ limit, sentBefore }), parameters, {
    partitionKey: call.eventId,
  });
  return (rows || []).filter((row) => isStripDue(row, call, nowMs)).slice(0, limit);
}

/**
 * Strip one proposal, from a fresh read, under its ETag.
 * @returns {Promise<'stripped' | 'skipped' | 'raced'>} `skipped`: it is gone, or no longer due (accepted meanwhile, or already stripped)
 */
export async function stripOne({ store, nowMs, nowIso }, call, row) {
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const fresh = await store.readDoc(CFS_CONTAINER, row.id, call.eventId);
    if (!fresh || fresh.eventId !== call.eventId || !isStripDue(fresh, call, nowMs)) return 'skipped';
    try {
      await store.replaceDocIfMatch(CFS_CONTAINER, stripProposal(fresh, nowIso), { partitionKey: call.eventId });
      return 'stripped';
    } catch (error) {
      if (error?.code === 404) return 'skipped';
      if (error?.code !== 412) throw error;
    }
  }
  return 'raced';
}


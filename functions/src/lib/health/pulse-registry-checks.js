/**
 * pulse-registry-checks.js — the health pulse's checks from the registries
 * (pulse-checks.js has the snapshot checks and the header that explains
 * them): lab agents by their heartbeat, MCP servers by their last tool sync,
 * and AI providers by their last recorded test. pulse-checks.js re-exports
 * these, so callers keep one import.
 */
import { classifyFailure } from './status-model.js';
import { isAgentOnline } from '../labs.js';
import { DAY_MS, ago, plural, result, toMillis } from './pulse-words.js';

/** The weekly AI probe, plus a day: a recorded test older than this is stale. */
export const AI_TEST_STALE_AFTER_MS = 8 * DAY_MS;

const latestOf = (values) =>
  values.filter((value) => Number.isFinite(toMillis(value))).sort((a, b) => toMillis(a) - toMillis(b)).at(-1);

/**
 * Lab agents by their heartbeat: online while the last beat is under 90 s old
 * and it did not announce a shutdown, and the agent is not deactivated
 * (labs.js isAgentOnline, the rule the Labs page and the public door use).
 * `agents` are `{ lastSeenAt, online }` — the pulse computes `online` from
 * `lastSeenAt`; the page reads it from getLabsSnapshot, which does the same.
 */
export function labAgentsVerdict(agents, now) {
  if (agents.length === 0) return result('unknown', 'No lab agent has registered yet.');
  const online = agents.filter((agent) => agent.online).length;
  const latest = latestOf(agents.map((agent) => agent.lastSeenAt));
  const seen = latest ? ` Last heartbeat ${ago(latest, now) ?? 'at an unknown time'}.` : '';
  if (online === agents.length) return result('healthy', `${plural(agents.length, 'agent')} online.${seen}`);
  if (online === 0) return result('offline', `All ${agents.length} agents are offline.${seen}`);
  return result('degraded', `${online} of ${agents.length} agents online.${seen}`);
}

/** lab_agents rows as the verdict reads them. */
export const labAgentsFromRows = (rows, now) =>
  (rows || []).map((row) => ({
    lastSeenAt: row.lastSeenAt ?? null,
    // The whole row: the rule reads status and active as well as lastSeenAt
    // (#1009, #1018), so a stopping or deactivated agent is not online.
    online: isAgentOnline(row, now),
  }));

const mcpLine = (server) => {
  const name = server.id ?? server.name ?? 'server';
  if (server.status === 'connected') return `${name}: connected`;
  if (server.status === 'error') return `${name}: ${server.lastError || 'failed'}`;
  return `${name}: not synced yet`;
};

/**
 * MCP servers by their last tool sync (lib/ai/mcp.js writes `status`,
 * `lastTested` and `lastError` on every sync). Only servers switched on count:
 * the MCP route refuses a disabled one before it is ever called.
 */
export function mcpServersVerdict(servers, now) {
  const enabled = (servers || []).filter((server) => server?.enabled === true);
  if (enabled.length === 0) return result('unknown', 'No MCP server is enabled on the AI Engine page.');
  const ok = enabled.filter((server) => server.status === 'connected');
  const failing = enabled.filter((server) => server.status === 'error');
  const latest = latestOf(enabled.map((server) => server.lastTested));
  const when = latest ? ` Newest sync ${ago(latest, now) ?? 'at an unknown time'}.` : '';
  const detail = enabled.map(mcpLine).join('\n');
  if (ok.length === enabled.length) {
    return result('healthy', `${plural(ok.length, 'enabled MCP server')} answered their last tool sync.${when}`, {
      detail,
    });
  }
  if (ok.length === 0 && failing.length === 0) {
    return result('unknown', `${plural(enabled.length, 'enabled MCP server')}, none synced yet.`, { detail });
  }
  if (ok.length === 0) {
    return result(
      classifyFailure(failing[0].lastError),
      `None of the ${enabled.length} enabled MCP servers answered its last tool sync.${when}`,
      { detail }
    );
  }
  return result(
    'degraded',
    `${ok.length} of ${enabled.length} enabled MCP servers answered their last tool sync.${when}`,
    { detail }
  );
}

const aiLine = (provider) =>
  provider.status === 'connected'
    ? `${provider.id}: connected${Number.isFinite(provider.latencyMs) ? ` in ${provider.latencyMs} ms` : ''}`
    : `${provider.id}: ${provider.lastTestError || (provider.lastTested ? 'failed' : 'not tested yet')}`;

/**
 * AI providers by their last RECORDED test — the AI Engine's Test button or
 * the weekly probe, both of which write `status` and `lastTested` onto the
 * provider document. The pulse spends no model call: asking every provider a
 * word every five minutes is the browser Test's job, on demand. A newest test
 * older than the weekly probe plus a day is stale, and said to be.
 */
export function aiProvidersVerdict(providers, now) {
  const enabled = (providers || []).filter((provider) => provider?.enabled !== false);
  if (enabled.length === 0) return result('critical', 'No AI provider is enabled on the AI Engine page.');
  const latest = latestOf(enabled.map((provider) => provider.lastTested));
  if (!latest) {
    return result(
      'unknown',
      `${plural(enabled.length, 'enabled provider')}, none with a recorded test yet. The AI Engine's Test, or the weekly probe, records one.`
    );
  }
  const newest = enabled.find((provider) => provider.lastTested === latest);
  const by = newest?.lastTestedBy === 'probe' ? 'the weekly probe' : 'a Test button';
  const note = ` Newest recorded test: ${newest?.id ?? 'a provider'} ${ago(latest, now)} by ${by}.`;
  const detail = enabled.map(aiLine).join('\n');
  if (now - toMillis(latest) > AI_TEST_STALE_AFTER_MS) {
    return result('unknown', `No provider has been tested for over eight days.${note}`, { detail });
  }
  return recordedTestsVerdict(enabled, note, detail);
}

/** Recent recorded tests: healthy when every provider passed, degraded when some did, a failure when none. */
function recordedTestsVerdict(enabled, note, detail) {
  const ok = enabled.filter((provider) => provider.status === 'connected').length;
  if (ok === enabled.length) {
    return result('healthy', `${plural(ok, 'enabled provider')} passed their last recorded test.${note}`, {
      detail,
    });
  }
  if (ok === 0) {
    const firstError = enabled.find((provider) => provider.lastTestError)?.lastTestError;
    return result(
      classifyFailure(firstError),
      `None of the ${enabled.length} enabled providers passed their last recorded test.${note}`,
      { detail }
    );
  }
  return result(
    'degraded',
    `${ok} of ${enabled.length} enabled providers passed their last recorded test.${note}`,
    { detail }
  );
}

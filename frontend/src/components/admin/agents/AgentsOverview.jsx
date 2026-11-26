/**
 * The Agents page's Overview tab (#1905): what an agent key is, in plain
 * words, and one row per key the site can hold (ai-engine/agentKeys.js):
 * its name, its job in one sentence, how many of its switches are on, the
 * key's state, and a link to its own tab.
 *
 * Each row reads that key's own record (`cms/agent-content/key`, the same
 * read its tab makes, at editor), all at once. One key that cannot be read
 * says so on its own row and never blanks the others. Nothing here writes:
 * making, switching, rotating and revoking a key happen on its own tab.
 */
import React from 'react';
import { Link } from 'react-router';
import { Bot, KeyRound, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import useGuardedLoad from '@/components/admin/shared/useGuardedLoad';
import { useAuthReady } from '@/hooks/useAuthReady';
import { readKodaKey } from '@/lib/agentContent';
import { AGENT_KEY_TABS } from '@/components/admin/ai-engine/agentKeys';
import {
  agentWords,
  capabilityRows,
  keyState,
  whenText,
} from '@/components/admin/ai-engine/kodaView';
import { AGENT_KEYS_RUNBOOK_URL } from '@/components/admin/integrations/ListedCredential';
import { tabHref } from './tabs';

const TONE = {
  ok: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800',
  danger:
    'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800',
  muted: 'bg-muted text-muted-foreground border-border',
};

const TH = 'pb-2 pr-4 text-left text-xs font-medium text-muted-foreground';
const TD = 'py-3 pr-4 align-top border-t border-border/60 text-sm';

/**
 * Every key's record, read together. A key whose read failed carries its
 * message instead of its data, so the row can say so on its own.
 */
async function readEveryKey() {
  const answers = await Promise.allSettled(
    // Koda's read names no agent (agentKeyRoute), the others add `?agent=`.
    AGENT_KEY_TABS.map((agent) => readKodaKey(agent.id))
  );
  return Object.fromEntries(
    AGENT_KEY_TABS.map((agent, index) => {
      const answer = answers[index];
      return [
        agent.id,
        answer.status === 'fulfilled'
          ? { data: answer.value }
          : { error: answer.reason?.message || 'This key could not be read.' },
      ];
    })
  );
}

const describeError = (err) => err?.message || 'The agent keys could not be read.';

/**
 * What one row shows about a key: its state and how many switches are on.
 * Switches mean nothing until a key exists, so a key not made yet says that
 * instead of a count.
 *
 * @param {object} agent the key's entry in AGENT_KEY_TABS
 * @param {{ data?: object, error?: string } | undefined} read
 */
export function keySummary(agent, read) {
  if (!read) return { status: 'reading' };
  if (read.error) return { status: 'error', error: read.error };
  const data = read.data || {};
  const key = data.key || {};
  const words = agentWords(agent);
  const state = keyState(key, words);
  const rows = capabilityRows(
    data.capabilities || [],
    key.capabilities || {},
    words.switchesOnWhenMade
  );
  const on = rows.filter((row) => row.on).length;
  return {
    status: 'read',
    state,
    switches: key.present ? `${on} of ${rows.length} on` : 'None until a key is made',
    lastUsed: key.present && key.lastUsedAt ? whenText(key.lastUsedAt) : null,
  };
}

function KeyCell({ summary }) {
  if (summary.status === 'reading') {
    return <span className="text-muted-foreground">Reading…</span>;
  }
  if (summary.status === 'error') {
    return <span className="text-destructive">Could not be read: {summary.error}</span>;
  }
  return (
    <span className="flex flex-col items-start gap-1">
      <span
        className={`text-xs font-medium px-2 py-0.5 rounded-full border ${TONE[summary.state.tone]}`}
      >
        {summary.state.label}
      </span>
      {summary.lastUsed && (
        <span className="text-xs text-muted-foreground">Last used {summary.lastUsed}</span>
      )}
    </span>
  );
}

function Explainer() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <KeyRound className="h-5 w-5" aria-hidden="true" />
          What an agent key is
        </CardTitle>
        <CardDescription>
          An agent is a program that does work on this site for you, such as drafting a post or
          checking the site’s Cloudflare settings. It signs in with an agent key: a long password
          the site makes for that one agent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="list-disc pl-5 space-y-1.5 text-sm text-muted-foreground">
          <li>
            The key is shown once, when it is made, for you to paste into the agent’s own secure
            field. After that the site keeps only a fingerprint of it, so nobody can read it back.
          </li>
          <li>
            Each key has switches. A switch opens one group of the site’s routes (reading drafts,
            say, or changing DNS records). A key reaches nothing that is switched off, and a new key
            starts with only what its job needs.
          </li>
          <li>
            No agent key can publish anything, or delete a DNS record, a ruleset or any content,
            whatever is switched on; replacing a phase’s Cloudflare rules does remove the ones left
            out. Every change it makes, and every call it is refused, goes in the audit log; what it
            only reads is not recorded.
          </li>
          <li>
            Rotating a key makes a new one and stops the old one on its next request. Revoking
            switches the key off until you make a new one. Both are on the key’s own tab and need
            the super admin role.
          </li>
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          The full list of what each switch opens, and the steps for making and replacing a key, are
          in the{' '}
          <a
            href={AGENT_KEYS_RUNBOOK_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            agent key runbook
          </a>
          .
        </p>
      </CardContent>
    </Card>
  );
}

export default function AgentsOverview() {
  const { authReady } = useAuthReady();
  // Module-level loader and describer: a new one each render would start a
  // new read each render.
  const { data, loaded, error, refresh } = useGuardedLoad(readEveryKey, {
    enabled: authReady,
    empty: null,
    describeError,
  });

  return (
    <div className="space-y-6">
      <Explainer />
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Bot className="h-5 w-5" aria-hidden="true" />
            The agents
          </CardTitle>
          <CardDescription>
            Every agent key the site can hold. Open an agent’s tab to make its key, change its
            switches, or rotate or revoke it.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {error && (
            <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-destructive">{error}</span>
              <Button size="sm" variant="outline" onClick={refresh}>
                Try again
              </Button>
            </div>
          )}
          <table className="w-full min-w-[36rem]">
            <thead>
              <tr>
                <th scope="col" className={TH}>
                  Agent
                </th>
                <th scope="col" className={TH}>
                  Its job
                </th>
                <th scope="col" className={TH}>
                  Switches
                </th>
                <th scope="col" className={TH}>
                  Key
                </th>
              </tr>
            </thead>
            <tbody>
              {AGENT_KEY_TABS.map((agent) => {
                const summary = keySummary(agent, loaded ? data?.[agent.id] : undefined);
                return (
                  <tr key={agent.id} data-testid={`agent-row-${agent.id}`}>
                    <th scope="row" className={`${TD} text-left font-medium`}>
                      <Link to={tabHref(agent.id)} className="underline underline-offset-2">
                        {agent.displayName}
                      </Link>
                    </th>
                    <td className={`${TD} text-muted-foreground`}>{agent.job}</td>
                    <td className={`${TD} whitespace-nowrap`}>
                      {summary.status === 'read' ? summary.switches : '—'}
                    </td>
                    <td className={TD}>
                      <KeyCell summary={summary} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
            Each key has its own record, switches and audit trail: what one key may do never changes
            what another may.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

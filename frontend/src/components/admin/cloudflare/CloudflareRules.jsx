/**
 * The Cloudflare page's Rules tab (#1905). A rule tells Cloudflare what to
 * do with a request that matches it (add a header, block it, slow it down).
 * Rules are grouped into rulesets, one per phase: the point in handling a
 * request where they run, such as `http_request_late_transform`.
 *
 * Every ruleset in the zone is listed. The zone's own ones (kind `zone`,
 * one per phase) can be opened, and a phase that is not locked can have its
 * whole list of rules replaced, edited as JSON. Cloudflare's managed
 * rulesets are listed only. A LOCKED phase (the origin secret rule, the API
 * rate limit) shows a lock and its reason and offers no edit, and the server
 * refuses a change to it (409).
 *
 * Replacing needs the super admin role (RoleGate), asks first, and its
 * button is disabled while the request is out. Nothing here deletes a
 * ruleset; an empty list of rules is still a replacement the owner confirms.
 */
import React, { useCallback, useState } from 'react';
import { Eye, Loader2, Pencil } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import RoleGate from '@/components/admin/RoleGate';
import ConfirmModal from '@/components/admin/ConfirmModal';
import EmptyState from '@/components/admin/shared/EmptyState';
import {
  readCloudflarePhase,
  readCloudflareRulesets,
  replaceCloudflarePhase,
} from '@/lib/cloudflare';
import {
  LockNote,
  ReadGate,
  TD,
  TH,
  WRITE_REASON,
  useCloudflareRead,
  useCloudflareWrite,
} from './CloudflareParts';
import {
  editableRules,
  entrypointRulesets,
  otherRulesets,
  parseRulesDraft,
  phaseLock,
} from './cloudflareView';

const EMPTY = Object.freeze({ rulesets: [] });

/** One phase, opened: its rules, and the editor when the phase may be changed. */
function PhasePanel({ phase, lock, onClose, onReplaced }) {
  const load = useCallback(() => readCloudflarePhase(phase), [phase]);
  const read = useCloudflareRead(load, null);
  const { busyIds, run } = useCloudflareWrite(read.refresh);
  const [draft, setDraft] = useState(null); // null: viewing; text: editing
  const [confirming, setConfirming] = useState(false);
  const ruleset = read.data?.ruleset ?? null;
  const busy = busyIds.has(phase);

  let problem = '';
  let rules = null;
  if (draft !== null) {
    try {
      rules = parseRulesDraft(draft);
    } catch (err) {
      problem = err.message;
    }
  }

  const replace = async () => {
    const done = await run(
      phase,
      () =>
        replaceCloudflarePhase(phase, {
          rules,
          ...(ruleset?.description ? { description: ruleset.description } : {}),
        }),
      `The rules of ${phase} are replaced.`
    );
    setConfirming(false);
    if (done) {
      setDraft(null);
      onReplaced?.();
    }
  };

  return (
    <Card data-testid={`phase-${phase}`}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="text-lg">
              <code>{phase}</code>
            </CardTitle>
            <CardDescription>
              {ruleset?.name || 'No ruleset in this phase yet.'}
              {ruleset?.description ? ` ${ruleset.description}` : ''}
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <ReadGate read={read} label="This phase’s rules">
          {lock && <LockNote reason={lock} />}
          {draft === null ? (
            <>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(ruleset?.rules ?? [], null, 2)}
              </pre>
              {!lock && (
                <RoleGate minRole="super_admin" reason={WRITE_REASON}>
                  <Button
                    size="sm"
                    onClick={() => setDraft(JSON.stringify(editableRules(ruleset), null, 2))}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                    Edit these rules
                  </Button>
                </RoleGate>
              )}
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                This replaces the whole list of rules in this phase with what is below. Each rule
                needs an <code>expression</code> (which requests it matches) and an{' '}
                <code>action</code>. Keep a rule’s <code>id</code> to change it in place; a rule
                left out is removed from the phase.
              </p>
              <Textarea
                aria-label={`Rules for ${phase}`}
                className="font-mono text-xs min-h-[16rem]"
                value={draft}
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
              />
              {problem && (
                <p role="alert" className="text-sm text-destructive">
                  {problem}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <RoleGate minRole="super_admin" reason={WRITE_REASON}>
                  <Button
                    size="sm"
                    disabled={busy || Boolean(problem)}
                    onClick={() => setConfirming(true)}
                  >
                    {busy && (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" aria-hidden="true" />
                    )}
                    Replace the rules
                  </Button>
                </RoleGate>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setDraft(null)}>
                  Cancel
                </Button>
              </div>
            </>
          )}
        </ReadGate>
      </CardContent>
      <ConfirmModal
        open={confirming}
        title={`Replace the rules of ${phase}?`}
        description={`The phase will hold exactly the ${rules?.length ?? 0} rule(s) you wrote, for every visitor, as soon as you confirm. Any rule you left out is removed.`}
        confirmLabel="Replace the rules"
        busy={busy}
        onConfirm={replace}
        onCancel={() => setConfirming(false)}
      />
    </Card>
  );
}

export default function CloudflareRules({ status = null }) {
  const read = useCloudflareRead(readCloudflareRulesets, EMPTY);
  const [open, setOpen] = useState(null);
  const all = read.data?.rulesets ?? [];
  const entrypoints = entrypointRulesets(all);
  const managed = otherRulesets(all);
  const openRuleset = entrypoints.find((ruleset) => ruleset.phase === open) ?? null;

  return (
    <ReadGate read={read} label="The rules">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">The zone’s rules, by phase</CardTitle>
            <CardDescription>
              A phase is the point in handling a request where its rules run. Open one to read its
              rules; a phase that is not locked can have its rules replaced.
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {entrypoints.length === 0 ? (
              <EmptyState compact title="The zone has no rules of its own yet" />
            ) : (
              <table className="w-full min-w-[36rem]">
                <thead>
                  <tr>
                    <th scope="col" className={TH}>
                      Phase
                    </th>
                    <th scope="col" className={TH}>
                      Ruleset
                    </th>
                    <th scope="col" className={TH}>
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entrypoints.map((ruleset) => {
                    const lock = phaseLock(ruleset.phase, { ruleset, status });
                    return (
                      <tr key={ruleset.id} data-testid={`ruleset-${ruleset.phase}`}>
                        <td className={`${TD} font-mono text-xs`}>{ruleset.phase}</td>
                        <td className={TD}>
                          {ruleset.name}
                          {ruleset.description ? (
                            <span className="block text-xs text-muted-foreground">
                              {ruleset.description}
                            </span>
                          ) : null}
                          {lock && <LockNote reason={lock} className="mt-1" />}
                        </td>
                        <td className={`${TD} whitespace-nowrap`}>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setOpen(ruleset.phase)}
                            aria-label={`Open ${ruleset.phase}`}
                          >
                            <Eye className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                            {lock ? 'View' : 'Open'}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {open && (
          <PhasePanel
            key={open}
            phase={open}
            lock={phaseLock(open, { ruleset: openRuleset, status })}
            onClose={() => setOpen(null)}
            onReplaced={read.refresh}
          />
        )}

        {managed.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Rulesets Cloudflare manages</CardTitle>
              <CardDescription>
                Cloudflare writes and updates these itself. They are listed so you know they are
                there; they are not changed from here.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {managed.map((ruleset) => (
                  <li key={ruleset.id}>
                    {ruleset.name}{' '}
                    <span className="text-xs text-muted-foreground">
                      ({ruleset.kind}, <code>{ruleset.phase}</code>)
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </ReadGate>
  );
}

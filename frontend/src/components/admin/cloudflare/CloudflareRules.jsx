/**
 * The Cloudflare page's Rules tab (#1905). A rule tells Cloudflare what to
 * do with a request that matches it (add a header, block it, send it
 * elsewhere). Rules are grouped into rulesets, one per phase: the point in
 * handling a request where they run, such as `http_request_late_transform`.
 *
 * Only six phases can be changed here (the allow-list, EDITABLE_PHASES in
 * cloudflareLocks.js, which mirrors the server). Each is listed with what it
 * does and can be opened even before it holds any rules. Every other phase
 * (the one Terraform writes, and anything that can send or store the site's
 * traffic elsewhere) is read-only: it shows a lock and its reason, its rules
 * are shown as the server answers them (what each matches and does, never
 * what it carries), and the server refuses a change (409).
 *
 * Replacing needs the super admin role (RoleGate), asks first, and its
 * button is disabled while the request is out. It sends the version the
 * phase was read at, and the server refuses it (409, with a sentence shown
 * in the toast) when the phase changed since. An empty list is refused here
 * and on the server, because it would delete every rule in the phase. In the
 * custom security rules and the rate limiting rules, a shorter list removes
 * a rule that protects the site, so the confirmation asks for the phase's
 * name to be typed. A list holding a value
 * the server hid (a secret) is not offered for editing: the secret is not
 * known here, so that phase is changed in the Cloudflare dashboard.
 */
import React, { useCallback, useState } from 'react';
import { Eye, Loader2, Pencil } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  editablePhaseList,
  editableRules,
  entrypointRulesets,
  holdsHiddenValue,
  GUARDED_PHASES,
  needsTypedConfirm,
  otherRulesets,
  parseRulesDraft,
  phaseLock,
} from './cloudflareView';

const EMPTY = Object.freeze({ rulesets: [] });

export const HIDDEN_VALUE_NOTE =
  'A rule here holds a value the site keeps hidden (a secret). It is not known to this page, so this phase is changed in the Cloudflare dashboard.';

/** The draft's rules, or the sentence that stops them. */
function checkDraft(draft) {
  if (draft === null) return { rules: null, problem: '' };
  try {
    return { rules: parseRulesDraft(draft), problem: '' };
  } catch (err) {
    return { rules: null, problem: err.message };
  }
}

/** What the confirmation asks: the sentence, and whether the phase name must be typed. */
function confirmation(phase, currentCount, rules) {
  const count = rules?.length ?? 0;
  const typed = needsTypedConfirm(phase, currentCount, count);
  const removed = currentCount - count;
  const base = `The phase will hold exactly the ${count} rule(s) you wrote, for every visitor, as soon as you confirm. Any rule you left out is removed.`;
  const guarded = GUARDED_PHASES[phase];
  const warning = typed
    ? ` This removes ${removed} ${guarded.rules}, so ${guarded.effect}. Type ${phase} below to confirm.`
    : '';
  return { typed, description: `${base}${warning}` };
}

/** The editor: the text, the problem, and the buttons. */
function RulesEditor({ phase, draft, setDraft, problem, busy, onReplace }) {
  return (
    <>
      <p className="text-sm text-muted-foreground">
        This replaces the whole list of rules in this phase with what is below. Each rule needs an{' '}
        <code>expression</code> (which requests it matches) and an <code>action</code>. Keep a
        rule’s <code>id</code> to change it in place; a rule left out is removed from the phase. An
        empty list is refused: it would delete every rule.
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
          <Button size="sm" disabled={busy || Boolean(problem)} onClick={onReplace}>
            {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" aria-hidden="true" />}
            Replace the rules
          </Button>
        </RoleGate>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setDraft(null)}>
          Cancel
        </Button>
      </div>
    </>
  );
}

/** The rules as read, with the edit button when the phase may be changed and holds no hidden value. */
function RulesView({ ruleset, lock, onEdit }) {
  const rules = ruleset?.rules ?? [];
  const hidden = holdsHiddenValue(rules);
  return (
    <>
      <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
        {JSON.stringify(rules, null, 2)}
      </pre>
      {!lock && hidden && <LockNote reason={HIDDEN_VALUE_NOTE} />}
      {!lock && !hidden && (
        <RoleGate minRole="super_admin" reason={WRITE_REASON}>
          <Button size="sm" onClick={() => onEdit(JSON.stringify(editableRules(ruleset), null, 2))}>
            <Pencil className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            Edit these rules
          </Button>
        </RoleGate>
      )}
    </>
  );
}

/** One phase, opened: its rules, and the editor when the phase may be changed. */
function PhasePanel({ phase, lock, onClose, onReplaced }) {
  const load = useCallback(() => readCloudflarePhase(phase), [phase]);
  const read = useCloudflareRead(load, null);
  const { busyIds, run } = useCloudflareWrite(read.refresh);
  const [draft, setDraft] = useState(null); // null: viewing; text: editing
  const [confirming, setConfirming] = useState(false);
  const [typedName, setTypedName] = useState('');
  const ruleset = read.data?.ruleset ?? null;
  const busy = busyIds.has(phase);
  const { rules, problem } = checkDraft(draft);
  const asked = confirmation(phase, ruleset?.rules?.length ?? 0, rules);

  const replace = async () => {
    const done = await run(
      phase,
      () =>
        replaceCloudflarePhase(phase, {
          rules,
          expectedVersion: read.data?.version ?? ruleset?.version ?? null,
          ...(ruleset?.description ? { description: ruleset.description } : {}),
        }),
      `The rules of ${phase} are replaced.`
    );
    setConfirming(false);
    setTypedName('');
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
            <RulesView ruleset={ruleset} lock={lock} onEdit={setDraft} />
          ) : (
            <RulesEditor
              phase={phase}
              draft={draft}
              setDraft={setDraft}
              problem={problem}
              busy={busy}
              onReplace={() => setConfirming(true)}
            />
          )}
        </ReadGate>
      </CardContent>
      <ConfirmModal
        open={confirming}
        title={`Replace the rules of ${phase}?`}
        description={asked.description}
        preview={
          asked.typed ? (
            <Input
              aria-label="Type the phase name to confirm"
              value={typedName}
              onChange={(event) => setTypedName(event.target.value)}
            />
          ) : undefined
        }
        confirmLabel="Replace the rules"
        confirmDisabled={asked.typed && typedName.trim() !== phase}
        busy={busy}
        onConfirm={replace}
        onCancel={() => {
          setConfirming(false);
          setTypedName('');
        }}
      />
    </Card>
  );
}

/** The phases that can be changed here, with what each does, each openable. */
function EditableCard({ status, onOpen }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">What can be changed here</CardTitle>
        <CardDescription>
          Only these six kinds of rule can be replaced from this page. Every other kind can send or
          store the site’s traffic elsewhere, so it is read-only here and changed in the Cloudflare
          dashboard. These rules still apply to requests to the site’s API, so change them with
          care.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2 text-sm">
          {editablePhaseList(status).map((item) => (
            <li
              key={item.phase}
              className="flex flex-wrap items-start justify-between gap-2"
              data-testid={`editable-${item.phase}`}
            >
              <span>
                <code className="text-xs">{item.phase}</code>
                <span className="block text-muted-foreground">{item.description}</span>
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => onOpen(item.phase)}
                aria-label={`Open ${item.phase} from the list of what can be changed`}
              >
                <Eye className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                Open
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function RulesetRow({ ruleset, status, onOpen }) {
  const lock = phaseLock(ruleset.phase, { ruleset, status });
  return (
    <tr data-testid={`ruleset-${ruleset.phase}`}>
      <td className={`${TD} font-mono text-xs`}>{ruleset.phase}</td>
      <td className={TD}>
        {ruleset.name}
        {ruleset.description ? (
          <span className="block text-xs text-muted-foreground">{ruleset.description}</span>
        ) : null}
        {lock && <LockNote reason={lock} className="mt-1" />}
      </td>
      <td className={`${TD} whitespace-nowrap`}>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onOpen(ruleset.phase)}
          aria-label={`Open ${ruleset.phase}`}
        >
          <Eye className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
          {lock ? 'View' : 'Open'}
        </Button>
      </td>
    </tr>
  );
}

function RulesetsCard({ entrypoints, status, onOpen }) {
  return (
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
              {entrypoints.map((ruleset) => (
                <RulesetRow key={ruleset.id} ruleset={ruleset} status={status} onOpen={onOpen} />
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
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
    <ReadGate read={read} label="The rules" status={status}>
      <div className="space-y-6">
        <EditableCard status={status} onOpen={setOpen} />
        <RulesetsCard entrypoints={entrypoints} status={status} onOpen={setOpen} />

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

/**
 * IssueDetail — one issue open for editing, laid out for the common path:
 * subject (with AI suggestions), preview text and note first, then the action
 * bar, then the section editor beside the email preview.
 *
 * Every edit here is local until Save changes, which PATCHes only what
 * differs. While anything is unsaved, Keep, Approve, Regenerate intro and Send
 * test stay disabled: each acts on the STORED version, so none of them would
 * include the edit, and the intro and keep responses would discard it.
 * Suggest subjects writes nothing and stays available.
 *
 * Nothing in this file reaches subscribers except ApprovalBox's Approve. The
 * test send goes to the reply-to address in settings, chosen by the server.
 *
 * The preview is an iframe with an EMPTY sandbox: the email's HTML is rendered
 * but cannot run script, submit forms or navigate this page.
 */
import React, { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Archive,
  Copy,
  History,
  Loader2,
  MailCheck,
  Plus,
  RotateCcw,
  Sparkles,
  XCircle,
} from 'lucide-react';
import RoleGate from '@/components/admin/RoleGate';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { itemStatus } from '@/components/admin/calendar/calendarModel';
import ApprovalBox from './ApprovalBox';
import ManualBlockDialog from './ManualBlockDialog';
import SectionEditor, {
  addItemToSections,
  sectionsSignature,
  toSectionsPayload,
} from './SectionEditor';
import { formatWhen } from './issueFormat';

export const MAX_PREHEADER = 150;
const SAVE_FIRST = 'Save your changes first';

function StatusWarnings({ issue }) {
  return (
    <>
      {issue.status === 'sending' && (
        <p role="alert" className="text-sm text-destructive">
          This issue was mid-send when something failed. Check Resend&apos;s Broadcasts list before
          doing anything: if it is there, it went out. Clear stuck send removes this state.
        </p>
      )}
      {issue.lastError && issue.status === 'draft' && (
        <p role="alert" className="text-sm text-destructive">
          The last approval was refused: {issue.lastError}
        </p>
      )}
      {issue.introError && (
        <p className="text-sm text-muted-foreground">
          The AI intro was not written ({issue.introError}). Add a note below if you want one.
        </p>
      )}
    </>
  );
}

/** Whole seconds until `until` (ms since epoch), ticking once a second. */
function useSecondsLeft(until) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return undefined;
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);
  if (!until) return 0;
  // `now` can lag a fresh `until` by up to a tick; never show more than a minute.
  return Math.min(60, Math.max(0, Math.ceil((until - now) / 1000)));
}

function Spin({ on, icon: Icon }) {
  return on ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />;
}

/**
 * The draft's editable fields as local state, what differs from the stored
 * issue, the PATCH body carrying only those differences, and a reset.
 */
function useIssueEdits(issue) {
  const stored = {
    subject: issue.subject || '',
    customNote: issue.customNote || '',
    preheader: issue.preheader || '',
    sections: issue.sections || [],
    // The per-issue send time as a datetime-local value ('' = the settings slot).
    sendAt: toLocalInput(issue.sendAt),
  };
  const [subject, setSubject] = useState(stored.subject);
  const [customNote, setCustomNote] = useState(stored.customNote);
  const [preheader, setPreheader] = useState(stored.preheader);
  const [sections, setSections] = useState(stored.sections);
  const [sendAt, setSendAt] = useState(stored.sendAt);

  const changed = {
    subject: subject !== stored.subject,
    customNote: customNote !== stored.customNote,
    preheader: preheader !== stored.preheader,
    sections: sectionsSignature(sections) !== sectionsSignature(stored.sections),
    sendAt: sendAt !== stored.sendAt,
  };
  const values = {
    subject,
    customNote,
    preheader,
    sections: toSectionsPayload(sections),
    sendAt: sendAt ? new Date(sendAt).toISOString() : null,
  };

  return {
    subject,
    customNote,
    preheader,
    sections,
    sendAt,
    setSubject,
    setCustomNote,
    setPreheader,
    setSections,
    setSendAt,
    dirty: Object.values(changed).some(Boolean),
    patch: () =>
      Object.fromEntries(
        Object.keys(changed)
          .filter((key) => changed[key])
          .map((key) => [key, values[key]])
      ),
    reset: () => {
      setSubject(stored.subject);
      setCustomNote(stored.customNote);
      setPreheader(stored.preheader);
      setSections(stored.sections);
      setSendAt(stored.sendAt);
    },
  };
}

/** An ISO instant as a datetime-local value, or '' for none. */
export function toLocalInput(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The saved versions, newest first (ADR 0033): what changed and when, so a rewrite can be traced. */
function VersionHistory({ versions }) {
  const [open, setOpen] = useState(false);
  if (!versions?.length) return null;
  return (
    <div className="rounded-lg border border-border/60">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <History className="h-3.5 w-3.5" aria-hidden="true" /> {versions.length} earlier version
        {versions.length === 1 ? '' : 's'}
      </button>
      {open && (
        <ol
          className="space-y-1 border-t border-border/60 px-3 py-2 text-xs"
          aria-label="Version history"
        >
          {versions.map((version) => (
            <li key={version.at} className="flex flex-wrap gap-x-2 text-muted-foreground">
              <span className="whitespace-nowrap">{formatWhen(version.at)}</span>
              <span className="truncate font-medium text-foreground">
                {version.subject || '(no subject)'}
              </span>
              <span>
                {version.itemCount} item(s) in {version.sectionCount} section(s)
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function SubjectField({ value, onChange, busy, onSuggestSubjects }) {
  const [suggestions, setSuggestions] = useState([]);

  const suggest = async () => {
    const subjects = await onSuggestSubjects();
    if (Array.isArray(subjects)) setSuggestions(subjects);
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor="nl-subject">Subject</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="nl-subject"
          className="min-w-0 flex-1"
          maxLength={120}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 h-9"
          onClick={suggest}
          disabled={Boolean(busy)}
        >
          <Spin on={busy === 'subjects'} icon={Sparkles} />
          Suggest subjects
        </Button>
      </div>
      {suggestions.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 pt-1" aria-label="Subject suggestions">
          {suggestions.map((line) => (
            <li key={line}>
              <button
                type="button"
                onClick={() => onChange(line)}
                aria-pressed={value === line}
                className={`rounded-full border px-2.5 py-1 text-xs text-left hover:bg-muted ${value === line ? 'border-primary' : 'border-border'}`}
              >
                {line}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActionBar({
  view,
  edits,
  busy,
  secondsLeft,
  onSave,
  onKeep,
  onRegenerateIntro,
  onSendTest,
  onDuplicate,
}) {
  const { dirty } = edits;
  const locked = Boolean(busy);
  const saveFirst = dirty ? SAVE_FIRST : undefined;
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={() => onSave(edits.patch())}
        disabled={!dirty || locked}
      >
        {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Save changes
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5"
        onClick={edits.reset}
        disabled={!dirty || locked}
      >
        <RotateCcw className="h-3.5 w-3.5" /> Reset
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={onRegenerateIntro}
        disabled={dirty || locked}
        title={saveFirst}
      >
        <Spin on={busy === 'intro'} icon={Sparkles} />
        Regenerate intro
      </Button>
      {/* A test send goes through Resend, so the route is publisher
          (lib/newsletter/admin-handlers.js testNewsletter). */}
      <RoleGate minRole="publisher" reason="Sending a test needs the publisher role.">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={onSendTest}
          disabled={dirty || locked || secondsLeft > 0}
          title={
            saveFirst ?? 'Sends one [TEST] copy to the reply-to address in Newsletter settings'
          }
        >
          <Spin on={busy === 'test'} icon={MailCheck} />
          {secondsLeft > 0 ? `Send test again in ${secondsLeft}s` : 'Send test to me'}
        </Button>
      </RoleGate>
      {view === 'review' && (
        <Button
          size="sm"
          className="gap-1.5"
          onClick={onKeep}
          // Keeping sends the stored version's etag, so edits save first.
          disabled={dirty || locked}
          title={saveFirst}
        >
          <Spin on={busy === 'keep'} icon={Archive} />
          Keep in Drafts
        </Button>
      )}
      {onDuplicate && (
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={onDuplicate}
          disabled={locked}
          title="A new kept draft with this issue's content"
        >
          <Spin on={busy === 'duplicate'} icon={Copy} />
          Duplicate
        </Button>
      )}
    </div>
  );
}

/** The per-issue send time (ADR 0033): empty means the slot in Newsletter settings. */
function SendTimeField({ value, onChange, plan }) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <div className="space-y-1.5">
      <Label htmlFor="nl-send-at">Send time for this issue (optional)</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="nl-send-at"
          type="datetime-local"
          className="w-auto"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {value && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange('')}>
            Use the settings slot
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{sendTimeHint(value, plan, zone)}</p>
    </div>
  );
}

function sendTimeHint(value, plan, zone) {
  if (value) return `Approval schedules it for this time (${zone}).`;
  if (plan?.overrideExpired) {
    return 'The saved send time has passed, so approval uses the settings slot instead.';
  }
  return 'Empty: approval uses the send day and time in Newsletter settings.';
}

/**
 * A template is chosen in Newsletter settings but this preview is the built-in
 * design, because the server could not fetch or use it. Approval is refused
 * until it can, so the warning says why here, before anyone tries.
 */
export function TemplateProblem({ problem }) {
  if (!problem) return null;
  const reason = typeof problem.message === 'string' ? problem.message.trim() : '';
  return (
    <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
      Your Resend template is not used in this preview, so it shows the built-in design
      {reason ? `: ${reason}` : '.'} Approval is refused until the template can be used, or the
      built-in design is chosen in Newsletter settings.
    </p>
  );
}

function Preview({ detail }) {
  return (
    <div className="space-y-2">
      <TemplateProblem problem={detail.templateProblem} />
      <iframe
        title="Email preview"
        sandbox=""
        srcDoc={detail.preview.html}
        className="w-full rounded-lg border bg-white"
        style={{ height: 720 }}
      />
    </div>
  );
}

function DraftEditor({
  view,
  detail,
  busy,
  testReadyAt,
  onApprove,
  onSuggestSubjects,
  ...actions
}) {
  const edits = useIssueEdits(detail.issue);
  const secondsLeft = useSecondsLeft(testReadyAt);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <div className="grid gap-3">
        <SubjectField
          value={edits.subject}
          onChange={edits.setSubject}
          busy={busy}
          onSuggestSubjects={onSuggestSubjects}
        />
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="nl-preheader">Preview text (inbox preheader)</Label>
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {edits.preheader.length}/{MAX_PREHEADER}
            </span>
          </div>
          <Input
            id="nl-preheader"
            maxLength={MAX_PREHEADER}
            value={edits.preheader}
            onChange={(e) => edits.setPreheader(e.target.value)}
            placeholder="The line inboxes show after the subject"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="nl-note">Your note (optional, shown under the intro)</Label>
          <Textarea
            id="nl-note"
            rows={3}
            maxLength={2000}
            value={edits.customNote}
            onChange={(e) => edits.setCustomNote(e.target.value)}
            placeholder="Announcements, events, anything the sections do not cover"
          />
        </div>
        <SendTimeField value={edits.sendAt} onChange={edits.setSendAt} plan={detail.sendPlan} />
        <ActionBar view={view} edits={edits} busy={busy} secondsLeft={secondsLeft} {...actions} />
        {edits.dirty && (
          <p className="text-xs text-muted-foreground">
            Unsaved changes. The preview shows the saved version until you save.
          </p>
        )}
        <VersionHistory versions={detail.issue.versions} />
      </div>

      {view === 'drafts' && (
        <div className="rounded-lg border p-3">
          <ApprovalBox detail={detail} dirty={edits.dirty} busy={busy} onApprove={onApprove} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">
              Sections{' '}
              <span className="font-normal text-muted-foreground">
                ({edits.sections.reduce((sum, section) => sum + (section.items?.length || 0), 0)}{' '}
                item(s))
              </span>
            </h4>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 h-7"
              onClick={() => setAdding(true)}
              disabled={Boolean(busy)}
            >
              <Plus className="h-3.5 w-3.5" /> Add a block
            </Button>
          </div>
          <SectionEditor
            sections={edits.sections}
            disabled={Boolean(busy)}
            onChange={edits.setSections}
          />
        </div>
        <Preview detail={detail} />
      </div>
      {adding && (
        <ManualBlockDialog
          sections={edits.sections}
          onAdd={(sectionId, sectionTitle, item) =>
            edits.setSections(addItemToSections(edits.sections, sectionId, sectionTitle, item))
          }
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}

export default function IssueDetail({ onReject, ...props }) {
  const { detail, busy } = props;
  const { issue } = detail;
  const isDraft = issue.status === 'draft';

  return (
    <Card className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={itemStatus({ status: issue.status })} />
        <span className="text-muted-foreground">{issue.itemCount} item(s) saved</span>
        {issue.scheduledAt && <span>Sends {formatWhen(issue.scheduledAt)}</span>}
        {issue.sentAt && <span>Sent {formatWhen(issue.sentAt)}</span>}
        {detail.fromAddress && (
          <span className="text-xs text-muted-foreground" title="Set on the Settings tab">
            From {detail.fromAddress}
          </span>
        )}
        {issue.duplicatedFrom && (
          <Badge variant="outline">copy of {issue.duplicatedFrom.replace('issue-', '')}</Badge>
        )}
      </div>

      <StatusWarnings issue={issue} />

      {issue.status === 'sending' && (
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          onClick={onReject}
          disabled={Boolean(busy)}
        >
          <XCircle className="h-3.5 w-3.5" /> Clear stuck send
        </Button>
      )}

      {isDraft ? <DraftEditor {...props} /> : <Preview detail={detail} />}
    </Card>
  );
}

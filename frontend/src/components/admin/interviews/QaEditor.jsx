/**
 * The questions-and-answers editor (ADR 0040, D4 and D5). The draft comes
 * from the drafting job; the owner reads every answer here, edits, reorders,
 * removes or adds, and saves through the content update route, which checks
 * the list against the interview schema again.
 *
 * The honesty guard's flags stay visible: an answer whose words do not come
 * mostly from the guest's own turns carries `needsReview`, shown as a
 * warning on the item until the owner says it was checked. Pull quotes the
 * guest did not say word for word were already dropped by the job, and the
 * count is shown so the owner knows.
 */
import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { LIMITS, emptyQaItem, moveQa, qaForSave, qaProblems } from './interviewModel';

function DraftNotes({ doc }) {
  const drafting = doc?.provenance?.drafting || {};
  const speakers = doc?.interview?.speakers || {};
  const notes = [];
  if (Number(drafting.droppedQuotes) > 0) {
    notes.push(
      `${drafting.droppedQuotes} pull quote(s) were left out because the guest did not say them word for word.`
    );
  }
  if (drafting.truncated) {
    notes.push(
      `The draft had more than ${LIMITS.MAX_QA} questions; the first ${LIMITS.MAX_QA} are kept.`
    );
  }
  if (speakers.unsure) {
    notes.push(
      `The draft could not tell for certain which speaker is the guest (it chose ${speakers.guest || 'one'}). Check the answers against the transcript below, and use Draft again if they are the interviewer's words.`
    );
  }
  if (notes.length === 0) return null;
  return (
    <ul className="list-disc space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 pl-8 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

/**
 * @param {object} props
 * @param {object} props.doc - the interview document
 * @param {boolean} props.saving
 * @param {(qa: object[]) => Promise<boolean>} props.onSave
 * @param {(dirty: boolean) => void} [props.onDirty]
 */
export default function QaEditor({ doc, saving, onSave, onDirty }) {
  const stored = Array.isArray(doc?.qa) ? doc.qa : [];
  // The owner's edits, or null while there are none: then the list is the
  // stored one, so a new draft from the server shows as soon as it lands.
  const [edited, setEdited] = useState(null);
  const [problems, setProblems] = useState([]);
  const items = edited ?? stored;
  const dirty = edited !== null;

  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty, onDirty]);

  const change = (next) => {
    setEdited(next);
    setProblems([]);
  };
  const patch = (index, fields) =>
    change(items.map((item, i) => (i === index ? { ...item, ...fields } : item)));

  const save = async () => {
    const found = qaProblems(items);
    setProblems(found);
    if (found.length > 0) return;
    const ok = await onSave(qaForSave(items));
    if (ok) setEdited(null);
  };

  const flagged = items.filter((item) => item.needsReview).length;

  return (
    <section aria-labelledby="interview-qa" className="space-y-4 rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="interview-qa" className="text-base font-semibold">
          Questions and answers
        </h2>
        {flagged > 0 && (
          <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
            {flagged} answer(s) to check
          </p>
        )}
      </div>
      <DraftNotes doc={doc} />
      {items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No questions yet. They appear here once the draft is ready, or add them yourself.
        </p>
      )}
      <ol className="space-y-4">
        {items.map((item, index) => {
          const n = index + 1;
          return (
            <li
              key={index}
              data-testid="qa-item"
              className={`space-y-2 rounded-md border p-3 ${item.needsReview ? 'border-amber-400' : ''}`}
            >
              {item.needsReview && (
                <div className="flex flex-wrap items-center gap-2 rounded bg-amber-50 p-2 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span id={`qa-flag-${index}`}>
                    Check this answer: some of its words are not in what the guest said.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => patch(index, { needsReview: false })}
                  >
                    I have checked answer {n}
                  </Button>
                </div>
              )}
              <label className="block text-sm font-medium" htmlFor={`qa-q-${index}`}>
                Question {n}
              </label>
              <Input
                id={`qa-q-${index}`}
                value={item.q || ''}
                maxLength={LIMITS.MAX_SHORT}
                onChange={(event) => patch(index, { q: event.target.value })}
              />
              <label className="block text-sm font-medium" htmlFor={`qa-a-${index}`}>
                Answer {n}
              </label>
              <Textarea
                id={`qa-a-${index}`}
                aria-describedby={item.needsReview ? `qa-flag-${index}` : undefined}
                rows={5}
                value={item.a || ''}
                maxLength={LIMITS.MAX_ANSWER}
                onChange={(event) => patch(index, { a: event.target.value })}
              />
              <label className="block text-sm font-medium" htmlFor={`qa-p-${index}`}>
                Pull quote {n} (optional, the guest&apos;s exact words)
              </label>
              <Input
                id={`qa-p-${index}`}
                value={item.pullQuote || ''}
                maxLength={LIMITS.MAX_SHORT}
                onChange={(event) => patch(index, { pullQuote: event.target.value })}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => change(moveQa(items, index, -1))}
                  aria-label={`Move question ${n} up`}
                >
                  <ArrowUp className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === items.length - 1}
                  onClick={() => change(moveQa(items, index, 1))}
                  aria-label={`Move question ${n} down`}
                >
                  <ArrowDown className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => change(items.filter((_, i) => i !== index))}
                  aria-label={`Remove question ${n}`}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      {problems.length > 0 && (
        <ul className="list-disc pl-6 text-sm text-red-700 dark:text-red-400">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={items.length >= LIMITS.MAX_QA}
          onClick={() => change([...items, emptyQaItem()])}
          className="gap-1"
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> Add a question
        </Button>
        <Button size="sm" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : 'Save questions and answers'}
        </Button>
        {dirty && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEdited(null);
              setProblems([]);
            }}
          >
            Undo changes
          </Button>
        )}
      </div>
    </section>
  );
}

/**
 * The guided application (ADR 0033 §4): a program's official questions,
 * section by section in the form's order, each rendered the way the form
 * asks it — a profile field, free text with the live count against its
 * limit, one choice, yes or no, a URL, a frequency grid, network + URL rows,
 * or activities tagged from the application's attached evidence. Every
 * answer has Copy; "Copy all" puts the whole packet on the clipboard in the
 * form's order. Answers live in the application's `responses[]` as today,
 * one `{ questionId, text }` each, structured kinds JSON-encoded into `text`
 * (applicationQuestions.js). Nothing here is ever published.
 */
import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Plus, Trash2 } from 'lucide-react';
import {
  YES_NO,
  answerText,
  answeredCount,
  packetText,
  parseAnswer,
  questionErrors,
  questionSections,
  responsesMap,
  serialiseAnswer,
} from './applicationQuestions';
import { CopyButton, FieldError, INPUT } from './Parts';

const describeId = (id) => `${id}-hint`;

/** What a control is described by: its error when it has one, else its hint when it has one. */
function describedBy(id, question, error) {
  if (error) return `${id}-error`;
  return question.hint ? describeId(id) : undefined;
}

/** A one-line text input: profile fields (typed by hand, never prefilled) and URLs. */
function LineInput({ id, question, text, onChange, error }) {
  return (
    <Input
      id={id}
      type={question.kind === 'url' ? 'url' : 'text'}
      placeholder={question.kind === 'url' ? 'https://...' : undefined}
      value={text}
      onChange={(e) => onChange(e.target.value)}
      aria-invalid={Boolean(error) || undefined}
      aria-describedby={describedBy(id, question, error)}
    />
  );
}

/** Free text with the live count against the question's limit. */
function TextAnswer({ id, question, text, onChange, error }) {
  const max = question.maxChars || null;
  return (
    <>
      <Textarea
        id={id}
        rows={4}
        maxLength={max || undefined}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy(id, question, error)}
      />
      {max && (
        <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {text.length.toLocaleString()} / {max.toLocaleString()} characters
        </p>
      )}
    </>
  );
}

const OTHER = '__other__';

/**
 * One choice from the options. With `allowOther` the list ends in "Other…",
 * which opens a text input for a value the list does not carry; a stored
 * value off the list opens in that mode.
 */
function ChoiceAnswer({ id, question, text, onChange }) {
  const listed = text === '' || question.options.includes(text);
  const [otherMode, setOtherMode] = useState(question.allowOther && !listed);
  const pick = (value) => {
    if (value === OTHER) {
      setOtherMode(true);
      if (listed) onChange('');
      return;
    }
    setOtherMode(false);
    onChange(value);
  };
  return (
    <div className="space-y-1.5">
      <select
        id={id}
        className={INPUT}
        value={otherMode ? OTHER : text}
        onChange={(e) => pick(e.target.value)}
      >
        <option value="">Choose…</option>
        {question.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
        {question.allowOther && <option value={OTHER}>Other…</option>}
      </select>
      {otherMode && (
        <Input
          aria-label={`${question.prompt} (other)`}
          placeholder="Type the value as the form lists it"
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

function YesNoAnswer({ id, text, onChange }) {
  return (
    <div className="flex gap-4" role="radiogroup" aria-labelledby={`${id}-label`}>
      {YES_NO.map((option) => (
        <label key={option} className="flex items-center gap-1.5 text-sm">
          <input
            type="radio"
            name={id}
            value={option}
            checked={text === option}
            onChange={() => onChange(option)}
          />
          {option}
        </label>
      ))}
    </div>
  );
}

/** One select per row of the grid; the answer is `{ row: option }`. */
function ScaleAnswer({ id, question, text, onChange }) {
  const value = parseAnswer('scale', text);
  const setRow = (row, option) => onChange(serialiseAnswer('scale', { ...value, [row]: option }));
  return (
    <div className="grid gap-1.5">
      {(question.rows || []).map((row, index) => {
        const rowId = `${id}-row-${index}`;
        return (
          <div key={row} className="grid grid-cols-[1fr_auto] items-center gap-2 text-sm">
            <Label htmlFor={rowId} className="text-xs font-normal">
              {row}
            </Label>
            <select
              id={rowId}
              className={`${INPUT} w-36`}
              value={value[row] || ''}
              onChange={(e) => setRow(row, e.target.value)}
            >
              <option value="">—</option>
              {question.options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}

/** Repeatable network + URL rows; the answer is `[{ network, url }]`. */
function LinksAnswer({ question, text, onChange }) {
  const rows = parseAnswer('links', text);
  const max = question.maxItems || 50;
  const set = (next) => onChange(serialiseAnswer('links', next));
  const update = (index, patch) =>
    set(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-[1fr_2fr_auto] items-center gap-2">
          <select
            className={INPUT}
            aria-label={`Network ${index + 1}`}
            value={row.network}
            onChange={(e) => update(index, { network: e.target.value })}
          >
            <option value="">Network…</option>
            {question.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <Input
            type="url"
            aria-label={`URL ${index + 1}`}
            placeholder="https://..."
            value={row.url}
            onChange={(e) => update(index, { url: e.target.value })}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-destructive"
            aria-label={`Remove link ${index + 1}`}
            onClick={() => set(rows.filter((_, i) => i !== index))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={rows.length >= max}
        onClick={() => set([...rows, { network: '', url: '' }])}
      >
        <Plus className="mr-1 h-3.5 w-3.5" /> Add link
      </Button>
    </div>
  );
}

/**
 * Activities tagged from the attached evidence; the answer is the evidence
 * ids. An id no longer attached (detached, or deleted) is still a selection
 * — it counts toward the limit — so it is shown as a row of its own with its
 * checkbox ticked, which is how it is removed.
 */
function ActivitiesAnswer({ id, question, text, onChange, evidence }) {
  const chosen = parseAnswer('activities', text);
  const max = question.maxItems || null;
  const full = max ? chosen.length >= max : false;
  const unavailable = chosen.filter((x) => !evidence.some((item) => item.id === x));
  const toggle = (evidenceId) =>
    onChange(
      serialiseAnswer(
        'activities',
        chosen.includes(evidenceId)
          ? chosen.filter((x) => x !== evidenceId)
          : [...chosen, evidenceId]
      )
    );
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        Tag {max ? `up to ${max} ` : ''}activities from the past 12 months, from the evidence
        attached to this application
        {max ? ` · ${chosen.length} / ${max}` : ` · ${chosen.length}`}.
      </p>
      {evidence.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Nothing attached yet. Attach evidence from the requirement checklist above first.
        </p>
      )}
      {(evidence.length > 0 || unavailable.length > 0) && (
        <ul className="space-y-1">
          {evidence.map((item) => {
            const on = chosen.includes(item.id);
            return (
              <li key={item.id} className="flex items-center gap-2 text-sm">
                <input
                  id={`${id}-${item.id}`}
                  type="checkbox"
                  checked={on}
                  disabled={!on && full}
                  onChange={() => toggle(item.id)}
                />
                <label htmlFor={`${id}-${item.id}`}>
                  {item.title}{' '}
                  <span className="text-xs text-muted-foreground">· {item.date || 'undated'}</span>
                </label>
              </li>
            );
          })}
          {unavailable.map((evidenceId) => (
            <li key={evidenceId} className="flex items-center gap-2 text-sm">
              <input
                id={`${id}-${evidenceId}`}
                type="checkbox"
                checked
                onChange={() => toggle(evidenceId)}
              />
              <label htmlFor={`${id}-${evidenceId}`} className="text-muted-foreground">
                No longer attached ({evidenceId}) — untick to remove it from the answer
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ANSWERS = {
  profile: LineInput,
  url: LineInput,
  text: TextAnswer,
  choice: ChoiceAnswer,
  yesno: YesNoAnswer,
  scale: ScaleAnswer,
  links: LinksAnswer,
  activities: ActivitiesAnswer,
};

/** One question: its prompt with Copy, the hint, the answer control by kind, the error. */
function QuestionField({ question, text, onChange, error, evidence, evidenceById }) {
  const id = `question-${question.id}`;
  const Answer = ANSWERS[question.kind] || TextAnswer;
  const copyValue = answerText(question, text, { evidenceById });
  const labelled = ['yesno', 'scale', 'links', 'activities'].includes(question.kind);
  return (
    <div className="space-y-1" data-testid="guided-question">
      <div className="flex items-start justify-between gap-2">
        {labelled ? (
          <p id={`${id}-label`} className="text-xs font-medium">
            {question.prompt}
            {question.required ? ' *' : ''}
          </p>
        ) : (
          <Label htmlFor={id} className="text-xs">
            {question.prompt}
            {question.required ? ' *' : ''}
          </Label>
        )}
        <CopyButton
          value={copyValue}
          label={`Copy answer: ${question.prompt}`}
          disabled={!copyValue}
        />
      </div>
      {question.hint && (
        <p id={describeId(id)} className="text-xs text-muted-foreground">
          {question.hint}
        </p>
      )}
      <Answer
        id={id}
        question={question}
        text={text}
        onChange={onChange}
        error={error}
        evidence={evidence}
      />
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/**
 * @param {object} props
 * @param {Array} props.questions the program's `applicationQuestions`
 * @param {Array} props.responses the application's `responses[]` as the form holds them
 * @param {Function} props.onChange the new `responses[]`
 * @param {Array} props.evidence the evidence attached to this application (activities pick from it)
 * @param {string} [props.title] the packet's first line
 */
export default function GuidedResponses({ questions, responses, onChange, evidence, title }) {
  const by = responsesMap(responses);
  const evidenceById = useMemo(() => new Map((evidence || []).map((e) => [e.id, e])), [evidence]);
  const errors = useMemo(() => questionErrors(questions, responses), [questions, responses]);
  const sections = useMemo(() => questionSections(questions), [questions]);
  const known = useMemo(() => new Set(questions.map((q) => q.id)), [questions]);
  const leftovers = responses.filter((r) => !known.has(r.questionId));
  const answered = answeredCount(questions, responses);

  const setAnswer = (questionId, text) => {
    const rest = responses.filter((r) => r.questionId !== questionId);
    if (!text) return onChange(rest);
    const index = responses.findIndex((r) => r.questionId === questionId);
    if (index === -1) return onChange([...responses, { questionId, text }]);
    return onChange(responses.map((r, i) => (i === index ? { ...r, text } : r)));
  };

  return (
    <section aria-labelledby="workspace-responses" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="workspace-responses" className="text-sm font-semibold">
            Application questions
          </h3>
          <p className="text-xs text-muted-foreground">
            {answered} of {questions.length} answered · the program&apos;s official questions in the
            form&apos;s order; copy each answer, or all of them, into the official form.
          </p>
        </div>
        <CopyButton
          value={packetText(questions, responses, { evidenceById, title })}
          label="Copy all answers"
          className="border border-input"
        >
          Copy all
        </CopyButton>
      </div>
      {sections.map(({ section, questions: list }) => (
        <fieldset key={section} className="space-y-3 rounded-md border border-border p-3">
          <legend className="px-1 text-xs font-medium">{section}</legend>
          {list.map((question) => (
            <QuestionField
              key={question.id}
              question={question}
              text={by.get(question.id) || ''}
              onChange={(text) => setAnswer(question.id, text)}
              error={errors[question.id]}
              evidence={evidence || []}
              evidenceById={evidenceById}
            />
          ))}
        </fieldset>
      ))}
      {leftovers.length > 0 && (
        <fieldset className="space-y-2 rounded-md border border-dashed border-border p-3">
          <legend className="px-1 text-xs font-medium">Other responses</legend>
          <p className="text-xs text-muted-foreground">
            Written before this program had its question list; kept as they are.
          </p>
          {leftovers.map((r) => (
            <div key={r.questionId} className="flex items-start justify-between gap-2 text-sm">
              <div>
                <p className="font-medium">{r.questionId}</p>
                <p className="whitespace-pre-wrap text-muted-foreground">{r.text}</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive"
                aria-label={`Remove response ${r.questionId}`}
                onClick={() => onChange(responses.filter((x) => x.questionId !== r.questionId))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </fieldset>
      )}
    </section>
  );
}

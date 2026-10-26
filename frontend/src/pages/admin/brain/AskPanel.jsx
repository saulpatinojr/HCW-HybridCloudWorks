import React, { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { brainApi } from '@/lib/brainApi';

export default function AskPanel({ enabled, onSaveNote, context }) {
  const [question, setQuestion] = useState('');
  const [mode, setMode] = useState('question');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState('');
  async function ask(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setAnswer(null);
    try {
      setAnswer(await brainApi.ask(question, mode, context?.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  const snapshot = () => ({
    title: question.slice(0, 300),
    body: [
      '## Source-backed answer',
      ...answer.claims.map((c) => `${c.text} (${c.sourceIds.join(', ')})`),
      '## Suggestions',
      ...answer.suggestions.map((c) => c.text),
      '## Sources',
      ...answer.sources.map((s) => `${s.citation}: ${s.title}`),
    ].join('\n\n'),
    links: answer.sources.map((s) => s.id),
  });
  return (
    <div className="max-w-4xl space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Ask my brain</h2>
        {context && <p className="mt-2 text-sm font-medium">Starting with: {context.title}</p>}
        <p className="mt-2 text-sm text-muted-foreground">
          Develop ideas using your own notes and creator content. Relevant excerpts go to your
          configured Foundry model only when you ask.
        </p>
      </div>
      {!enabled && (
        <p role="status" className="rounded-lg border p-4 text-sm">
          AI is not enabled for this workspace. Notes, search, and your map remain available.
        </p>
      )}
      <form onSubmit={ask} className="space-y-3">
        <label className="block text-sm">
          Action
          <select
            className="ml-3 rounded-md border bg-background p-2"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            {[
              ['question', 'Answer a question'],
              ['summary', 'Summarize'],
              ['outline', 'Develop an outline'],
              ['connections', 'Find connections'],
              ['repurpose', 'Plan a new format'],
              ['gaps', 'Find gaps in my content'],
            ].map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Your question
          <textarea
            className="mt-1 min-h-28 w-full rounded-lg border bg-background p-3"
            maxLength={2000}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Using my existing material, outline the next article in this series and show what research is missing."
          />
        </label>
        <Button disabled={!enabled || busy || !question.trim()} type="submit">
          {busy ? 'Reading your sources…' : 'Ask my brain'}
        </Button>
      </form>
      {error && (
        <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm">
          {error}
        </p>
      )}
      {answer && (
        <div aria-live="polite" className="space-y-5 rounded-xl border p-5">
          {answer.insufficientEvidence && (
            <p>
              I could not find enough evidence in the retrieved material. Try a topic name, narrower
              question, or index your latest content.
            </p>
          )}
          {answer.partialRetrieval && (
            <p className="text-sm text-muted-foreground">
              This answer uses a bounded set of matching material, rather than an exhaustive review.
            </p>
          )}
          {answer.indexing?.status !== 'complete' && (
            <p className="text-sm text-muted-foreground">
              Indexing is incomplete. Some content may be missing.
            </p>
          )}
          {Boolean(answer.claims.length) && (
            <div>
              <h3 className="font-semibold">From your sources</h3>
              {answer.claims.map((claim, i) => (
                <p key={i} className="mt-3 whitespace-pre-wrap text-sm">
                  {claim.text}{' '}
                  <span className="text-muted-foreground">[{claim.sourceIds.join(', ')}]</span>
                </p>
              ))}
            </div>
          )}
          {Boolean(answer.suggestions.length) && (
            <div>
              <h3 className="font-semibold">Suggestions to explore</h3>
              {answer.suggestions.map((s, i) => (
                <p key={i} className="mt-3 whitespace-pre-wrap text-sm">
                  {s.text}
                </p>
              ))}
            </div>
          )}
          <div>
            <h3 className="font-semibold">Sources</h3>
            <ul className="mt-2 space-y-2">
              {answer.sources.map((source) => (
                <li className="text-sm" key={source.citation}>
                  <Link className="underline" to={source.href}>
                    {source.citation}: {source.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          {Boolean(answer.usage.length) && (
            <p className="text-xs text-muted-foreground">
              Usage:{' '}
              {answer.usage
                .map(
                  (u) =>
                    `${u.model || u.provider}: ${u.promptTokens || 0} input / ${u.completionTokens || 0} output tokens${typeof u.costUsd === 'number' ? ` · $${u.costUsd}` : ''}`
                )
                .join('; ')}
              . Provider billing remains authoritative.
            </p>
          )}
          {(answer.claims.length > 0 || answer.suggestions.length > 0) && (
            <Button variant="outline" onClick={() => onSaveNote(snapshot())}>
              Review as a new note
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

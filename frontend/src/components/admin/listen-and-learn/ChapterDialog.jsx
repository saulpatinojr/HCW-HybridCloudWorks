/**
 * Add a chapter to a book (ADR 0033 §4): from pasted text, from an existing
 * content item, or — for a course — from its study guide, which is the
 * Generate tab's job and is linked rather than duplicated here. The cost of
 * speaking the text is estimated as it is typed, through the same route the
 * 202 prices with, so the figure the operator reads is the one that runs.
 *
 * The form mounts fresh each time the dialog opens (Radix unmounts closed
 * content), so there is no reset-on-open effect to get out of step.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Loader2 } from 'lucide-react';
import { estimateSpeech } from '@/lib/listenAndLearn';
import { formatCost } from './episodeView';
import { tabHref } from './tabs';

const ESTIMATE_DEBOUNCE_MS = 500;

/**
 * The estimate for the text as typed, or null while one is pending. Stored
 * with the text it priced, so a stale figure is never shown for new text and
 * no state is set synchronously inside the effect.
 */
function useSpeechEstimate(text, book, enabled) {
  const [priced, setPriced] = useState(null); // { forText, result }
  useEffect(() => {
    if (!enabled || !text.trim()) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      estimateSpeech({ text, platform: book?.provider, examCode: book?.examCode })
        .then((result) => {
          if (!cancelled) setPriced({ forText: text, result });
        })
        .catch(() => {
          if (!cancelled) setPriced({ forText: text, result: null });
        });
    }, ESTIMATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, book?.provider, book?.examCode, enabled]);
  return priced?.forText === text ? priced.result : undefined;
}

/** The line under the text area: what it will cost, or what is known so far. */
function estimateLine(text, estimate) {
  if (!text.trim()) return 'Long text is read in parts and joined into one file.';
  if (estimate === undefined) return 'Estimating…';
  if (estimate === null)
    return 'The estimate could not be read; the run will still state its spend.';
  if (estimate.estimatedCostUsd === null) {
    return 'No speech provider is configured — the chapter will have text only';
  }
  return `About ${estimate.bytes.toLocaleString()} bytes · up to ${formatCost(estimate.estimatedCostUsd)} with ${estimate.model || estimate.provider}`;
}

function ChapterForm({ book, onCreate, onClose }) {
  const [mode, setMode] = useState('text');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [contentId, setContentId] = useState('');
  const [speak, setSpeak] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const estimate = useSpeechEstimate(text, book, mode === 'text');

  const filled = mode === 'text' ? Boolean(text.trim()) : Boolean(contentId.trim());
  const ready = Boolean(title.trim()) && !saving && filled;
  const noun = book?.kind === 'course' ? 'lesson' : 'chapter';

  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError(null);
    const result = await onCreate({
      title: title.trim(),
      ...(mode === 'text' ? { sourceText: text } : { contentId: contentId.trim() }),
      speak,
    });
    setSaving(false);
    if (result?.error) setError(result.error);
    else onClose();
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}
      <fieldset className="flex flex-wrap gap-3 text-xs">
        <legend className="sr-only">Where the text comes from</legend>
        {[
          ['text', 'Pasted text'],
          ['content', 'A content item'],
        ].map(([value, label]) => (
          <label key={value} className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              name="chapter-mode"
              value={value}
              checked={mode === value}
              onChange={() => setMode(value)}
            />
            {label}
          </label>
        ))}
        {book?.kind === 'course' && book?.studyGuideUrl && (
          <Link to={tabHref('generate')} className="text-primary underline underline-offset-4">
            From the study guide → Generate tab
          </Link>
        )}
      </fieldset>
      <label htmlFor="chapter-title" className="block space-y-1 text-xs font-medium">
        <span>Title</span>
        <Input
          id="chapter-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={160}
        />
      </label>
      {mode === 'text' ? (
        <label htmlFor="chapter-text" className="block space-y-1 text-xs font-medium">
          <span>Text to read</span>
          <Textarea
            id="chapter-text"
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={60000}
          />
          <span className="block text-xs font-normal text-muted-foreground" aria-live="polite">
            {estimateLine(text, estimate)}
          </span>
        </label>
      ) : (
        <label htmlFor="chapter-content" className="block space-y-1 text-xs font-medium">
          <span>Content item id</span>
          <Input
            id="chapter-content"
            value={contentId}
            onChange={(e) => setContentId(e.target.value)}
            placeholder="the id from the Editor's address bar"
          />
        </label>
      )}
      <label className="inline-flex items-center gap-2 text-xs">
        <input type="checkbox" checked={speak} onChange={(e) => setSpeak(e.target.checked)} />
        Read it now (otherwise use Regenerate on the chapter later)
      </label>
      <DialogFooter className="gap-2 sm:gap-0">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready}>
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          Add {noun}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {object} props.book the open book
 * @param {(fields: object) => Promise<{error?: string}|null>} props.onCreate
 * @param {() => void} props.onClose
 */
export default function ChapterDialog({ open, book, onCreate, onClose }) {
  const noun = book?.kind === 'course' ? 'lesson' : 'chapter';
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New {noun}</DialogTitle>
          <DialogDescription>
            A {noun} is one audio track. Paste the text to read, or name a content item whose body
            is read with its markup dropped. It lands as a draft; approve it on the Review tab when
            the take sounds right.
          </DialogDescription>
        </DialogHeader>
        <ChapterForm book={book} onCreate={onCreate} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}

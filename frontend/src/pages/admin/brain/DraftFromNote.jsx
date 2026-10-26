import React, { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { brainApi } from '@/lib/brainApi';

export default function DraftFromNote({ item, form, version, dirty }) {
  const [title, setTitle] = useState(null);
  const [body, setBody] = useState(null);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create() {
    setBusy(true);
    setError('');
    try {
      setResult(
        await brainApi.draft(
          item.id,
          {
            title: title ?? form.title,
            body: body ?? form.body,
            tags: form.tags,
            kind: 'article',
            ideaOrigin: 'manual',
          },
          requestId
        )
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rounded-lg border p-4">
      <summary className="cursor-pointer font-medium">
        Create an article draft from this note
      </summary>
      <p className="my-3 text-sm text-muted-foreground">
        Review the exact title and text below. The new draft follows the existing editorial
        workflow.
      </p>
      <label className="block text-sm">
        Draft title
        <input
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={title ?? form.title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="my-3 block text-sm">
        Draft text
        <textarea
          className="min-h-40 w-full rounded-md border bg-background px-3 py-2 text-sm"
          value={body ?? form.body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="my-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Button disabled={busy || !version || dirty || Boolean(result)} onClick={create}>
        Create draft
      </Button>
      {(!version || dirty) && (
        <p className="text-sm">Save the note first to preserve its source version.</p>
      )}
      {result && (
        <div className="mt-3 flex items-center gap-4">
          <Link className="underline" to={result.href}>
            Open Drafts
          </Link>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setRequestId(crypto.randomUUID());
              setResult(null);
            }}
          >
            Start another draft
          </Button>
        </div>
      )}
    </details>
  );
}

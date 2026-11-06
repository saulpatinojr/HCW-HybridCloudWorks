/**
 * The transcript, read from the private container by GET cms/interviews/{id}
 * and shown only here, folded by default so the editor stays the focus.
 * Rendered as text: nothing in it is ever treated as markup.
 */
import React from 'react';

/** The transcript as lines: the stored plain text, or the segments joined. */
export function transcriptText(transcript) {
  if (!transcript) return '';
  if (typeof transcript.text === 'string' && transcript.text.trim()) return transcript.text;
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  return segments
    .map((segment) => `${segment?.speaker || 'Speaker'}: ${String(segment?.text || '').trim()}`)
    .join('\n');
}

export default function TranscriptPanel({ transcript }) {
  const text = transcriptText(transcript);
  return (
    <section aria-labelledby="interview-transcript" className="rounded-md border p-4">
      <h2 id="interview-transcript" className="text-base font-semibold">
        Transcript
      </h2>
      {text ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-sm">
            Show transcript version {transcript.version} ({text.length.toLocaleString()} characters)
          </summary>
          <pre className="mt-2 max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-sm">
            {text}
          </pre>
        </details>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">No transcript yet.</p>
      )}
    </section>
  );
}

/**
 * The facts under the preview in ImageDetailsDialog (ADR 0033) — source,
 * model, set, size, dates, owner, record — rendered from `factRows`, plus
 * the prompt that produced the image behind a toggle.
 */
import React from 'react';
import { safeUrl } from '@/lib/safeUrl';
import { factRows } from './imageDetailsFields';

function Fact({ label, children }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/60 py-1 text-xs last:border-0">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right break-words">{children}</dd>
    </div>
  );
}

/** The image set the image came from, as a link to Image Prompts. */
function SetFact({ item, onOpenSet }) {
  return (
    <>
      <button
        type="button"
        className="text-blue-600 hover:underline dark:text-blue-400"
        onClick={() => onOpenSet(item.promptSet)}
      >
        {item.promptSet}
      </button>
      {item.promptName ? ` / ${item.promptName}` : ''}
      {item.promptTemplateVersion ? ` (${item.promptTemplateVersion})` : ''}
    </>
  );
}

function FactValue({ row, item, onOpenSet }) {
  if (row.kind === 'set') return <SetFact item={item} onOpenSet={onOpenSet} />;
  if (row.kind === 'link') {
    return (
      <a
        href={safeUrl(row.text)}
        target="_blank"
        rel="noreferrer"
        className="text-blue-600 hover:underline dark:text-blue-400"
      >
        {row.text}
      </a>
    );
  }
  if (row.kind === 'code') return <code className="text-xs">{row.text}</code>;
  return row.text;
}

function PromptReveal({ prompt, open, onToggle }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <button
        type="button"
        className="text-xs font-medium hover:underline"
        onClick={onToggle}
        aria-expanded={open}
      >
        {open ? 'Hide' : 'Show'} the prompt that produced this image
      </button>
      {open && (
        <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">
          {prompt}
        </pre>
      )}
    </div>
  );
}

export default function ImageDetailsFacts({ item, onOpenSet, showPrompt, onTogglePrompt }) {
  return (
    <>
      <dl className="rounded-lg border border-border p-3">
        {factRows(item).map((row) => (
          <Fact key={row.label} label={row.label}>
            <FactValue row={row} item={item} onOpenSet={onOpenSet} />
          </Fact>
        ))}
      </dl>
      {item.prompt && (
        <PromptReveal prompt={item.prompt} open={showPrompt} onToggle={onTogglePrompt} />
      )}
    </>
  );
}

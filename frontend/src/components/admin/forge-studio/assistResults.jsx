/**
 * One renderer per AI result shape (ADR 0033 §7 slice 2), and the card
 * that frames whichever one the action produced. A result is never applied
 * on its own: every one has an explicit "use" button that calls `onApply`
 * with `{ type, text }` for draftModel's applyAssistResult.
 */
import React, { useState } from 'react';
import { Check, Copy, Sparkles, X } from 'lucide-react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { outlineToMarkdown } from './draftModel';

async function copyText(text) {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      className="gap-1"
      onClick={async () => {
        if (await copyText(text)) setCopied(true);
      }}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {label}
    </Button>
  );
}

const listOf = (value) => (Array.isArray(value) ? value : []);

function OutlineSection({ section }) {
  const bullets = listOf(section.bullets);
  return (
    <li>
      <span className="font-medium">{section.heading}</span>
      {bullets.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {bullets.map((bullet, i) => (
            <li key={i}>{bullet}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function OutlineResult({ result, onApply }) {
  const outline = listOf(result?.outline);
  if (!outline.length) {
    return <p className="text-sm text-muted-foreground">The model returned no outline.</p>;
  }
  const markdown = outlineToMarkdown(outline);
  return (
    <>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {outline.map((section, index) => (
          <OutlineSection key={index} section={section} />
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onApply({ type: 'append', text: markdown })}>
          Append as headings
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onApply({ type: 'replace-all', text: markdown })}
        >
          Replace the draft with the outline
        </Button>
      </div>
    </>
  );
}

function TitlesResult({ result, onApply }) {
  const titles = listOf(result?.titles);
  if (!titles.length) {
    return <p className="text-sm text-muted-foreground">The model returned no titles.</p>;
  }
  return (
    <ul className="space-y-1">
      {titles.map((title) => (
        <li
          key={title}
          className="flex items-center justify-between gap-2 rounded border border-border/60 px-3 py-1.5 text-sm"
        >
          <span>{title}</span>
          <Button size="sm" variant="ghost" onClick={() => onApply({ type: 'title', text: title })}>
            Use this title
          </Button>
        </li>
      ))}
    </ul>
  );
}

function MetadataRow({ label, value, action, onAction }) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-2">
      <span>
        <span className="text-xs text-muted-foreground">{label}</span>
        <br />
        {value}
      </span>
      {action && (
        <Button size="sm" variant="ghost" onClick={onAction}>
          {action}
        </Button>
      )}
    </div>
  );
}

function MetadataResult({ result, onApply }) {
  const tags = listOf(result?.tags);
  const keywords = listOf(result?.seoKeywords);
  return (
    <div className="space-y-2 text-sm">
      <MetadataRow
        label="Title"
        value={result?.title}
        action="Use"
        onAction={() => onApply({ type: 'title', text: result.title })}
      />
      <MetadataRow
        label="Summary"
        value={result?.summary}
        action="Use"
        onAction={() => onApply({ type: 'summary', text: result.summary })}
      />
      <MetadataRow
        label="Tags"
        value={tags.join(', ')}
        action="Add to SEO keywords"
        onAction={() => onApply({ type: 'keywords', text: [...tags, ...keywords].join(', ') })}
      />
      <MetadataRow label="SEO keywords" value={keywords.join(', ')} />
      <MetadataRow
        label="Slug"
        value={result?.slug ? <span className="font-mono">{result.slug}</span> : ''}
      />
    </div>
  );
}

function SocialResult({ result, contentId }) {
  const posts = listOf(result?.posts);
  return (
    <div className="space-y-2">
      {posts.map((post, index) => (
        <div
          key={`${post.network}-${index}`}
          className="rounded border border-border/60 p-3 text-sm"
        >
          <div className="mb-1 flex items-center justify-between">
            <Badge variant="secondary" className="capitalize">
              {post.network}
            </Badge>
            <CopyButton text={post.text} />
          </div>
          <p className="whitespace-pre-wrap">{post.text}</p>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Paste one into the Social Hub composer:{' '}
        <Link
          className="text-primary underline"
          to={`/admin/social-hub?tab=compose&contentId=${encodeURIComponent(contentId)}`}
        >
          open the Social Hub with this piece selected
        </Link>
        .
      </p>
    </div>
  );
}

function ClaimsResult({ result }) {
  const claims = listOf(result?.claims);
  if (!claims.length) {
    return (
      <p className="text-sm text-emerald-700 dark:text-emerald-300">
        The model found no claim stated without support.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {claims.map((claim, index) => (
        <li
          key={index}
          className="rounded border border-amber-300/60 bg-amber-50/40 p-3 text-sm dark:bg-amber-950/20"
        >
          <p className="font-medium">“{claim.claim}”</p>
          {claim.why && <p className="text-xs text-muted-foreground">Why: {claim.why}</p>}
          {claim.suggestion && <p className="text-xs">Suggestion: {claim.suggestion}</p>}
        </li>
      ))}
    </ul>
  );
}

function SummaryResult({ text, onApply }) {
  return (
    <>
      <p className="whitespace-pre-wrap text-sm">{text}</p>
      <Button size="sm" onClick={() => onApply({ type: 'summary', text })}>
        Use as summary
      </Button>
    </>
  );
}

function TextResult({ text, hasSelection, onEdit, onApply }) {
  return (
    <>
      <Textarea
        aria-label="AI result"
        rows={10}
        value={text}
        onChange={(event) => onEdit(event.target.value)}
        className="font-mono text-xs"
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onApply({ type: 'replace', text })}>
          {hasSelection ? 'Replace the selection' : 'Replace the draft'}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onApply({ type: 'append', text })}>
          Append to the draft
        </Button>
        <CopyButton text={text} />
      </div>
    </>
  );
}

/** The renderer for each structured result; every other action's result is text. */
const RESULT_VIEWS = Object.freeze({
  outline: OutlineResult,
  title: TitlesResult,
  metadata: MetadataResult,
  social: SocialResult,
  claims: ClaimsResult,
  summary: SummaryResult,
});

export function AssistResult({
  assist,
  resultText,
  onEditText,
  hasSelection,
  contentId,
  onClose,
  onApply,
}) {
  const { action, label, result, provider, model } = assist;
  const View = RESULT_VIEWS[action] || TextResult;
  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" /> {label}
            </CardTitle>
            <CardDescription>
              Written by{' '}
              <span className="font-mono">
                {[provider, model].filter(Boolean).join(' / ') || 'the router'}
              </span>
              . Recorded on the document&apos;s activity. Nothing is applied until you choose to.
            </CardDescription>
          </div>
          <Button size="sm" variant="ghost" aria-label="Dismiss result" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <View
          result={result}
          text={resultText}
          hasSelection={hasSelection}
          contentId={contentId}
          onEdit={onEditText}
          onApply={onApply}
        />
      </CardContent>
    </Card>
  );
}

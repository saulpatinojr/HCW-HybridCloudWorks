/**
 * TaxonomyChips — the kind and idea origin of one record, as two small chips
 * (ADR 0033 §4). Resolved the way the server resolves them: the stored value,
 * else what the record's `type` and `source` imply, so a record that predates
 * the taxonomy is still classified. The label comes from the saved lists;
 * an id the lists no longer carry shows as itself.
 */
import React from 'react';
import { Lightbulb, Shapes } from 'lucide-react';
import { labelFor, resolveIdeaOrigin, resolveKind } from '@/lib/taxonomy';
import { useTaxonomy } from './useTaxonomy';

const CHIP =
  'inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground whitespace-nowrap';

export default function TaxonomyChips({
  item,
  showKind = true,
  showOrigin = true,
  className = '',
}) {
  const { taxonomy } = useTaxonomy();
  if (!item) return null;
  const kind = resolveKind(item);
  const origin = resolveIdeaOrigin(item);
  return (
    <span className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}>
      {showKind && (
        <span className={CHIP} title={`Kind: ${labelFor(taxonomy.kinds, kind)}`} data-kind={kind}>
          <Shapes className="h-3 w-3" aria-hidden="true" />
          {labelFor(taxonomy.kinds, kind)}
        </span>
      )}
      {showOrigin && (
        <span
          className={CHIP}
          title={`Idea origin: ${labelFor(taxonomy.ideaOrigins, origin)}`}
          data-idea-origin={origin}
        >
          <Lightbulb className="h-3 w-3" aria-hidden="true" />
          {labelFor(taxonomy.ideaOrigins, origin)}
        </span>
      )}
    </span>
  );
}

/**
 * TaxonomyChips — the kind and idea origin of one record, as two small chips
 * (ADR 0033 §4). Resolved the way the server resolves them: the stored value,
 * else what the record's `type` and `source` imply, so a record that predates
 * the taxonomy is still classified. The label comes from the saved lists;
 * an id the lists no longer carry shows as itself.
 *
 * A third chip, when another admin Page sent the record into the Pipeline:
 * which Page and which record (OriginChip, #1886). It lives here so every
 * page that already shows the taxonomy shows it too.
 */
import React from 'react';
import { Lightbulb, Shapes } from 'lucide-react';
import { labelFor, resolveIdeaOrigin, resolveKind } from '@/lib/taxonomy';
import { useTaxonomy } from './useTaxonomy';
import OriginChip from './OriginChip';

const CHIP =
  'inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs font-medium text-muted-foreground whitespace-nowrap';

export default function TaxonomyChips({
  item,
  showKind = true,
  showOrigin = true,
  showSource = true,
  sourceAsLink = true,
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
      {showSource && <OriginChip originRef={item.originRef} asLink={sourceAsLink} />}
    </span>
  );
}

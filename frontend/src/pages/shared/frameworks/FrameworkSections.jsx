/**
 * The framework explorer's sections: the map of a framework's concepts, the
 * picked concepts side by side, and the architecture recommendation. Split
 * out of FrameworksPage.jsx, which only arranges them.
 */
import React from 'react';
import { ExternalLink, Lightbulb, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

/** A list of source links, each opening in a new tab. */
function SourceLinks({ urls }) {
  return urls.map((sourceUrl) => (
    <a
      key={sourceUrl}
      href={sourceUrl}
      target="_blank"
      rel="noreferrer"
      className="text-xs text-primary hover:underline flex items-center gap-1"
    >
      <ExternalLink className="h-3.5 w-3.5" />
      <span className="truncate">{sourceUrl}</span>
    </a>
  ));
}

/** One concept on the map, picked or not. */
function ConceptButton({ concept, selected, onToggle }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(concept.id)}
      className={`text-left rounded-xl border p-4 transition-all ${
        selected
          ? 'border-primary/70 bg-primary/10 shadow-[0_0_20px_rgba(var(--primary-rgb),0.18)]'
          : 'border-slate-700 bg-slate-800/40 hover:border-slate-500'
      }`}
    >
      <div className="text-sm font-semibold text-white">{concept.label}</div>
      <div className="text-xs text-slate-400 mt-2 line-clamp-3">
        {concept.summary || 'Click to inspect implementation guidance.'}
      </div>
    </button>
  );
}

/** The framework's summary, tags and every concept, to pick from. */
export function FrameworkMap({ framework, selectedConceptIds, onToggle }) {
  return (
    <Card className="bg-slate-900/40 border-slate-700">
      <CardHeader>
        <CardTitle className="text-white flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          Framework Map
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-slate-300">{framework.summary}</p>
        <div className="flex flex-wrap gap-2">
          {(framework.tags || []).map((tag) => (
            <Badge key={tag} variant="outline" className="border-slate-600 text-slate-300">
              {tag}
            </Badge>
          ))}
        </div>
        <Separator className="bg-slate-700" />
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {framework.concepts.map((concept) => (
            <ConceptButton
              key={concept.id}
              concept={concept}
              selected={selectedConceptIds.includes(concept.id)}
              onToggle={onToggle}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** One picked concept in full, with up to four sources. */
function ConceptCard({ concept }) {
  return (
    <Card className="bg-slate-900/40 border-slate-700">
      <CardHeader>
        <CardTitle className="text-white text-lg">{concept.label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-slate-300">{concept.summary || 'No summary yet.'}</p>
        <p className="text-slate-400 text-sm">
          {concept.details || 'Detailed implementation guidance is coming soon.'}
        </p>
        {concept.sources.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-slate-400">Sources</div>
            <SourceLinks urls={concept.sources.slice(0, 4)} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The picked concepts: one column for one, two side by side for two. */
export function ConceptCards({ concepts }) {
  if (concepts.length === 0) return null;
  return (
    <div
      className={`grid gap-4 ${
        concepts.length === 2 ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'
      }`}
    >
      {concepts.map((concept) => (
        <ConceptCard key={concept.id} concept={concept} />
      ))}
    </div>
  );
}

/** The architecture recommendation, and up to six of the framework's official sources. */
export function RecommendationCard({ recommendation, officialSources }) {
  return (
    <Card className="bg-slate-900/40 border-primary/40">
      <CardHeader>
        <CardTitle className="text-white flex items-center gap-2">
          <Lightbulb className="h-5 w-5 text-primary" />
          Architecture Recommendation
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-slate-300">
          {recommendation || 'Architecture recommendations are coming soon.'}
        </p>

        {officialSources.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-slate-400">Official Sources</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <SourceLinks urls={officialSources.slice(0, 6)} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** A plain card with one line: loading, or that nothing is published yet. */
export function NoticeCard({ children }) {
  return (
    <Card className="bg-slate-900/40 border-slate-700">
      <CardContent className="py-8 text-slate-400">{children}</CardContent>
    </Card>
  );
}

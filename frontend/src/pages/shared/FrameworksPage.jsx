/**
 * The framework explorer for a provider: pick a framework, pick one or two of
 * its concepts, and read their guidance and the architecture recommendation.
 * This file only arranges the sections in ./frameworks; the selection rules
 * are in ./frameworks/useFrameworkSelection.js.
 */
import React from 'react';
import { Helmet } from 'react-helmet-async';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { useFrameworkData } from '@/hooks/useFrameworkData';
import { useFrameworkSelection } from './frameworks/useFrameworkSelection';
import {
  ConceptCards,
  FrameworkMap,
  NoticeCard,
  RecommendationCard,
} from './frameworks/FrameworkSections';

const PROVIDER_META = {
  aws: { label: 'AWS' },
  azure: { label: 'Azure' },
  gcp: { label: 'GCP' },
  finops: { label: 'FinOps' },
};

/** The framework tabs along the top. */
function FrameworkTabs({ frameworks, activeId, onSelect }) {
  return (
    <div className="flex flex-wrap gap-2">
      {frameworks.map((framework) => (
        <button
          key={framework.id}
          type="button"
          onClick={() => onSelect(framework.id)}
          className={`px-3 py-2 rounded-lg border text-sm transition-colors ${
            framework.id === activeId
              ? 'bg-primary/20 border-primary/60 text-primary'
              : 'bg-slate-800/40 border-slate-700 text-slate-300 hover:border-slate-500'
          }`}
        >
          {framework.title}
        </button>
      ))}
    </div>
  );
}

export default function FrameworksPage({ provider = 'aws' }) {
  const navigate = useNavigate();
  const providerKey = String(provider || '').toLowerCase();
  const providerLabel = PROVIDER_META[providerKey]?.label || providerKey.toUpperCase();
  const { frameworks, loading } = useFrameworkData(providerKey);
  const {
    activeFramework,
    setActiveFrameworkId,
    selectedConceptIds,
    selectedConcepts,
    toggleConcept,
    architectureRecommendation,
  } = useFrameworkSelection(frameworks);
  const none = frameworks.length === 0;

  return (
    <>
      <Helmet>
        <title>{`${providerLabel} Frameworks | Hybrid Cloud Works`}</title>
        <meta
          name="description"
          content={`${providerLabel} framework explorer: compare framework concepts, implementation guidance and architecture recommendations.`}
        />
      </Helmet>

      <main className="flex-grow pt-28 pb-20 px-4 md:px-8 max-w-[1600px] mx-auto w-full space-y-8">
        <section className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-3xl sm:text-5xl font-black text-slate-900 dark:text-white tracking-tight">
                {providerLabel} Frameworks
              </h1>
              <p className="text-slate-700 dark:text-slate-400 mt-2 max-w-3xl">
                Select one or two framework concepts to compare implementation guidance and
                architecture recommendations.
              </p>
            </div>
            {activeFramework?.slug && (
              <Button
                onClick={() => navigate(`/${providerKey}/frameworks/${activeFramework.slug}`)}
              >
                View Full Framework
              </Button>
            )}
          </div>

          <FrameworkTabs
            frameworks={frameworks}
            activeId={activeFramework?.id}
            onSelect={setActiveFrameworkId}
          />
        </section>

        {loading && none && <NoticeCard>Loading frameworks...</NoticeCard>}

        {!loading && none && (
          <NoticeCard>
            No frameworks are published for {providerLabel} yet. Check back soon.
          </NoticeCard>
        )}

        {activeFramework && (
          <>
            <FrameworkMap
              framework={activeFramework}
              selectedConceptIds={selectedConceptIds}
              onToggle={toggleConcept}
            />

            <section className="space-y-4">
              <div className="text-sm text-slate-400">
                Selection mode:{' '}
                {selectedConcepts.length === 2 ? 'comparison (2-column)' : 'focus (1-column)'}
              </div>

              <ConceptCards concepts={selectedConcepts} />

              <RecommendationCard
                recommendation={architectureRecommendation}
                officialSources={activeFramework.officialSources}
              />
            </section>
          </>
        )}
      </main>
    </>
  );
}

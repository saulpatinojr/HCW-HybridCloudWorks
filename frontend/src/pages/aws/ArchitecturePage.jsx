import React from 'react';
import { Helmet } from 'react-helmet-async';
import { StaggerList } from '@/components/animations';
import { AccessibleButton } from '@/components/accessibility';
import { useNavigate, useParams } from 'react-router';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchPublicContentList } from '@/lib/publicApi';
import FeaturedArchitecture from '@/components/architecture/FeaturedArchitecture';
import {
  BlueprintCategoryCost,
  BlueprintStats,
  CheckboxGroup,
} from '@/pages/shared/architecture/ArchitectureParts';
import { staticBlueprints } from './architecture-blueprints';

// The two badges the hand-written panel showed, from the blueprint's own fields.
function featuredBadges(blueprint) {
  if (!blueprint) return [];
  return [
    { icon: 'verified', label: 'Production Ready', tone: 'green' },
    ...(blueprint.cost
      ? [{ icon: 'savings', label: blueprint.cost, tone: blueprint.costColor || 'blue' }]
      : []),
  ];
}

function mapComplexityToLevel(complexity) {
  if (complexity === 'High') return '400';
  if (complexity === 'Medium') return '300';
  return '200';
}

// A published design as this page's gallery shows it.
function toBlueprint(doc) {
  return {
    icon: 'architecture', // default icon
    category: doc.category || 'General',
    categoryColor: 'purple', // default color
    title: doc.title || doc.Title,
    slug: doc.slug,
    description: doc.summary || doc.Summary,
    rpo: 'N/A', // Dynamic fields might need extension or manual entry
    rto: 'N/A',
    level: mapComplexityToLevel(doc.complexity),
    cost: doc.costAnalysis?.estimatedMonthly || 'TBD',
    costColor: 'green',
  };
}

// Whether a published document belongs to the provider in the address.
function isForProvider(doc, provider) {
  return (
    (doc.cloudProvider || doc['Cloud Provider'] || 'aws').toLowerCase() === provider.toLowerCase()
  );
}

export default function ArchitecturePage() {
  const navigate = useNavigate();
  const { provider = 'aws' } = useParams();

  // Fetch dynamic blueprints from Content Forge — published-only server-side
  const { data: contentDocs, loading: contentLoading } = usePublicData(
    () => fetchPublicContentList({ type: 'architecture', limit: 250 }),
    'architecture:content'
  );

  const contentBlueprints = (contentDocs || [])
    .filter((doc) => isForProvider(doc, provider))
    .map(toBlueprint);

  const shouldLoadLegacy = !contentLoading && contentBlueprints.length === 0;
  const { data: dynamicDocs } = usePublicData(
    () => fetchPublicContentList({ type: 'architecture', limit: 250, source: 'blogs' }),
    shouldLoadLegacy ? 'architecture:legacy' : ''
  );

  const dynamicBlueprints =
    contentBlueprints.length > 0
      ? contentBlueprints
      : (dynamicDocs || []).filter((doc) => isForProvider(doc, provider)).map(toBlueprint);

  const blueprints = [...dynamicBlueprints, ...staticBlueprints];

  return (
    <>
      <Helmet>
        <title>AWS Architecture Designs | Hybrid Cloud Works</title>
        <meta
          name="description"
          content="Explore curated AWS architectural patterns and reference designs."
        />
      </Helmet>

      <main className="flex-grow max-w-[1440px] mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 grid grid-cols-1 xl:grid-cols-12 gap-8">
        {/* Sidebar */}
        <aside className="xl:col-span-3 flex flex-col gap-6 order-2 xl:order-1">
          <div className="glass-panel rounded-xl p-5 sticky top-24">
            <h3 className="text-sm font-bold uppercase tracking-wider mb-4 flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-[18px]">search</span>
              Find Blueprints
            </h3>
            <div className="relative mb-6">
              <input
                className="w-full bg-[hsl(var(--background))] border border-border-dark rounded-lg px-3 py-2.5 text-sm text-white placeholder-slate-500 focus:ring-1 focus:ring-primary focus:border-primary transition-all"
                placeholder="E.g., Global, DR, Serverless..."
                aria-label="E.g., Global, DR, Serverless..."
                type="text"
              />
              <span className="absolute right-3 top-2.5 text-slate-500 material-symbols-outlined text-[18px]">
                manage_search
              </span>
            </div>
            <div className="h-px bg-border-dark mb-6"></div>
            <div className="space-y-6">
              <CheckboxGroup
                title="Workload Type"
                items={['Serverless', 'Containers', 'Compute', 'Database', 'Networking']}
              />
              <CheckboxGroup
                title="Use Case"
                items={[
                  'Migration',
                  'Disaster Recovery',
                  'Analytics',
                  'Connectivity',
                  'FinOps & Cost',
                ]}
              />
            </div>
            <div className="mt-8 pt-6 border-t border-border-dark">
              <AccessibleButton variant="secondary" size="md" fullWidth>
                Reset Filters
              </AccessibleButton>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <div className="xl:col-span-9 flex flex-col gap-8 order-1 xl:order-2">
          {/* Header */}
          <div className="flex flex-col gap-2 relative">
            <div className="absolute -top-10 -left-10 w-64 h-64 bg-primary/5 rounded-full blur-3xl pointer-events-none"></div>
            <div className="flex flex-wrap items-baseline gap-4 relative z-10">
              <h1 className="text-2xl sm:text-4xl md:text-5xl font-black tracking-tight text-slate-900 dark:text-white">
                AWS Architectural <span className="text-aws-primary">Patterns</span> & Designs
              </h1>
            </div>
            <p className="text-slate-700 dark:text-slate-400 text-base sm:text-lg max-w-3xl relative z-10">
              Explore a curated library of battle-tested AWS solutions. From serverless event-driven
              architectures to multi-region active-active deployments.
            </p>
          </div>

          {/* Featured Blueprint — data-driven (T-409): the first blueprint, dynamic before static */}
          <FeaturedArchitecture design={blueprints[0]} badges={featuredBadges(blueprints[0])} />

          {/* Blueprint Gallery */}
          <div>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold flex items-center gap-2">
                <span className="w-1 h-6 bg-primary rounded-full"></span>
                Blueprint Gallery
              </h3>
              <div className="flex items-center gap-2 text-sm text-slate-400 bg-card-dark rounded-lg p-1 border border-border-dark">
                <AccessibleButton variant="primary" size="sm" className="px-3 py-1">
                  Grid
                </AccessibleButton>
                <AccessibleButton variant="ghost" size="sm" className="px-3 py-1">
                  List
                </AccessibleButton>
              </div>
            </div>
            <StaggerList
              staggerDelay={0.08}
              duration={0.6}
              animation="slideUp"
              className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
            >
              {blueprints.map((blueprint, idx) => (
                <div
                  key={idx}
                  className="bg-card-dark rounded-xl border border-border-dark overflow-hidden hover:border-primary/50 transition-all hover:shadow-[0_0_20px_-10px_rgba(var(--primary-rgb,255,153,0),0.3)] group flex flex-col h-full"
                >
                  <div className="aspect-[16/9] bg-[hsl(var(--background))] relative border-b border-border-dark p-4 group-hover:bg-[hsl(var(--hcw-bg-secondary))] transition-colors flex items-center justify-center">
                    <span className="material-symbols-outlined text-slate-600 text-[48px] group-hover:text-primary transition-colors duration-300">
                      {blueprint.icon}
                    </span>
                    <div className="absolute bottom-2 right-2 bg-black/60 backdrop-blur px-2 py-0.5 rounded text-[10px] text-white border border-slate-700">
                      SVG View
                    </div>
                  </div>
                  <div className="p-5 flex flex-col flex-grow">
                    <BlueprintCategoryCost blueprint={blueprint} />
                    <h3 className="font-bold text-lg mb-2 group-hover:text-primary transition-colors">
                      {blueprint.title}
                    </h3>
                    <p className="text-slate-400 text-sm mb-4">{blueprint.description}</p>
                    <BlueprintStats blueprint={blueprint} />
                    <AccessibleButton
                      variant="secondary"
                      size="md"
                      fullWidth
                      className="flex items-center justify-center gap-2"
                      onClick={() =>
                        navigate(`/${provider}/architecture-designs/${blueprint.slug}`)
                      }
                    >
                      Start Deep Dive
                      <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
                    </AccessibleButton>
                  </div>
                </div>
              ))}
            </StaggerList>
          </div>
        </div>
      </main>
    </>
  );
}

import React, { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { useNavigate } from 'react-router';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchPublicContentList } from '@/lib/publicApi';
import {
  CategoryFilterPanel,
  FeaturedMetrics,
  isProviderDoc,
  mapDynamicBlueprint,
} from '@/pages/shared/architecture/ArchitectureParts';
import { staticBlueprints } from './architecture-blueprints';

// This page's fallbacks for a published design that leaves them out.
const DYNAMIC_DEFAULTS = {
  category: 'Cost Analysis',
  icon: 'trending_down',
  categoryColor: 'text-emerald-400',
};

export default function ArchitecturePage() {
  const navigate = useNavigate();
  const categories = [
    'Cost Analysis',
    'Reporting',
    'Billing',
    'Automation',
    'Governance',
    'Optimization',
  ];
  const [selectedCategories, setSelectedCategories] = useState([]);

  const normalizeCategory = (value) => (categories.includes(value) ? value : categories[0]);

  // Published-only is enforced server-side by the public API.
  const { data: dynamicDocs } = usePublicData(
    () => fetchPublicContentList({ type: 'architecture', limit: 250 }),
    'architecture:content'
  );
  const dynamicBlueprints = (dynamicDocs || [])
    .filter((doc) => isProviderDoc(doc, 'finops'))
    .map((doc, index) => mapDynamicBlueprint(doc, index, normalizeCategory, DYNAMIC_DEFAULTS));

  const blueprints = [...dynamicBlueprints, ...staticBlueprints];

  const toggleCategory = (category) => {
    setSelectedCategories((prev) =>
      prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]
    );
  };

  const resetFilters = () => setSelectedCategories([]);

  const filteredArchitectures =
    selectedCategories.length === 0
      ? blueprints
      : blueprints.filter((bp) => selectedCategories.includes(bp.category));

  const featuredArch = filteredArchitectures.find((bp) => bp.featured) || filteredArchitectures[0];

  const categoryGradients = {
    'Cost Analysis': 'bg-gradient-to-br from-emerald-900/20 to-emerald-900/5 border-emerald-500/20',
    Reporting: 'bg-gradient-to-br from-blue-900/20 to-blue-900/5 border-blue-500/20',
    Billing: 'bg-gradient-to-br from-purple-900/20 to-purple-900/5 border-purple-500/20',
    Automation: 'bg-gradient-to-br from-yellow-900/20 to-yellow-900/5 border-yellow-500/20',
    Governance: 'bg-gradient-to-br from-red-900/20 to-red-900/5 border-red-500/20',
    Optimization: 'bg-gradient-to-br from-pink-900/20 to-pink-900/5 border-pink-500/20',
  };

  const categoryBadgeGradients = {
    'Cost Analysis': 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30',
    Reporting: 'bg-blue-500/20 text-blue-300 border border-blue-500/30',
    Billing: 'bg-purple-500/20 text-purple-300 border border-purple-500/30',
    Automation: 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30',
    Governance: 'bg-red-500/20 text-red-300 border border-red-500/30',
    Optimization: 'bg-pink-500/20 text-pink-300 border border-pink-500/30',
  };

  const categoryColors = {
    'Cost Analysis': 'text-emerald-400',
    Reporting: 'text-blue-400',
    Billing: 'text-purple-400',
    Automation: 'text-yellow-400',
    Governance: 'text-red-400',
    Optimization: 'text-pink-400',
  };

  return (
    <>
      <Helmet>
        <title>FinOps Reference Architectures | Hybrid Cloud Works</title>
        <meta
          name="description"
          content="Explore production-ready FinOps and cost optimization architectures"
        />
      </Helmet>
      <main className="flex-grow max-w-[1440px] mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 grid grid-cols-1 xl:grid-cols-12 gap-8">
        {/* Left Sidebar - Filters (Mobile: Bottom) */}
        <aside className="xl:col-span-3 order-2 xl:order-1 h-fit xl:sticky xl:top-28">
          <CategoryFilterPanel
            categories={categories}
            selected={selectedCategories}
            onToggle={toggleCategory}
            onReset={resetFilters}
            panelClass="bg-slate-800/40 backdrop-blur-md border border-slate-700 rounded-2xl p-6 hover:shadow-[0_0_25px_rgba(var(--primary-rgb,52,211,153),0.15)] hover:border-primary/50 transition-all duration-300"
            resetClass="w-full py-2 px-4 bg-slate-700/50 hover:bg-slate-600/50 text-slate-300 hover:text-white rounded-lg text-sm font-medium transition-colors border border-slate-600 flex items-center justify-center gap-2"
          />
        </aside>

        {/* Right Content - Featured + Gallery (Mobile: Top) */}
        <div className="xl:col-span-9 order-1 xl:order-2">
          {/* Featured Architecture */}
          {featuredArch && (
            <article
              className={`group mb-12 ${categoryGradients[featuredArch.category]} backdrop-blur-md border rounded-2xl overflow-hidden hover:shadow-[0_0_25px_rgba(var(--primary-rgb,52,211,153),0.15)] hover:border-primary/50 transition-all duration-300`}
            >
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 p-8">
                {/* Left: Text Content */}
                <div className="flex flex-col justify-center">
                  <div className="mb-4">
                    <span
                      className={`px-3 py-1 rounded text-xs font-medium ${categoryBadgeGradients[featuredArch.category]}`}
                    >
                      {featuredArch.category} • Featured
                    </span>
                  </div>
                  <h2 className="text-3xl font-bold mb-4">{featuredArch.title}</h2>
                  <p className="text-slate-300 mb-6">{featuredArch.description}</p>
                  <FeaturedMetrics arch={featuredArch} />
                  {featuredArch.slug && (
                    <button
                      onClick={() => navigate(`/finops/architecture-designs/${featuredArch.slug}`)}
                      className="inline-flex items-center gap-2 px-6 py-3 bg-primary hover:bg-emerald-600 text-primary-foreground font-bold rounded-lg transition-colors w-fit"
                    >
                      <span className="text-[18px] material-symbols-outlined">arrow_forward</span>
                      Read Full Blueprint
                    </button>
                  )}
                </div>

                {/* Right: Image/Metrics */}
                <div className="flex flex-col items-center justify-center">
                  <div className="w-full h-64 rounded-xl bg-gradient-to-br from-slate-700 to-slate-900 border border-slate-600 flex items-center justify-center overflow-hidden group-hover:scale-105 transition-transform duration-300">
                    <span
                      className={`text-6xl material-symbols-outlined ${categoryColors[featuredArch.category]}/40`}
                    >
                      {featuredArch.icon}
                    </span>
                  </div>
                  <div className="mt-6 w-full flex items-center gap-2 text-sm text-slate-400">
                    <span className="text-primary text-[16px] material-symbols-outlined">
                      verified
                    </span>
                    <span>Well-Architected Review: {featuredArch.waf}% Baseline</span>
                  </div>
                </div>
              </div>
            </article>
          )}

          {/* Architecture Gallery Grid */}
          <section>
            <h3 className="text-2xl font-bold mb-6 flex items-center gap-2">
              <span className="text-primary text-[24px] material-symbols-outlined">
                dashboard_customize
              </span>
              More Architectures
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {filteredArchitectures
                .filter((arch) => !arch.featured)
                .map((arch) => (
                  <article
                    key={arch.id}
                    className={`group ${categoryGradients[arch.category]} backdrop-blur-md border rounded-2xl overflow-hidden hover:shadow-[0_0_25px_rgba(var(--primary-rgb,52,211,153),0.15)] hover:border-primary/50 transition-all duration-300 flex flex-col`}
                  >
                    {/* Image Section */}
                    <div className="relative h-48 overflow-hidden bg-gradient-to-br from-slate-700 to-slate-900">
                      <div className="absolute inset-0 flex items-center justify-center opacity-50 group-hover:opacity-75 transition-opacity duration-300">
                        <span
                          className={`text-5xl material-symbols-outlined ${categoryColors[arch.category]}`}
                        >
                          {arch.icon}
                        </span>
                      </div>
                      <div className="absolute inset-0 group-hover:bg-gradient-to-t group-hover:from-slate-900 group-hover:via-transparent transition-all duration-300"></div>
                    </div>

                    {/* Content Section */}
                    <div className="p-6 flex-grow flex flex-col">
                      <div className="mb-3">
                        <span
                          className={`px-2 py-1 rounded text-xs font-medium ${categoryBadgeGradients[arch.category]}`}
                        >
                          {arch.category}
                        </span>
                      </div>
                      <h3 className="text-lg font-bold mb-2 line-clamp-2 group-hover:text-primary transition-colors">
                        {arch.title}
                      </h3>
                      <p className="text-sm text-slate-400 mb-4 line-clamp-2 flex-grow">
                        {arch.description}
                      </p>

                      {/* Metrics */}
                      <div className="border-t border-slate-700/50 pt-4 mb-4 flex items-center justify-between text-xs">
                        <div className="flex items-center gap-1 text-slate-400">
                          <span className="text-[14px] material-symbols-outlined">
                            check_circle
                          </span>
                          <span>WAF: {arch.waf}%</span>
                        </div>
                        <div className="flex items-center gap-1 text-slate-400">
                          <span className="text-[14px] material-symbols-outlined">schedule</span>
                          <span>RTO: {arch.rto}</span>
                        </div>
                      </div>

                      {/* Action Button */}
                      {arch.slug ? (
                        <button
                          onClick={() => navigate(`/finops/architecture-designs/${arch.slug}`)}
                          className="w-full py-2 px-4 bg-slate-700/50 hover:bg-primary hover:text-primary-foreground text-slate-300 rounded-lg text-sm font-medium transition-colors border border-slate-600 flex items-center justify-center gap-2 group/btn"
                        >
                          <span className="text-[16px] material-symbols-outlined">
                            arrow_forward
                          </span>
                          View Details
                        </button>
                      ) : (
                        <span className="w-full py-2 px-4 bg-slate-700/30 text-slate-500 rounded-lg text-sm font-medium border border-slate-700 flex items-center justify-center gap-2">
                          Reference Blueprint
                        </span>
                      )}
                    </div>
                  </article>
                ))}
            </div>
          </section>
        </div>
      </main>
    </>
  );
}

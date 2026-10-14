import React, { useState } from 'react';
import { useNavigate } from 'react-router';
import { Helmet } from 'react-helmet-async';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchPublicContentList } from '@/lib/publicApi';
import { staticBlueprints } from './architecture-blueprints';

function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}

function mapDynamicBlueprint(doc, index, normalizeCategory) {
  const category = normalizeCategory(firstPresent(doc.category, doc.Category, 'Compute'));
  return {
    id: firstPresent(doc.id, doc.slug, doc.Slug, `dynamic-${index}`),
    icon: firstPresent(doc.icon, 'hub'),
    category,
    categoryColor: 'text-blue-400',
    title: firstPresent(doc.title, doc.Title, 'Untitled Blueprint'),
    description: firstPresent(doc.summary, doc.Summary, doc.description, ''),
    rpo: firstPresent(doc.rpo, doc.RPO, 'N/A'),
    rto: firstPresent(doc.rto, doc.RTO, 'N/A'),
    level: firstPresent(doc.level, doc.complexity, 'Production'),
    cost: firstPresent(doc.costAnalysis?.estimatedMonthly, doc.cost, 'TBD'),
    costColor: firstPresent(doc.costColor, 'text-green-400'),
    featured: doc.featured === true || doc.Featured === true,
    waf: firstPresent(doc.waf, doc.wellArchitectedScore, 90),
    slug: firstPresent(doc.slug, doc.Slug),
  };
}

export default function ArchitecturePage() {
  const navigate = useNavigate();
  const categories = ['Compute', 'Data', 'Networking', 'AI/ML', 'Security', 'Serverless'];
  const [selectedCategories, setSelectedCategories] = useState([]);

  const normalizeCategory = (value) => (categories.includes(value) ? value : categories[0]);

  // Published-only is enforced server-side by the public API.
  const { data: dynamicDocs } = usePublicData(
    () => fetchPublicContentList({ type: 'architecture', limit: 250 }),
    'architecture:content'
  );
  const dynamicBlueprints = (dynamicDocs || [])
    .filter((doc) => (doc.cloudProvider || doc['Cloud Provider'] || 'gcp').toLowerCase() === 'gcp')
    .map((doc, index) => mapDynamicBlueprint(doc, index, normalizeCategory));

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
    Compute: 'bg-gradient-to-br from-blue-900/20 to-blue-900/5 border-blue-500/20',
    Data: 'bg-gradient-to-br from-yellow-900/20 to-yellow-900/5 border-yellow-500/20',
    Networking: 'bg-gradient-to-br from-purple-900/20 to-purple-900/5 border-purple-500/20',
    'AI/ML': 'bg-gradient-to-br from-pink-900/20 to-pink-900/5 border-pink-500/20',
    Security: 'bg-gradient-to-br from-red-900/20 to-red-900/5 border-red-500/20',
    Serverless: 'bg-gradient-to-br from-cyan-900/20 to-cyan-900/5 border-cyan-500/20',
  };

  const categoryBadgeGradients = {
    Compute: 'bg-blue-500/20 text-blue-300 border border-blue-500/30',
    Data: 'bg-yellow-500/20 text-yellow-300 border border-yellow-500/30',
    Networking: 'bg-purple-500/20 text-purple-300 border border-purple-500/30',
    'AI/ML': 'bg-pink-500/20 text-pink-300 border border-pink-500/30',
    Security: 'bg-red-500/20 text-red-300 border border-red-500/30',
    Serverless: 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30',
  };

  const categoryColors = {
    Compute: 'text-blue-400',
    Data: 'text-yellow-400',
    Networking: 'text-purple-400',
    'AI/ML': 'text-pink-400',
    Security: 'text-red-400',
    Serverless: 'text-cyan-400',
  };

  return (
    <>
      <Helmet>
        <title>GCP Reference Architectures | Hybrid Cloud Works</title>
        <meta
          name="description"
          content="Explore production-ready reference architectures for Google Cloud Platform"
        />
      </Helmet>
      <main className="flex-grow max-w-[1440px] mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 grid grid-cols-1 xl:grid-cols-12 gap-8">
        {/* Left Sidebar - Filters (Mobile: Bottom) */}
        <aside className="xl:col-span-3 order-2 xl:order-1 h-fit xl:sticky xl:top-28">
          <div className="bg-slate-800/40 backdrop-blur-md border border-slate-700 rounded-2xl p-6 hover:shadow-[0_0_25px_rgba(var(--primary-rgb,234,67,53),0.15)] hover:border-primary/50 transition-all duration-300">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold flex items-center gap-2">
                <span className="text-primary text-[20px] material-symbols-outlined">
                  filter_alt
                </span>
                Filters
              </h3>
            </div>

            {/* Category Checkboxes */}
            <div className="space-y-3 mb-6">
              {categories.map((category) => (
                <label key={category} className="flex items-center gap-3 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={selectedCategories.includes(category)}
                    onChange={() => toggleCategory(category)}
                    className="w-4 h-4 rounded border border-slate-600 bg-slate-700 checked:bg-primary checked:border-primary cursor-pointer"
                  />
                  <span className="text-sm text-slate-300 group-hover:text-white transition-colors">
                    {category}
                  </span>
                </label>
              ))}
            </div>

            {/* Reset Button */}
            {selectedCategories.length > 0 && (
              <button
                onClick={resetFilters}
                className="w-full h-11 px-4 bg-slate-700/50 hover:bg-slate-600/50 text-slate-300 hover:text-white rounded-lg text-sm font-medium transition-colors border border-slate-600 flex items-center justify-center gap-2"
              >
                <span className="text-[18px] material-symbols-outlined">restart_alt</span>
                Reset Filters
              </button>
            )}
          </div>
        </aside>

        {/* Right Content - Featured + Gallery (Mobile: Top) */}
        <div className="xl:col-span-9 order-1 xl:order-2">
          {/* Featured Architecture */}
          {featuredArch && (
            <article
              className={`group mb-12 ${categoryGradients[featuredArch.category]} backdrop-blur-md border rounded-2xl overflow-hidden hover:shadow-[0_0_25px_rgba(var(--primary-rgb,234,67,53),0.15)] hover:border-primary/50 transition-all duration-300`}
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
                  <div className="grid grid-cols-3 gap-4 mb-6">
                    <div className="bg-slate-900/50 rounded-lg p-3">
                      <span className="text-[10px] text-foreground uppercase font-bold">SLA</span>
                      <p className="text-xl font-bold text-white">{featuredArch.waf}%</p>
                    </div>
                    <div className="bg-slate-900/50 rounded-lg p-3">
                      <span className="text-[10px] text-foreground uppercase font-bold">RPO</span>
                      <p className="text-xl font-bold text-white">{featuredArch.rpo}</p>
                    </div>
                    <div className="bg-slate-900/50 rounded-lg p-3">
                      <span className="text-[10px] text-foreground uppercase font-bold">RTO</span>
                      <p className="text-xl font-bold text-white">{featuredArch.rto}</p>
                    </div>
                  </div>

                  {featuredArch.slug ? (
                    <button
                      onClick={() => navigate(`/gcp/architecture-designs/${featuredArch.slug}`)}
                      className="inline-flex items-center gap-2 px-6 h-11 bg-primary hover:bg-[hsl(var(--secondary))] text-primary-foreground font-bold rounded-lg transition-colors w-fit"
                    >
                      <span className="text-[18px] material-symbols-outlined">arrow_forward</span>
                      Read Full Blueprint
                    </button>
                  ) : (
                    <button className="inline-flex items-center gap-2 px-6 h-11 bg-primary hover:bg-[hsl(var(--secondary))] text-primary-foreground font-bold rounded-lg transition-colors w-fit">
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
                      hub
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
                    className={`group ${categoryGradients[arch.category]} backdrop-blur-md border rounded-2xl overflow-hidden hover:shadow-[0_0_25px_rgba(var(--primary-rgb,234,67,53),0.15)] hover:border-primary/50 transition-all duration-300 flex flex-col`}
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
                          onClick={() => navigate(`/gcp/architecture-designs/${arch.slug}`)}
                          className="w-full h-11 px-4 bg-slate-700/50 hover:bg-primary hover:text-primary-foreground text-slate-300 rounded-lg text-sm font-medium transition-colors border border-slate-600 flex items-center justify-center gap-2 group/btn"
                        >
                          <span className="text-[16px] material-symbols-outlined">
                            arrow_forward
                          </span>
                          View Details
                        </button>
                      ) : (
                        <button className="w-full h-11 px-4 bg-slate-700/50 hover:bg-primary hover:text-primary-foreground text-slate-300 rounded-lg text-sm font-medium transition-colors border border-slate-600 flex items-center justify-center gap-2 group/btn">
                          <span className="text-[16px] material-symbols-outlined">
                            arrow_forward
                          </span>
                          View Details
                        </button>
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

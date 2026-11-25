import React from 'react';
import { Link } from 'react-router';
import { getProviderPath } from '@/lib/routeFactory';
import ResourceLink, { resourceCta } from '@/components/education/ResourceLink';
import { DATA_AS_OF, LEVEL_META, certifications, appliedSkills } from '@/data/azure/certifications';

import { OfficialLinksSection } from '@/pages/shared/education/EducationSections';
import { StatusBadge, formatDate } from './azureTimeline';

// ── Constants ────────────────────────────────────────────────────────────────

export const FILTER_LEVELS = ['All', 'Fundamentals', 'Associate', 'Expert', 'Specialty'];

export const STATUS_FILTER = ['All', 'Active', 'Beta', 'Expiring', 'Retired'];

export const VISIBLE_COUNT = 4;

export const APPLIED_SKILL_AREAS = [
  'All',
  'AI',
  'AI Business',
  'Networking',
  'Security',
  'Storage',
  'Containers',
  'Data',
  'DevTools',
  'Operations',
];

export function getLevelFilterClass(levelFilter, level) {
  if (levelFilter !== level) {
    return 'bg-card/30 border-card/50 text-foreground/60 hover:text-foreground hover:border-foreground/40';
  }
  if (level === 'All') {
    return 'bg-primary/30 border-primary text-primary';
  }
  return `${LEVEL_META[level]?.badge ?? ''} border-current`;
}

export function getStatusFilterClass(statusFilter, status) {
  if (statusFilter !== status) {
    return 'bg-card/30 border-card/50 text-foreground/60 hover:text-foreground hover:border-foreground/40';
  }
  if (status === 'Beta') {
    return 'bg-amber-500/25 border-amber-400 text-amber-300';
  }
  if (status === 'Expiring') {
    return 'bg-rose-500/25 border-rose-400 text-rose-300';
  }
  if (status === 'Retired') {
    return 'bg-slate-500/25 border-slate-400 text-slate-300';
  }
  return 'bg-primary/30 border-primary text-primary';
}

/** The page's "Hero" section. */
export function EducationHero() {
  return (
    <>
      <section className="mb-12 relative">
        <div className="absolute -top-10 -left-10 w-96 h-96 bg-primary/5 blur-3xl rounded-full pointer-events-none" />
        <h1 className="text-3xl sm:text-5xl md:text-6xl font-bold mb-4 relative z-10">
          <span className="bg-clip-text text-transparent bg-linear-to-r from-azure-primary via-slate-900 to-azure-primary dark:via-white">
            Azure Education &amp; Certifications
          </span>
        </h1>
        <p className="text-base sm:text-lg text-foreground max-w-3xl relative z-10">
          Master Azure with structured learning paths, official certifications, and applied skills.
          Beta, retirement and replacement dates come from Microsoft Learn; this catalogue was last
          checked on{' '}
          <time dateTime={DATA_AS_OF} data-testid="data-as-of">
            {formatDate(DATA_AS_OF)}
          </time>
          .
        </p>
      </section>
    </>
  );
}

/** The two Microsoft posters: the certifications roadmap and Applied Skills. */
const POSTER_LINKS = [
  {
    href: 'https://aka.ms/CertificationsPoster',
    tone: 'azure',
    icon: 'workspace_premium',
    title: 'Microsoft Certifications Poster',
    badge: 'Official',
    address: 'aka.ms/CertificationsPoster',
    text: 'The official Microsoft Certifications roadmap — all role-based and specialty certifications in one poster, published by Microsoft.',
  },
  {
    href: 'https://go.microsoft.com/fwlink/?linkid=2321752',
    tone: 'azureCyan',
    icon: 'construction',
    title: 'Applied Skills Poster',
    badge: 'Scenario-Based',
    address: 'View Applied Skills Poster',
    text: 'Microsoft Applied Skills are scenario-based assessments that validate hands-on ability with specific Azure tasks. Complements certifications with practical proof.',
  },
];

/** The page's "Posters Banner" section. */
export function PostersBanner() {
  return <OfficialLinksSection links={POSTER_LINKS} />;
}

/** The page's "Browse Certifications Carousel" section. */
export function CertificationCarousel({
  carouselPage,
  filteredCerts,
  handleLevelFilter,
  handleStatusFilter,
  levelFilter,
  setCarouselPage,
  statusFilter,
  today,
  totalPages,
  visibleCerts,
}) {
  return (
    <>
      <section className="mb-16">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <h3 className="text-2xl font-bold text-slate-950 dark:text-white flex items-center gap-2">
            <span className="text-primary text-[24px] material-symbols-outlined" aria-hidden="true">
              school
            </span>
            Browse Certifications
          </h3>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap gap-3 mb-6">
          <div className="flex flex-wrap gap-2">
            {FILTER_LEVELS.map((level) => (
              <button
                key={level}
                onClick={() => handleLevelFilter(level)}
                className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all duration-200 ${getLevelFilterClass(levelFilter, level)}`}
              >
                {level}
              </button>
            ))}
          </div>
          <div className="w-px bg-card/50 hidden sm:block" />
          <div className="flex flex-wrap gap-2">
            {STATUS_FILTER.map((s) => (
              <button
                key={s}
                onClick={() => handleStatusFilter(s)}
                className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all duration-200 ${getStatusFilterClass(statusFilter, s)}`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 min-h-55">
          {visibleCerts.length === 0 ? (
            <div className="col-span-4 flex items-center justify-center py-16 text-foreground/50">
              No certifications match the selected filters.
            </div>
          ) : (
            visibleCerts.map((cert) => {
              const meta = LEVEL_META[cert.level];
              return (
                <article
                  key={cert.id}
                  className={`group bg-card/40 backdrop-blur-md border border-card/50 border-l-4 ${meta.accent} rounded-2xl p-6 hover:shadow-[0_0_20px_rgba(var(--primary-rgb,0,120,212),0.15)] hover:border-primary/40 transition-all duration-300 flex flex-col ${cert.status === 'expiring' ? 'opacity-80' : ''} ${cert.status === 'retired' ? 'opacity-60' : ''}`}
                  data-status={cert.status}
                >
                  <div className="flex items-start justify-between mb-2 gap-1 flex-wrap">
                    <span
                      className={`px-2.5 py-1 border text-[10px] font-bold rounded ${meta.badge}`}
                    >
                      {cert.level}
                    </span>
                    <span className="text-xs text-foreground/50 font-mono">
                      {cert.hours ? `${cert.hours}h` : '—'}
                    </span>
                  </div>

                  <StatusBadge
                    status={cert.status}
                    betaEndDate={cert.betaEndDate}
                    expiryDate={cert.expiryDate}
                    replacedBy={cert.replacedBy}
                    today={today}
                    className="mb-2 self-start"
                  />

                  <div className="text-xs font-mono text-foreground/40 mb-1">{cert.code}</div>
                  <h3 className="text-sm font-bold text-slate-950 dark:text-white mb-2 line-clamp-3 group-hover:text-primary transition-colors flex-1">
                    {cert.title}
                  </h3>
                  <p className="text-xs text-foreground mb-4 line-clamp-2">{cert.description}</p>

                  <div className="flex flex-wrap gap-1 mb-4">
                    {cert.topics.slice(0, 2).map((topic, i) => (
                      <span
                        key={i}
                        className="px-2 py-0.5 bg-card/50 text-foreground/60 text-[10px] rounded-full"
                      >
                        {topic}
                      </span>
                    ))}
                  </div>

                  <div className="mt-auto flex gap-2">
                    <Link
                      to={`/azure/education/${cert.slug}`}
                      className="flex-1 h-9 bg-card/50 hover:bg-primary hover:text-primary-foreground text-foreground rounded text-xs font-semibold transition-colors flex items-center justify-center"
                    >
                      View Details
                    </Link>
                    <a
                      href={cert.learnUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="h-9 w-9 bg-card/50 hover:bg-primary/20 text-foreground rounded flex items-center justify-center transition-colors"
                      title="Open on Microsoft Learn"
                      aria-label={`Open ${cert.code} on Microsoft Learn`}
                    >
                      <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                        open_in_new
                      </span>
                    </a>
                  </div>
                </article>
              );
            })
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 mt-6">
            <button
              onClick={() => setCarouselPage((p) => Math.max(0, p - 1))}
              disabled={carouselPage === 0}
              aria-label="Previous page"
              className="h-9 w-9 bg-card/40 hover:bg-card/60 disabled:opacity-30 border border-card/50 rounded-lg flex items-center justify-center transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                chevron_left
              </span>
            </button>
            {Array.from({ length: totalPages }).map((_, i) => (
              <button
                key={i}
                onClick={() => setCarouselPage(i)}
                aria-label={`Page ${i + 1} of ${totalPages}`}
                aria-current={i === carouselPage ? 'true' : undefined}
                className="group flex h-6 min-w-6 items-center justify-center rounded-full"
              >
                <span
                  aria-hidden="true"
                  className={`block h-2.5 rounded-full transition-all ${i === carouselPage ? 'bg-primary w-5' : 'w-2.5 bg-card/60 group-hover:bg-card/80'}`}
                />
              </button>
            ))}
            <button
              onClick={() => setCarouselPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={carouselPage === totalPages - 1}
              aria-label="Next page"
              className="h-9 w-9 bg-card/40 hover:bg-card/60 disabled:opacity-30 border border-card/50 rounded-lg flex items-center justify-center transition-colors"
            >
              <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
                chevron_right
              </span>
            </button>
            <span className="text-xs text-muted-foreground ml-2">
              {carouselPage * VISIBLE_COUNT + 1}–
              {Math.min((carouselPage + 1) * VISIBLE_COUNT, filteredCerts.length)} of{' '}
              {filteredCerts.length}
            </span>
          </div>
        )}
      </section>
    </>
  );
}

/** The page's "Featured Cert + Sidebar" section. */
export function FeaturedCertSection({ certs, featuredCert }) {
  return (
    <>
      <section className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8 mb-16">
        {featuredCert && (
          <article className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl overflow-hidden hover:shadow-[0_0_25px_rgba(var(--primary-rgb,0,120,212),0.15)] hover:border-primary/50 transition-all duration-300">
            <div className="grid grid-cols-1 lg:grid-cols-2">
              <div className="p-8 flex flex-col justify-between">
                <div>
                  <div className="mb-4 flex items-center gap-3 flex-wrap">
                    <span className="px-3 py-1 bg-primary/20 border border-primary/30 text-primary text-xs font-bold rounded">
                      Recommended Starting Point
                    </span>
                    <span
                      className={`px-3 py-1 border text-xs font-bold rounded ${LEVEL_META[featuredCert.level].badge}`}
                    >
                      {featuredCert.level}
                    </span>
                  </div>
                  <h2 className="text-2xl sm:text-3xl font-bold text-slate-950 dark:text-white mb-1">
                    {featuredCert.title}
                  </h2>
                  <div className="text-sm font-mono text-foreground/50 mb-3">
                    {featuredCert.code}
                  </div>
                  <p className="text-foreground mb-6">{featuredCert.longDescription}</p>
                </div>
                <div>
                  <h3 className="text-sm font-bold text-foreground uppercase tracking-wider mb-3">
                    Topics Covered
                  </h3>
                  <div className="grid grid-cols-2 gap-3 mb-8">
                    {featuredCert.topics.map((topic, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span
                          className="text-primary material-symbols-outlined text-[16px]"
                          aria-hidden="true"
                        >
                          check_circle
                        </span>
                        <span className="text-foreground text-sm">{topic}</span>
                      </div>
                    ))}
                  </div>
                  <Link
                    to={`/azure/education/${featuredCert.slug}`}
                    className="block w-full h-11 px-4 bg-primary hover:bg-blue-800 text-primary-foreground font-bold rounded-lg transition-colors text-center leading-11"
                  >
                    Start Preparation
                  </Link>
                </div>
              </div>
              <div className="bg-card/60 p-8 flex flex-col justify-between">
                <div className="space-y-6">
                  <div className="text-center">
                    <div className="text-4xl font-bold text-primary mb-2">{featuredCert.hours}</div>
                    <div className="text-sm text-foreground">Hours of Study</div>
                  </div>
                  <div className="border-t border-slate-700 pt-6 text-center">
                    <div className="text-3xl font-bold text-cyan-400 mb-2">
                      {featuredCert.successRate}
                    </div>
                    <div className="text-sm text-foreground">Average Success Rate</div>
                  </div>
                  <div className="border-t border-slate-700 pt-6 text-center">
                    <div className="text-sm text-foreground mb-2">Estimated Preparation</div>
                    <div className="text-2xl font-bold text-slate-950 dark:text-white">
                      {featuredCert.prepTime}
                    </div>
                  </div>
                </div>
                <div className="pt-6 border-t border-slate-700">
                  <a
                    href={featuredCert.learnUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block w-full h-11 px-4 bg-card/50 hover:bg-card/70 text-foreground font-semibold rounded-lg transition-colors text-sm text-center leading-11"
                  >
                    View on Microsoft Learn ↗
                  </a>
                </div>
              </div>
            </div>
          </article>
        )}

        {/* Sidebar */}
        <aside className="h-fit sticky top-28 space-y-6">
          <div className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6">
            <h3 className="text-lg font-bold text-slate-950 dark:text-white mb-4 flex items-center gap-2">
              <span
                className="text-primary text-[20px] material-symbols-outlined"
                aria-hidden="true"
              >
                emoji_events
              </span>
              All Certifications
            </h3>
            <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
              {certs.map((cert) => (
                <Link
                  key={cert.id}
                  to={`/azure/education/${cert.slug}`}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-card/50 transition-colors group"
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${LEVEL_META[cert.level].dot}`} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors line-clamp-1">
                      {cert.code}
                    </div>
                    <div className="text-xs text-foreground/50 line-clamp-1">
                      {cert.title.replace(/Microsoft\s+/i, '')}
                    </div>
                  </div>
                  {cert.status === 'beta' && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 bg-amber-500/20 text-amber-300 rounded shrink-0">
                      BETA
                    </span>
                  )}
                  {cert.status === 'expiring' && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 bg-rose-500/20 text-rose-300 rounded shrink-0">
                      EXPIRING
                    </span>
                  )}
                  {cert.status === 'retired' && (
                    <span className="text-[9px] font-bold px-1.5 py-0.5 bg-slate-500/20 text-slate-300 rounded shrink-0">
                      RETIRED
                    </span>
                  )}
                </Link>
              ))}
            </div>
            {/* Level legend */}
            <div className="mt-4 pt-4 border-t border-slate-700 grid grid-cols-2 gap-1.5">
              {Object.entries(LEVEL_META).map(([level, meta]) => (
                <div key={level} className="flex items-center gap-1.5 text-xs text-foreground/60">
                  <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
                  {level}
                </div>
              ))}
            </div>
          </div>

          <div className="bg-linear-to-br from-primary/20 to-blue-900/20 backdrop-blur-md border border-primary/30 rounded-2xl p-6">
            <h3 className="text-lg font-bold text-slate-950 dark:text-white mb-2 flex items-center gap-2">
              <span
                className="text-primary text-[20px] material-symbols-outlined"
                aria-hidden="true"
              >
                rocket_launch
              </span>
              Getting Started
            </h3>
            <p className="text-sm text-foreground mb-4">
              New to Azure? AZ-900 builds the foundation before any role-based certification.
            </p>
            <Link
              to={getProviderPath('azure', 'education/az-900')}
              className="block w-full h-11 px-4 bg-primary hover:bg-blue-800 text-primary-foreground font-bold rounded-lg transition-colors text-sm text-center leading-11"
            >
              Start with AZ-900
            </Link>
          </div>
        </aside>
      </section>
    </>
  );
}

/** The page's "Learning Paths" section. */
export function AzureLearningPaths({
  learningPaths,
  selectedPath,
  selectedPathId,
  setSelectedPathId,
}) {
  return (
    <>
      <section className="mb-16">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
          <h3 className="text-2xl font-bold text-slate-950 dark:text-white flex items-center gap-2">
            <span className="text-primary text-[24px] material-symbols-outlined" aria-hidden="true">
              bookmark
            </span>
            Learning Paths
          </h3>
          <div className="relative">
            <select
              value={selectedPathId}
              onChange={(e) => setSelectedPathId(Number(e.target.value))}
              className="appearance-none bg-card/40 backdrop-blur-md border border-card/50 text-foreground text-sm rounded-xl px-4 pr-10 h-10 hover:border-primary/50 focus:outline-none focus:border-primary transition-colors cursor-pointer"
            >
              {learningPaths.map((p) => (
                <option key={p.id} value={p.id} className="bg-slate-900">
                  {p.certCode} — {p.title}
                </option>
              ))}
            </select>
            <span
              className="absolute right-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-[16px] text-foreground pointer-events-none"
              aria-hidden="true"
            >
              expand_more
            </span>
          </div>
        </div>

        {selectedPath && (
          <article className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-8 hover:shadow-[0_0_25px_rgba(var(--primary-rgb,0,120,212),0.15)] hover:border-primary/50 transition-all duration-300">
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <span className="px-3 py-1 bg-primary/20 border border-primary/30 text-primary text-xs font-bold rounded">
                {selectedPath.certCode}
              </span>
              <span className="px-3 py-1 bg-card/50 text-foreground text-xs font-bold rounded">
                {selectedPath.level}
              </span>
            </div>
            <h2 className="text-3xl font-bold text-slate-950 dark:text-white mb-2">
              {selectedPath.title}
            </h2>
            <p className="text-foreground mb-6 text-lg">{selectedPath.description}</p>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
              <div className="bg-card/60 rounded-lg p-4">
                <div className="text-sm text-foreground mb-1">Total Hours</div>
                <div className="text-2xl font-bold text-primary">{selectedPath.hours}</div>
              </div>
              <div className="bg-card/60 rounded-lg p-4">
                <div className="text-sm text-foreground mb-1">Modules</div>
                <div className="text-2xl font-bold text-cyan-400">
                  {selectedPath.modules.length}
                </div>
              </div>
              {selectedPath.relatedAppliedSkills.length > 0 && (
                <div className="bg-card/60 rounded-lg p-4">
                  <div className="text-sm text-foreground mb-1">Applied Skills</div>
                  <div className="text-2xl font-bold text-amber-400">
                    {selectedPath.relatedAppliedSkills.length}
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px] gap-8">
              <div>
                <h3 className="text-sm font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-3">
                  Microsoft Learn Modules
                </h3>
                <div className="space-y-2">
                  {selectedPath.modules.map((mod, i) => (
                    <a
                      key={i}
                      href={mod.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 group/mod hover:text-primary transition-colors"
                    >
                      <span
                        className="text-primary material-symbols-outlined text-[16px] shrink-0"
                        aria-hidden="true"
                      >
                        check_circle
                      </span>
                      <span className="text-foreground group-hover/mod:text-primary text-sm transition-colors flex-1">
                        {mod.title}
                      </span>
                      <span
                        className="material-symbols-outlined text-[12px] text-foreground/40 group-hover/mod:text-primary transition-colors ml-auto shrink-0"
                        aria-hidden="true"
                      >
                        open_in_new
                      </span>
                    </a>
                  ))}
                </div>
              </div>

              <aside className="bg-card/50 border border-card/60 rounded-2xl p-5">
                <h3 className="text-sm font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-4">
                  Path Snapshot
                </h3>
                <div className="grid grid-cols-2 gap-3 mb-5">
                  <div className="rounded-xl bg-background/50 border border-card/60 p-3">
                    <div className="text-xs text-foreground/60 mb-1">Level</div>
                    <div className="text-sm font-bold text-slate-950 dark:text-white">
                      {selectedPath.level}
                    </div>
                  </div>
                  <div className="rounded-xl bg-background/50 border border-card/60 p-3">
                    <div className="text-xs text-foreground/60 mb-1">Credential</div>
                    <div className="text-sm font-bold text-slate-950 dark:text-white">
                      {selectedPath.certCode}
                    </div>
                  </div>
                </div>

                {selectedPath.relatedAppliedSkills.length > 0 && (
                  <>
                    <h3 className="text-sm font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-3">
                      Associated Applied Skills
                    </h3>
                    <div className="space-y-3 mb-5">
                      {selectedPath.relatedAppliedSkills.map((code) => {
                        const skill = appliedSkills.find((s) => s.code === code);
                        if (!skill) return null;
                        return (
                          <a
                            key={code}
                            href={skill.learnUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="group/skill flex items-start gap-3 bg-card/50 rounded-xl p-3 hover:bg-card/70 hover:border-cyan-500/30 border border-transparent transition-all"
                          >
                            <span
                              className="text-cyan-400 material-symbols-outlined text-[18px] shrink-0 mt-0.5"
                              aria-hidden="true"
                            >
                              construction
                            </span>
                            <div className="min-w-0">
                              <div className="text-xs font-mono text-foreground/50 mb-0.5">
                                {skill.code} · {skill.area}
                              </div>
                              <div className="text-sm font-semibold text-foreground group-hover/skill:text-cyan-300 transition-colors line-clamp-2">
                                {skill.title}
                              </div>
                            </div>
                            <span
                              className="material-symbols-outlined text-[12px] text-foreground/40 shrink-0 mt-1"
                              aria-hidden="true"
                            >
                              open_in_new
                            </span>
                          </a>
                        );
                      })}
                    </div>
                  </>
                )}

                <div className="space-y-3">
                  <a
                    href={selectedPath.certUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full h-11 px-4 bg-primary hover:bg-blue-800 text-primary-foreground font-bold rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                      open_in_new
                    </span>
                    Microsoft Learn
                  </a>
                  {certifications.find((c) => c.code === selectedPath.certCode) && (
                    <Link
                      to={`/azure/education/${certifications.find((c) => c.code === selectedPath.certCode)?.slug}`}
                      className="w-full h-11 px-4 bg-background/50 hover:bg-card/70 border border-card/60 text-foreground font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
                    >
                      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                        article
                      </span>
                      View Cert Detail
                    </Link>
                  )}
                </div>
              </aside>
            </div>
          </article>
        )}
      </section>
    </>
  );
}

/** The page's "Applied Skills Reference Library" section. */
export function AppliedSkillsLibrary({
  appliedSkillArea,
  appliedSkillsExpanded,
  filteredSkills,
  hasMoreAppliedSkills,
  setAppliedSkillArea,
  setAppliedSkillsExpanded,
  visibleAppliedSkills,
}) {
  return (
    <>
      <section className="mb-16">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
          <div>
            <h3 className="text-2xl font-bold text-slate-950 dark:text-white flex items-center gap-2">
              <span
                className="text-cyan-400 text-[24px] material-symbols-outlined"
                aria-hidden="true"
              >
                construction
              </span>
              Applied Skills Reference Library
            </h3>
            <p className="text-sm text-foreground mt-1 max-w-2xl">
              Scenario-based assessments validating hands-on ability with specific Azure tasks.
              Complements certifications with practical proof.
            </p>
          </div>
        </div>

        {/* Area filter */}
        <div className="flex flex-wrap gap-2 mb-6">
          {APPLIED_SKILL_AREAS.map((area) => (
            <button
              key={area}
              onClick={() => {
                setAppliedSkillArea(area);
                setAppliedSkillsExpanded(false);
              }}
              className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all duration-200 ${
                appliedSkillArea === area
                  ? 'bg-cyan-500/25 border-cyan-400 text-cyan-300'
                  : 'bg-card/30 border-card/50 text-foreground/60 hover:text-foreground hover:border-foreground/40'
              }`}
            >
              {area}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {visibleAppliedSkills.map((skill) => (
            <a
              key={skill.id}
              href={skill.learnUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group bg-card/40 backdrop-blur-md border border-card/50 border-l-4 border-l-cyan-500 rounded-2xl p-5 hover:shadow-[0_0_20px_rgba(0,188,212,0.15)] hover:border-cyan-500/50 transition-all duration-300 flex flex-col"
            >
              <div className="flex items-center justify-between mb-3">
                <span className="px-2.5 py-1 bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-[10px] font-bold rounded">
                  {skill.area}
                </span>
                <span className="text-foreground/40 text-[10px] font-mono">{skill.code}</span>
              </div>
              {skill.expiryDate && skill.status === 'retired' && (
                <span className="self-start mb-3 px-2 py-0.5 bg-slate-500/15 border border-slate-500/30 text-slate-300 text-[10px] font-bold rounded">
                  Retired {formatDate(skill.expiryDate)}
                </span>
              )}
              {skill.expiryDate && skill.status !== 'retired' && (
                <span className="self-start mb-3 px-2 py-0.5 bg-rose-500/15 border border-rose-500/30 text-rose-300 text-[10px] font-bold rounded">
                  Retires {formatDate(skill.expiryDate)}
                </span>
              )}
              <p className="text-sm font-semibold text-slate-950 dark:text-white group-hover:text-cyan-300 transition-colors line-clamp-3 flex-1 mb-3">
                {skill.title}
              </p>
              <div className="flex items-center gap-1 text-cyan-400 text-xs font-semibold mt-auto">
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                  open_in_new
                </span>
                Microsoft Learn
              </div>
            </a>
          ))}
        </div>

        {hasMoreAppliedSkills && (
          <div className="mt-6 flex justify-center">
            <button
              type="button"
              onClick={() => setAppliedSkillsExpanded((expanded) => !expanded)}
              className="h-10 px-4 bg-card/50 hover:bg-card/70 border border-card/60 hover:border-cyan-400/50 text-foreground hover:text-cyan-300 rounded-lg text-sm font-semibold transition-colors flex items-center gap-2"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                {appliedSkillsExpanded ? 'unfold_less' : 'unfold_more'}
              </span>
              {appliedSkillsExpanded
                ? 'Show fewer Applied Skills'
                : `See all ${filteredSkills.length} Applied Skills`}
            </button>
          </div>
        )}
      </section>
    </>
  );
}

/** The page's "Learning Resources" section. */
export function AzureLearningResources({ resources }) {
  return (
    <>
      <section>
        <h3 className="text-2xl font-bold text-slate-950 dark:text-white mb-6 flex items-center gap-2">
          <span className="text-primary text-[24px] material-symbols-outlined" aria-hidden="true">
            library_books
          </span>
          Learning Resources
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {resources.map((resource) => (
            <ResourceLink
              key={resource.id}
              resource={resource}
              className={`group backdrop-blur-md rounded-2xl p-6 transition-all duration-300 flex flex-col ${
                resource.highlight
                  ? 'bg-linear-to-br from-primary/20 to-blue-900/20 border border-primary/40 hover:shadow-[0_0_30px_rgba(0,120,212,0.25)] hover:border-primary/70'
                  : 'bg-card/40 border border-card/50 hover:shadow-[0_0_25px_rgba(var(--primary-rgb,0,120,212),0.15)] hover:border-primary/50'
              }`}
            >
              <div
                className={`mb-4 w-12 h-12 rounded-lg flex items-center justify-center group-hover:scale-110 transition-transform ${resource.highlight ? 'bg-primary/30' : 'bg-primary/20'}`}
              >
                <span
                  className="text-2xl material-symbols-outlined text-primary"
                  aria-hidden="true"
                >
                  {resource.icon}
                </span>
              </div>
              {resource.highlight && (
                <span className="self-start mb-2 px-2 py-0.5 bg-primary/25 border border-primary/40 text-primary text-[10px] font-bold rounded-full uppercase tracking-wider">
                  New
                </span>
              )}
              <h3 className="text-lg font-bold text-slate-950 dark:text-white mb-2 group-hover:text-primary transition-colors">
                {resource.title}
              </h3>
              <p className="text-foreground text-sm mb-4 grow">{resource.description}</p>
              <div className="flex items-center justify-between pt-4 border-t border-slate-700">
                <span className="text-sm font-bold text-primary">{resource.count}</span>
                <span className="flex items-center gap-1.5 text-foreground text-sm font-semibold group-hover:text-primary transition-colors">
                  {resourceCta(resource).label}
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                    {resourceCta(resource).icon}
                  </span>
                </span>
              </div>
            </ResourceLink>
          ))}
        </div>
      </section>
    </>
  );
}

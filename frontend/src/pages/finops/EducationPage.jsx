import React, { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import CatalogueFreshness from '@/components/education/CatalogueFreshness';
import CertStatusBadge from '@/components/education/CertStatusBadge';
import FeaturedCertSection from '@/components/education/FeaturedCertSection';
import { DATA_AS_OF, DATA_SOURCE, certifications } from '@/data/finops/education';
import { deriveStatus, useToday } from '@/lib/certStatus';

// ── Constants ────────────────────────────────────────────────────────────────

const LEVEL_META = {
  Practitioner: {
    badge: 'bg-sky-500/20 border-sky-500/40 text-sky-300',
    accent: 'border-l-sky-500',
    dot: 'bg-sky-500',
    label: 'Practitioner',
  },
  Professional: {
    badge: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300',
    accent: 'border-l-emerald-500',
    dot: 'bg-emerald-500',
    label: 'Professional',
  },
  Expert: {
    badge: 'bg-violet-500/20 border-violet-500/40 text-violet-300',
    accent: 'border-l-violet-500',
    dot: 'bg-violet-500',
    label: 'Expert',
  },
};

const FILTER_LEVELS = ['All', 'Practitioner', 'Professional', 'Expert'];
const STATUS_FILTER = ['All', 'Active'];
const VISIBLE_COUNT = 4;

// The hub's colour classes, handed to the shared featured section so its
// markup names no colour. Full class strings, so Tailwind sees them.
const TONE = {
  accentText: 'text-emerald-400',
  articleHover: 'hover:shadow-[0_0_25px_rgba(16,185,129,0.15)] hover:border-emerald-400/50',
  badge: 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-300',
  button: 'bg-emerald-600 hover:bg-emerald-500 text-white',
  gettingStartedCard:
    'bg-gradient-to-br from-emerald-500/20 to-teal-900/20 backdrop-blur-md border border-emerald-500/30',
};

/** The hub's own link to the issuer's full catalogue, under the featured credential. */
const ALL_CERTS = {
  href: 'https://www.finops.org/certification/',
  label: 'View All FinOps Certs ↗',
};

/** The "Getting Started" card beside the catalogue: where a newcomer begins. */
const GETTING_STARTED = {
  text: 'New to FinOps? FOCP (FinOps Certified Practitioner) is the standard entry point and prerequisite knowledge for all advanced FinOps roles.',
  href: 'https://www.finops.org/certification/finops-certified-practitioner/',
  label: 'Start with FOCP',
};

function getLevelFilterClass(levelFilter, level) {
  if (levelFilter !== level) {
    return 'bg-card/30 border-card/50 text-foreground/60 hover:text-foreground hover:border-foreground/40';
  }
  if (level === 'All') {
    return 'bg-emerald-500/30 border-emerald-400 text-emerald-300';
  }
  return `${LEVEL_META[level]?.badge ?? ''} border-current`;
}

// ── Data ─────────────────────────────────────────────────────────────────────

// The certification catalogue is src/data/finops/education.js (#461 item 11),
// verified against learn.finops.org and dated; only the page-local learning
// paths and resources stay here.

const learningPaths = [
  {
    id: 0,
    certCode: 'FOCP',
    title: 'FinOps Practitioner Path',
    level: 'Beginner',
    hours: 20,
    description:
      'Build a strong FinOps foundation with cloud cost fundamentals, the FOCUS 1.4 schema, allocation strategies, and optimization patterns for practitioners.',
    modules: [
      { title: 'Cloud Cost Fundamentals' },
      { title: 'FOCUS 1.4 Schema Overview' },
      { title: 'Allocation & Showback' },
      { title: 'Cost Optimization Patterns' },
    ],
    certUrl: 'https://learn.finops.org/path/finops-certified-practitioner-self-paced',
  },
  {
    id: 1,
    certCode: 'FOCE',
    title: 'FinOps Certified Engineer Path',
    level: 'Intermediate',
    hours: 15,
    description:
      'Apply FinOps practices in engineering workflows — tagging governance, budget policies, rightsizing, spot instance usage, and FinOps API automation.',
    modules: [
      { title: 'Tagging Strategies' },
      { title: 'Budget Alerts & Policies' },
      { title: 'Rightsize & Spot' },
      { title: 'Automation with FinOps APIs' },
    ],
    certUrl: 'https://learn.finops.org/page/finops-certified-engineer',
  },
  {
    id: 2,
    certCode: 'FOCB',
    title: 'FinOps Professional Path',
    level: 'Advanced',
    hours: 40,
    description:
      'Lead FinOps culture and strategy across the organization — from multi-cloud governance and benchmarking to executive-level financial reporting.',
    modules: [
      { title: 'FinOps Strategy & Culture' },
      { title: 'Multi-Cloud Governance' },
      { title: 'Benchmarking' },
      { title: 'Executive Reporting' },
    ],
    certUrl: 'https://learn.finops.org/path/finops-certified-professional',
  },
];

const resources = [
  {
    id: 'finops-foundation',
    title: 'FinOps Foundation Site',
    description:
      'The official FinOps Foundation — home of the FinOps framework, community, certifications, and working groups.',
    type: 'Community',
    icon: 'groups',
    url: 'https://www.finops.org/',
  },
  {
    id: 'focus-spec',
    title: 'FOCUS Spec Docs',
    description:
      'The FinOps Open Cost and Usage Specification (FOCUS) — a vendor-neutral billing data schema adopted by AWS, Azure, GCP, and OCI.',
    type: 'Specification',
    icon: 'description',
    url: 'https://focus.finops.org/',
  },
  {
    id: 'finops-x',
    title: 'FinOps X Conference Videos',
    description:
      'On-demand sessions from FinOps X — the flagship FinOps Foundation conference covering strategy, tooling, and real-world case studies.',
    type: 'Video',
    icon: 'play_circle',
    url: 'https://www.finops.org/community/finopsx/',
  },
  {
    id: 'cost-tools',
    title: 'Cloud Cost Tools',
    description:
      'Open source and SaaS tools for cloud cost visibility — including Infracost for Terraform cost estimation and OpenCost for Kubernetes cost monitoring.',
    type: 'Tools',
    icon: 'build',
    url: 'https://www.infracost.io/',
  },
  {
    id: 'finops-slack',
    title: 'FinOps Community Slack',
    description:
      'Join 10,000+ FinOps practitioners in the official FinOps Foundation Slack — ask questions, share learnings, and connect with peers.',
    type: 'Community',
    icon: 'chat',
    url: 'https://www.finops.org/community/',
  },
  {
    id: 'exam-guide',
    title: 'FinOps Practitioner Exam Guide',
    description:
      'Official exam guide with domains, objectives, and recommended study materials for the FinOps Certified Practitioner (FOCP) exam.',
    type: 'Exam Guide',
    icon: 'checklist',
    url: 'https://learn.finops.org/finops-certified-practitioner-certification-exam',
  },
];

// ── Page ─────────────────────────────────────────────────────────────────────

export default function FinOpsEducationPage() {
  const [levelFilter, setLevelFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [carouselPage, setCarouselPage] = useState(0);
  const [selectedPathId, setSelectedPathId] = useState(0);
  const today = useToday(DATA_AS_OF);

  const featuredCert = certifications.find((c) => c.featured);

  const filteredCerts = certifications.filter((c) => {
    const levelOk = levelFilter === 'All' || c.level === levelFilter;
    const statusOk =
      statusFilter === 'All' || deriveStatus(c, today) === statusFilter.toLowerCase();
    return levelOk && statusOk;
  });

  const totalPages = Math.ceil(filteredCerts.length / VISIBLE_COUNT);
  const visibleCerts = filteredCerts.slice(
    carouselPage * VISIBLE_COUNT,
    carouselPage * VISIBLE_COUNT + VISIBLE_COUNT
  );

  const selectedPath = learningPaths[selectedPathId];

  const handleLevelFilter = (l) => {
    setLevelFilter(l);
    setCarouselPage(0);
  };
  const handleStatusFilter = (s) => {
    setStatusFilter(s);
    setCarouselPage(0);
  };

  return (
    <>
      <Helmet>
        <title>FinOps Education &amp; Certifications | HCW</title>
        <meta
          name="description"
          content="FinOps Foundation certification prep, learning paths, and resources — covering the FinOps Certified Practitioner, Engineer, FOCUS Analyst, AI Value, Technology Value, and Professional credentials."
        />
        <meta property="og:title" content="FinOps Education & Certifications" />
        <meta
          property="og:description"
          content="Structured learning paths, certification prep, and curated resources for FinOps Foundation certifications."
        />
      </Helmet>

      <main className="flex-grow pt-28 pb-20 px-4 md:px-8 max-w-[1440px] mx-auto w-full">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className="mb-12 relative">
          <div className="absolute -top-10 -left-10 w-96 h-96 bg-emerald-500/5 blur-3xl rounded-full pointer-events-none" />
          <div className="absolute -top-5 right-0 w-72 h-72 bg-teal-500/5 blur-3xl rounded-full pointer-events-none" />
          <h1 className="text-3xl sm:text-5xl md:text-6xl font-bold mb-4 relative z-10">
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-finops-primary via-slate-900 to-finops-primary dark:via-white">
              FinOps Education &amp; Certifications
            </span>
          </h1>
          <p className="text-base sm:text-lg text-foreground max-w-3xl relative z-10">
            Master cloud financial management with FinOps Foundation certifications — from
            Practitioner fundamentals through Professional-level strategy and engineering tracks.
          </p>
          <div className="flex flex-wrap gap-2 mt-4 relative z-10">
            {['Practitioner', 'Professional', 'Expert'].map((level) => (
              <span
                key={level}
                className={`px-3 py-1 border text-xs font-bold rounded-full ${LEVEL_META[level].badge}`}
              >
                {level}
              </span>
            ))}
          </div>
        </section>

        {/* ── Official Resources Banner ─────────────────────────────────── */}
        <section className="mb-12">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <a
              href="https://www.finops.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="group relative bg-gradient-to-br from-emerald-900/40 to-card/40 backdrop-blur-md border border-emerald-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(16,185,129,0.2)] hover:border-emerald-400/60 transition-all duration-300 flex items-start gap-5"
            >
              <div className="w-14 h-14 shrink-0 bg-emerald-500/20 rounded-xl flex items-center justify-center">
                <span
                  className="text-emerald-400 text-[28px] material-symbols-outlined"
                  aria-hidden="true"
                >
                  workspace_premium
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h2 className="text-lg font-bold text-slate-950 dark:text-white group-hover:text-emerald-300 transition-colors">
                    FinOps Foundation
                  </h2>
                  <span className="px-2 py-0.5 bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-[10px] font-bold rounded-full uppercase tracking-wider shrink-0">
                    Official
                  </span>
                </div>
                <p className="text-sm text-foreground mb-3">
                  The official home of the FinOps framework, community, certifications, and working
                  groups — the definitive resource for cloud financial management.
                </p>
                <div className="flex items-center gap-1.5 text-emerald-400 text-sm font-semibold">
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    open_in_new
                  </span>
                  finops.org
                </div>
              </div>
            </a>

            <a
              href="https://focus.finops.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="group relative bg-gradient-to-br from-teal-900/40 to-card/40 backdrop-blur-md border border-teal-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(20,184,166,0.2)] hover:border-teal-400/60 transition-all duration-300 flex items-start gap-5"
            >
              <div className="w-14 h-14 shrink-0 bg-teal-500/20 rounded-xl flex items-center justify-center">
                <span
                  className="text-teal-400 text-[28px] material-symbols-outlined"
                  aria-hidden="true"
                >
                  construction
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h2 className="text-lg font-bold text-slate-950 dark:text-white group-hover:text-teal-300 transition-colors">
                    FOCUS Specification
                  </h2>
                  <span className="px-2 py-0.5 bg-teal-500/20 border border-teal-500/30 text-teal-300 text-[10px] font-bold rounded-full uppercase tracking-wider shrink-0">
                    Open Standard
                  </span>
                </div>
                <p className="text-sm text-foreground mb-3">
                  The FinOps Open Cost and Usage Specification — a vendor-neutral billing data
                  schema adopted by AWS, Azure, Google Cloud, and OCI for normalized cost data.
                </p>
                <div className="flex items-center gap-1.5 text-teal-400 text-sm font-semibold">
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    open_in_new
                  </span>
                  focus.finops.org
                </div>
              </div>
            </a>
          </div>
        </section>

        {/* ── Browse Certifications Carousel ───────────────────────────── */}
        <section className="mb-16">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <div>
              <h3 className="text-2xl font-bold text-slate-950 dark:text-white flex items-center gap-2">
                <span
                  className="text-emerald-400 text-[24px] material-symbols-outlined"
                  aria-hidden="true"
                >
                  school
                </span>
                Browse Certifications
              </h3>
              <CatalogueFreshness asOf={DATA_AS_OF} source={DATA_SOURCE} className="mt-1" />
            </div>
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
                  className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-all duration-200 ${
                    statusFilter === s
                      ? 'bg-emerald-500/25 border-emerald-400 text-emerald-300'
                      : 'bg-card/30 border-card/50 text-foreground/60 hover:text-foreground hover:border-foreground/40'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 min-h-[220px]">
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
                    className={`group bg-card/40 backdrop-blur-md border border-card/50 border-l-4 ${meta.accent} rounded-2xl p-6 hover:shadow-[0_0_20px_rgba(16,185,129,0.15)] hover:border-emerald-400/40 transition-all duration-300 flex flex-col`}
                  >
                    <div className="flex items-start justify-between mb-2 gap-1 flex-wrap">
                      <span
                        className={`px-2.5 py-1 border text-[10px] font-bold rounded ${meta.badge}`}
                      >
                        {cert.level}
                      </span>
                      {cert.hours ? (
                        // Only where the Foundation publishes a duration. It
                        // sizes AI Value and Technology Value in modules, not
                        // hours, and `{undefined}h` would render "undefinedh".
                        <span className="text-xs text-foreground/50 font-mono">{cert.hours}h</span>
                      ) : null}
                    </div>
                    <div className="text-xs font-mono text-foreground/40 mb-1">{cert.code}</div>
                    <CertStatusBadge cert={cert} today={today} className="self-start mb-2" />
                    <h3 className="text-sm font-bold text-slate-950 dark:text-white mb-2 line-clamp-3 group-hover:text-emerald-300 transition-colors flex-1">
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
                      <a
                        href={cert.learnUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 h-9 bg-card/50 hover:bg-emerald-500/20 hover:text-emerald-300 text-foreground rounded text-xs font-semibold transition-colors flex items-center justify-center gap-1"
                      >
                        View Details
                        <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
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
                    className={`block h-2.5 rounded-full transition-all ${i === carouselPage ? 'bg-emerald-400 w-5' : 'w-2.5 bg-card/60 group-hover:bg-card/80'}`}
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
              <span className="text-xs text-foreground/50 ml-2">
                {carouselPage * VISIBLE_COUNT + 1}–
                {Math.min((carouselPage + 1) * VISIBLE_COUNT, filteredCerts.length)} of{' '}
                {filteredCerts.length}
              </span>
            </div>
          )}
        </section>

        {/* ── Featured Cert + Sidebar ──────────────────────────────────── */}
        <FeaturedCertSection
          featuredCert={featuredCert}
          certifications={certifications}
          levelMeta={LEVEL_META}
          allCerts={ALL_CERTS}
          gettingStarted={GETTING_STARTED}
          tone={TONE}
        />

        {/* ── Learning Paths ───────────────────────────────────────────── */}
        <section className="mb-16">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <h3 className="text-2xl font-bold text-slate-950 dark:text-white flex items-center gap-2">
              <span
                className="text-emerald-400 text-[24px] material-symbols-outlined"
                aria-hidden="true"
              >
                bookmark
              </span>
              Learning Paths
            </h3>
            <div className="relative">
              <select
                value={selectedPathId}
                onChange={(e) => setSelectedPathId(Number(e.target.value))}
                className="appearance-none bg-card/40 backdrop-blur-md border border-card/50 text-foreground text-sm rounded-xl px-4 pr-10 h-10 hover:border-emerald-400/50 focus:outline-none focus:border-emerald-400 transition-colors cursor-pointer"
              >
                {learningPaths.map((p, i) => (
                  <option key={i} value={i} className="bg-slate-900">
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
            <article className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-8 hover:shadow-[0_0_25px_rgba(16,185,129,0.15)] hover:border-emerald-400/50 transition-all duration-300">
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <span className="px-3 py-1 bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-xs font-bold rounded font-mono">
                  {selectedPath.certCode}
                </span>
                <span className="px-3 py-1 bg-card/50 text-foreground text-xs font-bold rounded">
                  {selectedPath.level}
                </span>
                <span className="text-sm text-foreground/60">{selectedPath.hours} hours</span>
              </div>
              <h2 className="text-3xl font-bold text-slate-950 dark:text-white mb-2">
                {selectedPath.title}
              </h2>
              <p className="text-foreground mb-6 text-lg">{selectedPath.description}</p>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
                <div className="bg-card/60 rounded-lg p-4">
                  <div className="text-sm text-foreground mb-1">Total Hours</div>
                  <div className="text-2xl font-bold text-emerald-400">{selectedPath.hours}</div>
                </div>
                <div className="bg-card/60 rounded-lg p-4">
                  <div className="text-sm text-foreground mb-1">Modules</div>
                  <div className="text-2xl font-bold text-teal-400">
                    {selectedPath.modules.length}
                  </div>
                </div>
              </div>

              <h3 className="text-sm font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-3">
                Modules
              </h3>
              <div className="space-y-2">
                {selectedPath.modules.map((mod, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 p-3 bg-card/30 rounded-lg border border-card/40"
                  >
                    <span className="w-6 h-6 rounded-full bg-emerald-500/20 text-emerald-300 text-xs font-bold flex items-center justify-center shrink-0">
                      {i + 1}
                    </span>
                    <span className="text-sm text-foreground">{mod.title}</span>
                  </div>
                ))}
              </div>

              <div className="mt-8 flex flex-col sm:flex-row gap-3">
                <a
                  href={selectedPath.certUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 h-11 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    open_in_new
                  </span>
                  View {selectedPath.certCode} on FinOps Foundation
                </a>
              </div>
            </article>
          )}
        </section>

        {/* ── Learning Resources ───────────────────────────────────────── */}
        <section className="mb-16">
          <h3 className="text-2xl font-bold text-slate-950 dark:text-white mb-6 flex items-center gap-2">
            <span
              className="text-emerald-400 text-[24px] material-symbols-outlined"
              aria-hidden="true"
            >
              library_books
            </span>
            Learning Resources
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {resources.map((resource) => (
              <a
                key={resource.id}
                href={resource.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6 flex flex-col hover:shadow-[0_0_25px_rgba(16,185,129,0.15)] hover:border-emerald-400/50 transition-all duration-300"
              >
                <div className="w-12 h-12 rounded-xl bg-emerald-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                  <span
                    className="material-symbols-outlined text-emerald-400 text-[24px]"
                    aria-hidden="true"
                  >
                    {resource.icon}
                  </span>
                </div>
                <div className="text-xs font-bold text-emerald-400/70 uppercase tracking-wider mb-1">
                  {resource.type}
                </div>
                <h4 className="font-bold text-slate-950 dark:text-white mb-2 group-hover:text-emerald-300 transition-colors">
                  {resource.title}
                </h4>
                <p className="text-xs text-foreground flex-1">{resource.description}</p>
                <div className="mt-4 flex items-center gap-1 text-emerald-400 text-xs font-semibold">
                  Explore{' '}
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                    open_in_new
                  </span>
                </div>
              </a>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}

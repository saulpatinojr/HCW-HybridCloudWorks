import React, { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router';
import CatalogueFreshness from '@/components/education/CatalogueFreshness';
import CertStatusBadge from '@/components/education/CertStatusBadge';
import { DATA_AS_OF, DATA_SOURCE, certifications } from '@/data/aws/certifications';
import { useToday } from '@/lib/certStatus';

// ── Constants ────────────────────────────────────────────────────────────────

const LEVEL_META = {
  Business: {
    badge: 'bg-rose-500/20 border-rose-500/40 text-rose-300',
    accent: 'border-l-rose-500',
    dot: 'bg-rose-500',
    label: 'Business',
  },
  Foundational: {
    badge: 'bg-sky-500/20 border-sky-500/40 text-sky-300',
    accent: 'border-l-sky-500',
    dot: 'bg-sky-500',
    label: 'Foundational',
  },
  Associate: {
    badge: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300',
    accent: 'border-l-emerald-500',
    dot: 'bg-emerald-500',
    label: 'Associate',
  },
  Professional: {
    badge: 'bg-violet-500/20 border-violet-500/40 text-violet-300',
    accent: 'border-l-violet-500',
    dot: 'bg-violet-500',
    label: 'Professional',
  },
  Specialty: {
    badge: 'bg-amber-500/20 border-amber-500/40 text-amber-300',
    accent: 'border-l-amber-500',
    dot: 'bg-amber-500',
    label: 'Specialty',
  },
};

const FILTER_LEVELS = ['All', 'Business', 'Foundational', 'Associate', 'Professional', 'Specialty'];

function getLevelFilterClass(levelFilter, level) {
  if (levelFilter !== level) {
    return 'bg-card/30 border-card/50 text-foreground/60 hover:text-foreground hover:border-foreground/40';
  }
  if (level === 'All') {
    return 'bg-amber-500/30 border-amber-400 text-amber-300';
  }
  return `${LEVEL_META[level]?.badge ?? ''} border-current`;
}

const VISIBLE_COUNT = 4;

// ── Data ─────────────────────────────────────────────────────────────────────

const learningPaths = [
  {
    id: 0,
    certCode: 'CLF-C02',
    title: 'Cloud Practitioner Path',
    level: 'Beginner',
    hours: 10,
    description:
      'Build cloud fluency from the ground up with core AWS concepts, services, billing, and the shared responsibility model.',
    modules: [
      { title: 'Cloud Concepts' },
      { title: 'AWS Core Services' },
      { title: 'Security & Compliance' },
      { title: 'Billing & Pricing' },
    ],
    certUrl: 'https://aws.amazon.com/certification/certified-cloud-practitioner/',
  },
  {
    id: 1,
    certCode: 'SAA-C03',
    title: 'Solutions Architect Path',
    level: 'Intermediate',
    hours: 40,
    description:
      'Design and implement resilient, high-performing, and cost-optimized architectures across core AWS services.',
    modules: [
      { title: 'Compute' },
      { title: 'Storage' },
      { title: 'Databases' },
      { title: 'Networking' },
      { title: 'Security' },
      { title: 'Cost Optimization' },
    ],
    certUrl: 'https://aws.amazon.com/certification/certified-solutions-architect-associate/',
  },
  {
    id: 2,
    certCode: 'DOP-C02',
    title: 'DevOps Engineer Path',
    level: 'Advanced',
    hours: 55,
    description:
      'Implement DevOps practices for CI/CD pipelines, infrastructure as code, monitoring, and incident management on AWS.',
    modules: [
      { title: 'CI/CD Pipelines' },
      { title: 'IaC with CloudFormation' },
      { title: 'Monitoring' },
      { title: 'Incident Response' },
    ],
    certUrl: 'https://aws.amazon.com/certification/certified-devops-engineer-professional/',
  },
];

const resources = [
  {
    id: 'ramp-up',
    title: 'AWS Ramp-Up Guides',
    description:
      'Curated learning journeys organized by role and domain — structured sequences of courses, videos, and labs to build AWS skills fast.',
    type: 'Learning Guides',
    icon: 'route',
    url: 'https://aws.amazon.com/training/ramp-up-guides/',
  },
  {
    id: 'training-live',
    title: 'AWS Training Live',
    description:
      'Live and on-demand training sessions hosted on Twitch by AWS instructors — free to watch, covering services, architecture patterns, and exam prep.',
    type: 'Live Training',
    icon: 'live_tv',
    url: 'https://aws.amazon.com/training/twitch/',
  },
  {
    id: 'well-architected',
    title: 'AWS Well-Architected Labs',
    description:
      'Hands-on labs aligned to the 6 pillars of the AWS Well-Architected Framework for building production-grade workloads.',
    type: 'Labs',
    icon: 'science',
    url: 'https://www.wellarchitectedlabs.com/',
  },
  {
    id: 'builder-center',
    title: 'AWS Builder Center',
    description:
      'Hands-on resources, technical guides, and community content for builders — sample code, tutorials, and architectural patterns from AWS experts.',
    type: 'Builder Resources',
    icon: 'handyman',
    url: 'https://builder.aws/',
  },
  {
    id: 'aws-docs',
    title: 'AWS Documentation',
    description:
      'Official service reference guides, quickstarts, tutorials, and API docs for every AWS product.',
    type: 'Documentation',
    icon: 'description',
    url: 'https://docs.aws.amazon.com/',
  },
  {
    id: 'workshops',
    title: 'AWS Workshops',
    description:
      'Self-paced technical workshops covering architecture patterns, security, machine learning, and operations on AWS.',
    type: 'Workshops',
    icon: 'build',
    url: 'https://workshops.aws/',
  },
];

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AWSEducationPage() {
  const [levelFilter, setLevelFilter] = useState('All');

  const [carouselPage, setCarouselPage] = useState(0);
  const [selectedPathId, setSelectedPathId] = useState(0);
  const today = useToday(DATA_AS_OF);

  const featuredCert = certifications.find((c) => c.featured);

  const filteredCerts = certifications.filter(
    (c) => levelFilter === 'All' || c.level === levelFilter
  );

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

  return (
    <>
      <Helmet>
        <title>AWS Education &amp; Certifications | HCW</title>
        <meta
          name="description"
          content="AWS certification prep, learning paths, and resources — from Cloud Practitioner to Professional and Specialty levels."
        />
        <meta property="og:title" content="AWS Education & Certifications" />
        <meta
          property="og:description"
          content="Structured learning paths, certification prep, and curated resources for AWS certifications."
        />
      </Helmet>

      <main className="flex-grow pt-28 pb-20 px-4 md:px-8 max-w-[1440px] mx-auto w-full">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className="mb-12 relative">
          <div className="absolute -top-10 -left-10 w-96 h-96 bg-amber-500/5 blur-3xl rounded-full pointer-events-none" />
          <h1 className="text-3xl sm:text-5xl md:text-6xl font-bold mb-4 relative z-10">
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-aws-primary via-slate-900 to-aws-primary dark:via-white">
              AWS Education &amp; Certifications
            </span>
          </h1>
          <p className="text-base sm:text-lg text-foreground max-w-3xl relative z-10">
            Master Amazon Web Services with structured learning paths and official certifications —
            from Cloud Practitioner through Professional and Specialty levels.
          </p>
          <div className="flex flex-wrap gap-2 mt-4 relative z-10">
            {['Business', 'Foundational', 'Associate', 'Professional', 'Specialty'].map((level) => (
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
              href="https://aws.amazon.com/certification/"
              target="_blank"
              rel="noopener noreferrer"
              className="group relative bg-gradient-to-br from-amber-900/40 to-card/40 backdrop-blur-md border border-amber-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(245,158,11,0.2)] hover:border-amber-400/60 transition-all duration-300 flex items-start gap-5"
            >
              <div className="w-14 h-14 shrink-0 bg-amber-500/20 rounded-xl flex items-center justify-center">
                <span
                  className="text-amber-400 text-[28px] material-symbols-outlined"
                  aria-hidden="true"
                >
                  workspace_premium
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h2 className="text-lg font-bold text-slate-950 dark:text-white group-hover:text-amber-300 transition-colors">
                    AWS Certification Portal
                  </h2>
                  <span className="px-2 py-0.5 bg-amber-500/20 border border-amber-500/30 text-amber-300 text-[10px] font-bold rounded-full uppercase tracking-wider shrink-0">
                    Official
                  </span>
                </div>
                <p className="text-sm text-foreground mb-3">
                  Browse all AWS certifications, register for exams, view your certification
                  transcript, and download digital badges from the official AWS portal.
                </p>
                <div className="flex items-center gap-1.5 text-amber-400 text-sm font-semibold">
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    open_in_new
                  </span>
                  aws.amazon.com/certification
                </div>
              </div>
            </a>

            <a
              href="https://skillbuilder.aws/"
              target="_blank"
              rel="noopener noreferrer"
              className="group relative bg-gradient-to-br from-orange-900/40 to-card/40 backdrop-blur-md border border-orange-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(249,115,22,0.2)] hover:border-orange-400/60 transition-all duration-300 flex items-start gap-5"
            >
              <div className="w-14 h-14 shrink-0 bg-orange-500/20 rounded-xl flex items-center justify-center">
                <span
                  className="text-orange-400 text-[28px] material-symbols-outlined"
                  aria-hidden="true"
                >
                  model_training
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h2 className="text-lg font-bold text-slate-950 dark:text-white group-hover:text-orange-300 transition-colors">
                    AWS Skill Builder
                  </h2>
                  <span className="px-2 py-0.5 bg-orange-500/20 border border-orange-500/30 text-orange-300 text-[10px] font-bold rounded-full uppercase tracking-wider shrink-0">
                    Free + Paid
                  </span>
                </div>
                <p className="text-sm text-foreground mb-3">
                  600+ courses, hands-on labs, practice exams, and game-based learning — the
                  official AWS digital learning platform for all skill levels.
                </p>
                <div className="flex items-center gap-1.5 text-orange-400 text-sm font-semibold">
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    open_in_new
                  </span>
                  skillbuilder.aws
                </div>
              </div>
            </a>
          </div>
        </section>

        {/* ── Featured Starting Point + Sidebar ───────────────────────── */}
        <section className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8 mb-12">
          {featuredCert && (
            <article className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl overflow-hidden hover:shadow-[0_0_25px_rgba(245,158,11,0.15)] hover:border-amber-400/50 transition-all duration-300">
              <div className="grid grid-cols-1 lg:grid-cols-2 h-full">
                <div className="p-6 flex flex-col justify-between">
                  <div>
                    <div className="mb-3 flex items-center gap-3 flex-wrap">
                      <span className="px-3 py-1 bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-bold rounded">
                        Recommended Starting Point
                      </span>
                      <span
                        className={`px-3 py-1 border text-xs font-bold rounded ${LEVEL_META[featuredCert.level].badge}`}
                      >
                        {featuredCert.level}
                      </span>
                      <CertStatusBadge cert={featuredCert} today={today} />
                    </div>
                    <h2 className="text-2xl font-bold text-slate-950 dark:text-white mb-1">
                      {featuredCert.title}
                    </h2>
                    <div className="text-sm font-mono text-foreground/50 mb-2">
                      {featuredCert.code}
                    </div>
                    <p className="text-foreground text-sm mb-4">{featuredCert.description}</p>
                  </div>
                  <div>
                    <h3 className="text-xs font-bold text-foreground uppercase tracking-wider mb-2">
                      Topics Covered
                    </h3>
                    <div className="grid grid-cols-2 gap-2 mb-5">
                      {featuredCert.topics.map((topic, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span
                            className="text-amber-400 material-symbols-outlined text-[14px]"
                            aria-hidden="true"
                          >
                            check_circle
                          </span>
                          <span className="text-foreground text-xs">{topic}</span>
                        </div>
                      ))}
                    </div>
                    <Link
                      to={`/aws/education/${featuredCert.slug}`}
                      className="block w-full h-10 px-4 bg-amber-700 hover:bg-amber-600 text-white font-bold rounded-lg transition-colors text-center leading-10 text-sm"
                    >
                      View Cert Details
                    </Link>
                  </div>
                </div>
                <div className="bg-card/60 p-6 flex flex-col justify-between">
                  <div className="space-y-4">
                    <div className="text-center">
                      <div className="text-4xl font-bold text-amber-400 mb-1">
                        {featuredCert.hours}
                      </div>
                      <div className="text-sm text-foreground">Hours of Study</div>
                    </div>
                    <div className="border-t border-slate-700 pt-4 text-center">
                      <div className="text-sm text-foreground mb-1">Estimated Preparation</div>
                      <div className="text-2xl font-bold text-slate-950 dark:text-white">
                        {featuredCert.prepTime}
                      </div>
                    </div>
                  </div>
                  <div className="pt-4 border-t border-slate-700">
                    <a
                      href="https://aws.amazon.com/certification/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block w-full h-10 px-4 bg-card/50 hover:bg-card/70 text-foreground font-semibold rounded-lg transition-colors text-sm text-center leading-10"
                    >
                      View All AWS Certs ↗
                    </a>
                  </div>
                </div>
              </div>
            </article>
          )}

          {/* Sidebar — All Certifications */}
          <aside className="flex flex-col gap-4">
            <div className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-5 flex-1">
              <h3 className="text-lg font-bold text-slate-950 dark:text-white mb-3 flex items-center gap-2">
                <span
                  className="text-amber-400 text-[20px] material-symbols-outlined"
                  aria-hidden="true"
                >
                  emoji_events
                </span>
                All Certifications
              </h3>
              <div className="space-y-1 overflow-y-auto pr-1" style={{ maxHeight: '260px' }}>
                {certifications.map((cert) => (
                  <div
                    key={cert.id}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-card/50 transition-colors"
                  >
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${LEVEL_META[cert.level].dot}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-foreground line-clamp-1">
                        {cert.code}
                      </div>
                      <div className="text-xs text-foreground/50 line-clamp-1">{cert.title}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-3 pt-3 border-t border-slate-700 grid grid-cols-2 gap-1.5">
                {Object.entries(LEVEL_META).map(([level, meta]) => (
                  <div key={level} className="flex items-center gap-1.5 text-xs text-foreground/60">
                    <span className={`w-2 h-2 rounded-full ${meta.dot}`} />
                    {level}
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </section>

        {/* ── Browse Certifications Carousel ───────────────────────────── */}
        <section className="mb-12">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <div>
              <h3 className="text-2xl font-bold text-slate-950 dark:text-white flex items-center gap-2">
                <span
                  className="text-amber-400 text-[24px] material-symbols-outlined"
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
                    className={`group bg-card/40 backdrop-blur-md border border-card/50 border-l-4 ${meta.accent} rounded-2xl p-6 hover:shadow-[0_0_20px_rgba(245,158,11,0.15)] hover:border-amber-400/40 transition-all duration-300 flex flex-col`}
                  >
                    <div className="flex items-start justify-between mb-2 gap-1 flex-wrap">
                      <span
                        className={`px-2.5 py-1 border text-[10px] font-bold rounded ${meta.badge}`}
                      >
                        {cert.level}
                      </span>
                      <span className="text-xs text-foreground/50 font-mono">{cert.hours}h</span>
                    </div>
                    <CertStatusBadge cert={cert} today={today} className="self-start mb-2" />
                    <div className="text-xs font-mono text-foreground/40 mb-1">{cert.code}</div>
                    <h3 className="text-sm font-bold text-slate-950 dark:text-white mb-2 line-clamp-3 group-hover:text-amber-300 transition-colors flex-1">
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
                        to={`/aws/education/${cert.slug}`}
                        className="flex-1 h-9 bg-card/50 hover:bg-amber-500/20 hover:text-amber-300 text-foreground rounded text-xs font-semibold transition-colors flex items-center justify-center gap-1"
                      >
                        View Details
                        <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
                          arrow_forward
                        </span>
                      </Link>
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
                    className={`block h-2.5 rounded-full transition-all ${i === carouselPage ? 'bg-amber-400 w-5' : 'w-2.5 bg-card/60 group-hover:bg-card/80'}`}
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

        {/* ── AWS Microcredentials ─────────────────────────────────────── */}
        <section className="mb-12">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
            <div>
              <h3 className="text-2xl font-bold text-slate-950 dark:text-white flex items-center gap-2">
                <span
                  className="text-amber-400 text-[24px] material-symbols-outlined"
                  aria-hidden="true"
                >
                  verified
                </span>
                AWS Microcredentials
              </h3>
              <p className="text-sm text-foreground/60 mt-1">
                Proctored, hands-on assessments in live AWS environments — proof of real-world skill
                beyond multiple-choice exams.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {[
              {
                slug: 'aws-serverless-demonstrated',
                title: 'AWS Serverless Demonstrated',
                description:
                  'Validates hands-on ability to build serverless applications using Lambda, API Gateway, and Step Functions.',
                icon: 'bolt',
                color: 'text-amber-400',
                border: 'hover:border-amber-400/40',
                badge: 'bg-amber-500/20 border-amber-500/40 text-amber-300',
                tag: 'Serverless',
              },
              {
                slug: 'aws-agentic-ai-demonstrated',
                title: 'AWS Agentic AI Demonstrated',
                description:
                  'Validates hands-on ability to build and troubleshoot agentic AI solutions using Amazon Bedrock Agents.',
                icon: 'smart_toy',
                color: 'text-violet-400',
                border: 'hover:border-violet-400/40',
                badge: 'bg-violet-500/20 border-violet-500/40 text-violet-300',
                tag: 'Generative AI',
              },
              {
                slug: 'aws-incident-response-demonstrated',
                title: 'AWS Incident Response Demonstrated',
                description:
                  'Validates hands-on ability to identify, contain, and remediate common AWS security incidents.',
                icon: 'security',
                color: 'text-red-400',
                border: 'hover:border-red-400/40',
                badge: 'bg-red-500/20 border-red-500/40 text-red-300',
                tag: 'Security',
              },
              {
                slug: 'aws-application-networking-demonstrated',
                title: 'AWS Application Networking Demonstrated',
                description:
                  'Validates hands-on ability to configure application delivery and optimize performance on AWS.',
                icon: 'network_node',
                color: 'text-sky-400',
                border: 'hover:border-sky-400/40',
                badge: 'bg-sky-500/20 border-sky-500/40 text-sky-300',
                tag: 'Networking',
              },
            ].map((mc) => (
              <Link
                key={mc.slug}
                to={`/aws/education/microcredentials/${mc.slug}`}
                className={`group bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6 flex flex-col gap-4 hover:shadow-[0_0_20px_rgba(245,158,11,0.12)] ${mc.border} transition-all duration-300`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-card/60 flex items-center justify-center shrink-0">
                      <span
                        className={`material-symbols-outlined text-[22px] ${mc.color}`}
                        aria-hidden="true"
                      >
                        {mc.icon}
                      </span>
                    </div>
                    <div>
                      <div className="text-[10px] font-black text-foreground/40 tracking-widest uppercase mb-0.5">
                        AWS Microcredential
                      </div>
                      <h4 className="text-sm font-bold text-slate-950 dark:text-white leading-snug group-hover:text-amber-300 transition-colors">
                        {mc.title}
                      </h4>
                    </div>
                  </div>
                  <span
                    className={`px-2 py-0.5 border text-[10px] font-bold rounded shrink-0 ${mc.badge}`}
                  >
                    {mc.tag}
                  </span>
                </div>
                <p className="text-xs text-foreground/70 leading-relaxed">{mc.description}</p>
                <div className="pt-3 border-t border-card/40 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs text-foreground/50">
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                      timer
                    </span>
                    90 min · Proctored hands-on lab
                  </div>
                  <span
                    className="material-symbols-outlined text-foreground/40 group-hover:text-amber-400 transition-colors text-[16px]"
                    aria-hidden="true"
                  >
                    arrow_forward
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </section>

        {/* ── Learning Paths — compact ──────────────────────────────────── */}
        <section className="mb-12">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <h3 className="text-2xl font-bold text-slate-950 dark:text-white flex items-center gap-2">
              <span
                className="text-amber-400 text-[24px] material-symbols-outlined"
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
                className="appearance-none bg-card/40 backdrop-blur-md border border-card/50 text-foreground text-sm rounded-xl px-4 pr-10 h-10 hover:border-amber-400/50 focus:outline-none focus:border-amber-400 transition-colors cursor-pointer"
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
            <article className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6 hover:shadow-[0_0_25px_rgba(245,158,11,0.15)] hover:border-amber-400/50 transition-all duration-300">
              <div className="flex flex-wrap items-center gap-3 mb-3">
                <span className="px-3 py-1 bg-amber-500/20 border border-amber-500/30 text-amber-300 text-xs font-bold rounded font-mono">
                  {selectedPath.certCode}
                </span>
                <span className="px-3 py-1 bg-card/50 text-foreground text-xs font-bold rounded">
                  {selectedPath.level}
                </span>
                <span className="text-sm text-foreground/60">{selectedPath.hours} hours</span>
                <span className="text-sm text-foreground/60">·</span>
                <span className="text-sm text-foreground/60">
                  {selectedPath.modules.length} modules
                </span>
              </div>
              <h2 className="text-xl font-bold text-slate-950 dark:text-white mb-2">
                {selectedPath.title}
              </h2>
              <p className="text-foreground mb-5 text-sm">{selectedPath.description}</p>
              <div className="flex flex-wrap gap-2 mb-5">
                {selectedPath.modules.map((mod, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-card/30 rounded-lg border border-card/40"
                  >
                    <span className="w-5 h-5 rounded-full bg-amber-500/20 text-amber-300 text-[10px] font-bold flex items-center justify-center shrink-0">
                      {i + 1}
                    </span>
                    <span className="text-xs text-foreground">{mod.title}</span>
                  </div>
                ))}
              </div>
              <a
                href={selectedPath.certUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 h-10 px-5 bg-amber-700 hover:bg-amber-600 text-white font-bold rounded-lg transition-colors text-sm"
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  open_in_new
                </span>
                View {selectedPath.certCode} on AWS
              </a>
            </article>
          )}
        </section>

        {/* ── Learning Resources ───────────────────────────────────────── */}
        <section className="mb-16">
          <h3 className="text-2xl font-bold text-slate-950 dark:text-white mb-6 flex items-center gap-2">
            <span
              className="text-amber-400 text-[24px] material-symbols-outlined"
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
                className="group bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6 flex flex-col hover:shadow-[0_0_25px_rgba(245,158,11,0.15)] hover:border-amber-400/50 transition-all duration-300"
              >
                <div className="w-12 h-12 rounded-xl bg-amber-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                  <span
                    className="material-symbols-outlined text-amber-400 text-[24px]"
                    aria-hidden="true"
                  >
                    {resource.icon}
                  </span>
                </div>
                <div className="text-xs font-bold text-amber-400/70 uppercase tracking-wider mb-1">
                  {resource.type}
                </div>
                <h4 className="font-bold text-slate-950 dark:text-white mb-2 group-hover:text-amber-300 transition-colors">
                  {resource.title}
                </h4>
                <p className="text-xs text-foreground flex-1">{resource.description}</p>
                <div className="mt-4 flex items-center gap-1 text-amber-400 text-xs font-semibold">
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

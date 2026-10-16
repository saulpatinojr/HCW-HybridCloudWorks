import React from 'react';
import { useParams, Link } from 'react-router';
import { Helmet } from 'react-helmet-async';
import { getProviderPath, routes } from '@/lib/routeFactory';
import CertStatusBadge from '@/components/education/CertStatusBadge';
import ListenAndLearn from '@/components/education/ListenAndLearn';
import {
  DATA_AS_OF,
  certifications as ALL_CERTS,
  findCertificationBySlug,
} from '@/data/aws/certifications';
import { useToday } from '@/lib/certStatus';

// ── Shared data ──────────────────────────────────────────────────────────────

const LEVEL_META = {
  Business: {
    badge: 'bg-rose-500/20 border-rose-500/40 text-rose-300',
    accent: 'from-rose-900/30',
    glow: 'rgba(244,63,94,0.15)',
    dot: 'bg-rose-500',
  },
  Foundational: {
    badge: 'bg-sky-500/20 border-sky-500/40 text-sky-300',
    accent: 'from-sky-900/30',
    glow: 'rgba(14,165,233,0.15)',
    dot: 'bg-sky-500',
  },
  Associate: {
    badge: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300',
    accent: 'from-emerald-900/30',
    glow: 'rgba(16,185,129,0.15)',
    dot: 'bg-emerald-500',
  },
  Professional: {
    badge: 'bg-violet-500/20 border-violet-500/40 text-violet-300',
    accent: 'from-violet-900/30',
    glow: 'rgba(139,92,246,0.15)',
    dot: 'bg-violet-500',
  },
  Specialty: {
    badge: 'bg-amber-500/20 border-amber-500/40 text-amber-300',
    accent: 'from-amber-900/30',
    glow: 'rgba(245,158,11,0.15)',
    dot: 'bg-amber-500',
  },
};

// ── Component ────────────────────────────────────────────────────────────────

export default function AWSCertDetailPage() {
  const { certSlug } = useParams();
  const today = useToday(DATA_AS_OF);
  const cert = findCertificationBySlug(certSlug);

  if (!cert) {
    return (
      <main className="flex-grow pt-28 pb-20 px-4 md:px-8 max-w-[1440px] mx-auto w-full">
        <div className="text-center py-20">
          <span
            className="text-amber-400 text-[64px] material-symbols-outlined mb-4 block"
            aria-hidden="true"
          >
            search_off
          </span>
          <h1 className="text-3xl font-bold text-slate-950 dark:text-white mb-4">
            Certification Not Found
          </h1>
          <p className="text-foreground mb-8">
            The certification <code className="font-mono text-amber-400">{certSlug}</code> was not
            found.
          </p>
          <Link
            to={routes.education('aws')}
            className="px-6 h-11 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg transition-colors inline-flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              arrow_back
            </span>
            Back to AWS Education
          </Link>
        </div>
      </main>
    );
  }

  const meta = LEVEL_META[cert.level];
  const nextCerts = ALL_CERTS.filter((c) => cert.nextCerts?.includes(c.slug));

  return (
    <>
      <Helmet>
        <title>{`${cert.code}: ${cert.title} | AWS Education | HCW`}</title>
        <meta name="description" content={cert.description} />
        <meta property="og:title" content={`${cert.code}: ${cert.title}`} />
        <meta property="og:description" content={cert.longDescription} />
      </Helmet>

      <main className="flex-grow pt-28 pb-20 px-4 md:px-8 max-w-[1440px] mx-auto w-full">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-sm text-foreground/60 mb-8">
          <Link to={routes.education('aws')} className="hover:text-amber-400 transition-colors">
            AWS Education
          </Link>
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
            chevron_right
          </span>
          <span className="text-foreground">{cert.code}</span>
        </nav>

        {/* Hero */}
        <section
          className={`mb-10 bg-gradient-to-br ${meta.accent} to-card/20 backdrop-blur-md border border-card/40 rounded-2xl p-8 relative overflow-hidden`}
        >
          <div
            className="absolute -top-10 -right-10 w-64 h-64 rounded-full blur-3xl pointer-events-none"
            style={{ background: `radial-gradient(circle, ${meta.glow} 0%, transparent 70%)` }}
          />
          <div className="relative z-10">
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <span className={`px-3 py-1 border text-xs font-bold rounded ${meta.badge}`}>
                {cert.level}
              </span>
              <span className="text-sm font-mono text-foreground/60">{cert.code}</span>
              <CertStatusBadge cert={cert} today={today} />
            </div>
            <h1 className="text-3xl sm:text-4xl font-bold text-slate-950 dark:text-white mb-3">
              {cert.title}
            </h1>
            <p className="text-foreground text-lg max-w-3xl mb-6">{cert.longDescription}</p>
            <div className="flex flex-wrap gap-6 text-sm">
              <div>
                <div className="text-foreground/60 mb-0.5">Study Hours</div>
                <div className="text-2xl font-bold text-amber-400">{cert.hours}h</div>
              </div>
              <div>
                <div className="text-foreground/60 mb-0.5">Prep Time</div>
                <div className="text-2xl font-bold text-slate-950 dark:text-white">
                  {cert.prepTime}
                </div>
              </div>
              {cert.successRate && (
                <div>
                  <div className="text-foreground/60 mb-0.5">Avg. Pass Rate</div>
                  <div className="text-2xl font-bold text-amber-300">{cert.successRate}</div>
                </div>
              )}
            </div>
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-8">
          <div className="space-y-8">
            {/* Listen & Learn — renders nothing until an episode is approved,
                the same gate the Azure detail page uses (#461 item 10). */}
            <ListenAndLearn
              platform="aws"
              examCode={cert.code}
              studyGuideUrl={cert.studyGuideUrl}
            />

            {/* Topics */}
            <section className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6">
              <h2 className="text-xl font-bold text-slate-950 dark:text-white mb-4 flex items-center gap-2">
                <span
                  className="text-amber-400 material-symbols-outlined text-[20px]"
                  aria-hidden="true"
                >
                  category
                </span>
                Topics Covered
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {cert.topics.map((topic, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 bg-card/50 rounded-xl px-3 py-2.5"
                  >
                    <span
                      className="text-amber-400 material-symbols-outlined text-[16px]"
                      aria-hidden="true"
                    >
                      check_circle
                    </span>
                    <span className="text-foreground text-sm">{topic}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Skill Builder Modules — a newly announced exam version has none yet */}
            {cert.modules.length > 0 && (
              <section className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6">
                <h2 className="text-xl font-bold text-slate-950 dark:text-white mb-4 flex items-center gap-2">
                  <span
                    className="text-amber-400 material-symbols-outlined text-[20px]"
                    aria-hidden="true"
                  >
                    menu_book
                  </span>
                  AWS Skill Builder Modules
                </h2>
                <div className="space-y-3">
                  {cert.modules.map((mod, i) => (
                    <a
                      key={i}
                      href={mod.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-3 group bg-card/40 hover:bg-card/60 border border-card/30 hover:border-amber-400/30 rounded-xl px-4 py-3 transition-all"
                    >
                      <span className="flex-shrink-0 w-6 h-6 bg-amber-500/20 rounded-full flex items-center justify-center text-xs font-bold text-amber-400">
                        {i + 1}
                      </span>
                      <span className="text-sm text-foreground group-hover:text-amber-300 transition-colors flex-1">
                        {mod.title}
                      </span>
                      <span
                        className="material-symbols-outlined text-[14px] text-foreground/40 group-hover:text-amber-400 transition-colors shrink-0"
                        aria-hidden="true"
                      >
                        open_in_new
                      </span>
                    </a>
                  ))}
                </div>
              </section>
            )}

            {/* Microcredentials */}
            {cert.microcredentialUrl && (
              <section className="bg-card/40 backdrop-blur-md border border-amber-500/20 rounded-2xl p-6">
                <h2 className="text-xl font-bold text-slate-950 dark:text-white mb-2 flex items-center gap-2">
                  <span
                    className="text-amber-400 material-symbols-outlined text-[20px]"
                    aria-hidden="true"
                  >
                    verified
                  </span>
                  AWS Microcredentials
                </h2>
                <p className="text-sm text-foreground/70 mb-4">
                  Focused, skill-specific credentials on Skill Builder that complement this
                  certification with hands-on proof of competency.
                </p>
                <a
                  href={cert.microcredentialUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 h-10 px-5 bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/30 text-amber-300 font-semibold rounded-lg transition-colors text-sm"
                >
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    open_in_new
                  </span>
                  Browse Related Microcredentials
                </a>
              </section>
            )}

            {/* What's Next */}
            {nextCerts.length > 0 && (
              <section className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6">
                <h2 className="text-xl font-bold text-slate-950 dark:text-white mb-4 flex items-center gap-2">
                  <span
                    className="text-amber-400 material-symbols-outlined text-[20px]"
                    aria-hidden="true"
                  >
                    trending_up
                  </span>
                  What to Study Next
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {nextCerts.map((next) => (
                    <Link
                      key={next.slug}
                      to={getProviderPath('aws', `education/${next.slug}`)}
                      className="group flex items-center gap-3 bg-card/40 hover:bg-card/60 border border-card/30 hover:border-amber-400/30 rounded-xl px-4 py-3 transition-all"
                    >
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${LEVEL_META[next.level]?.dot}`}
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-mono text-foreground/50">{next.code}</div>
                        <div className="text-sm font-semibold text-foreground group-hover:text-amber-300 transition-colors line-clamp-1">
                          {next.title.replace(/AWS Certified\s+/i, '')}
                        </div>
                      </div>
                      <span
                        className="material-symbols-outlined text-[16px] text-foreground/40 group-hover:text-amber-400 transition-colors ml-auto shrink-0"
                        aria-hidden="true"
                      >
                        arrow_forward
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* Sidebar */}
          <aside className="space-y-6 h-fit sticky top-28">
            {/* CTA */}
            <div className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6 space-y-3">
              <a
                href={cert.learnUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full h-11 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg transition-colors"
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  open_in_new
                </span>
                View on AWS Certification
              </a>
              {cert.studyGuideUrl && (
                <a
                  href={cert.studyGuideUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full h-11 bg-card/50 hover:bg-card/70 text-foreground font-semibold rounded-lg transition-colors text-sm"
                >
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    description
                  </span>
                  Official Exam Guide
                </a>
              )}
              {cert.practiceUrl && (
                <a
                  href={cert.practiceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-2 w-full h-11 bg-card/50 hover:bg-card/70 text-foreground font-semibold rounded-lg transition-colors text-sm"
                >
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    quiz
                  </span>
                  Practice Questions
                </a>
              )}
            </div>

            {/* Prerequisites */}
            <div className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6">
              <h3 className="text-base font-bold text-slate-950 dark:text-white mb-3 flex items-center gap-2">
                <span
                  className="text-amber-400 material-symbols-outlined text-[18px]"
                  aria-hidden="true"
                >
                  info
                </span>
                Prerequisites
              </h3>
              <p className="text-sm text-foreground">{cert.prerequisites}</p>
            </div>

            {/* Quick Stats */}
            <div className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6 space-y-4">
              <h3 className="text-base font-bold text-slate-950 dark:text-white">Quick Stats</h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-foreground/60">Exam Code</span>
                  <span className="font-mono font-bold text-amber-400">{cert.code}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-foreground/60">Level</span>
                  <span
                    className={`px-2 py-0.5 border text-[10px] font-bold rounded ${meta.badge}`}
                  >
                    {cert.level}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-foreground/60">Study Hours</span>
                  <span className="font-bold text-slate-950 dark:text-white">{cert.hours}h</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-foreground/60">Prep Time</span>
                  <span className="font-bold text-slate-950 dark:text-white">{cert.prepTime}</span>
                </div>
                {cert.successRate && (
                  <div className="flex justify-between">
                    <span className="text-foreground/60">Avg. Pass Rate</span>
                    <span className="font-bold text-amber-300">{cert.successRate}</span>
                  </div>
                )}
                {cert.modules.length > 0 && (
                  <div className="flex justify-between">
                    <span className="text-foreground/60">Skill Builder Modules</span>
                    <span className="font-bold text-slate-950 dark:text-white">
                      {cert.modules.length}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <Link
              to={routes.education('aws')}
              className="flex items-center gap-2 text-sm text-foreground/60 hover:text-amber-400 transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                arrow_back
              </span>
              Back to AWS Education
            </Link>
          </aside>
        </div>
      </main>
    </>
  );
}

import React from 'react';
import { useParams, Link } from 'react-router';
import { Helmet } from 'react-helmet-async';
import { getProviderPath, routes } from '@/lib/routeFactory';
import CertStatusBadge from '@/components/education/CertStatusBadge';
import {
  BackLink,
  CertSidebarLinks,
  DetailNotFound,
  DetailSection,
  HeroStats,
  NextCertLinks,
  NumberedModuleLinks,
  PrerequisitesCard,
  StatRow,
  TopicGrid,
} from '@/components/education/CertDetailParts';
import ListenAndLearn from '@/components/education/ListenAndLearn';
import {
  DATA_AS_OF,
  certifications as ALL_CERTS,
  findCertificationBySlug,
} from '@/data/aws/certifications';
import { useToday } from '@/lib/certStatus';
import { AWS_DETAIL_TONE as TONE } from './awsDetailTone';

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

/** The words on the sidebar's three buttons. */
const SIDEBAR_LABELS = {
  learn: 'View on AWS Certification',
  guide: 'Official Exam Guide',
  practice: 'Practice Questions',
};

// ── Component ────────────────────────────────────────────────────────────────

export default function AWSCertDetailPage() {
  const { certSlug } = useParams();
  const today = useToday(DATA_AS_OF);
  const cert = findCertificationBySlug(certSlug);

  if (!cert) {
    return (
      <DetailNotFound
        tone={TONE}
        heading="Certification Not Found"
        noun="certification"
        slug={certSlug}
        backTo={routes.education('aws')}
        backLabel="Back to AWS Education"
      />
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

      <main className={TONE.main}>
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
            <HeroStats cert={cert} hoursClass="text-amber-400" passRateClass="text-amber-300" />
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
            <DetailSection icon="category" iconColor={TONE.accentText} title="Topics Covered">
              <TopicGrid
                topics={cert.topics}
                iconColor={TONE.accentText}
                icon="check_circle"
                columns="grid-cols-2 sm:grid-cols-3"
              />
            </DetailSection>

            {/* Skill Builder Modules — a newly announced exam version has none yet */}
            {cert.modules.length > 0 && (
              <DetailSection
                icon="menu_book"
                iconColor={TONE.accentText}
                title="AWS Skill Builder Modules"
              >
                <NumberedModuleLinks modules={cert.modules} tone={TONE} />
              </DetailSection>
            )}

            {/* Microcredentials */}
            {cert.microcredentialUrl && (
              <DetailSection
                icon="verified"
                iconColor={TONE.accentText}
                title="AWS Microcredentials"
                className="bg-card/40 backdrop-blur-md border border-amber-500/20 rounded-2xl p-6"
                headingGap="mb-2"
              >
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
              </DetailSection>
            )}

            {/* What's Next */}
            {nextCerts.length > 0 && (
              <DetailSection
                icon="trending_up"
                iconColor={TONE.accentText}
                title="What to Study Next"
              >
                <NextCertLinks
                  certs={nextCerts}
                  tone={TONE}
                  hrefFor={(next) => getProviderPath('aws', `education/${next.slug}`)}
                  dotClassFor={(next) => LEVEL_META[next.level]?.dot}
                  stripTitle={/AWS Certified\s+/i}
                />
              </DetailSection>
            )}
          </div>

          {/* Sidebar */}
          <aside className="space-y-6 h-fit sticky top-28">
            {/* CTA */}
            <CertSidebarLinks cert={cert} tone={TONE} labels={SIDEBAR_LABELS} />

            {/* Prerequisites */}
            <PrerequisitesCard text={cert.prerequisites} iconColor={TONE.accentText} />

            {/* Quick Stats */}
            <div className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6 space-y-4">
              <h3 className="text-base font-bold text-slate-950 dark:text-white">Quick Stats</h3>
              <div className="space-y-3 text-sm">
                <StatRow label="Exam Code" valueClass="font-mono font-bold text-amber-400">
                  {cert.code}
                </StatRow>
                <StatRow
                  label="Level"
                  valueClass={`px-2 py-0.5 border text-[10px] font-bold rounded ${meta.badge}`}
                >
                  {cert.level}
                </StatRow>
                <StatRow label="Study Hours">{cert.hours}h</StatRow>
                <StatRow label="Prep Time">{cert.prepTime}</StatRow>
                {cert.successRate && (
                  <StatRow label="Avg. Pass Rate" valueClass="font-bold text-amber-300">
                    {cert.successRate}
                  </StatRow>
                )}
                {cert.modules.length > 0 && (
                  <StatRow label="Skill Builder Modules">{cert.modules.length}</StatRow>
                )}
              </div>
            </div>

            <BackLink
              to={routes.education('aws')}
              hoverText={TONE.hoverText}
              label="Back to AWS Education"
            />
          </aside>
        </div>
      </main>
    </>
  );
}

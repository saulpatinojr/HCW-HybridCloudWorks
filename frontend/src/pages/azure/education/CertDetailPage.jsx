import React, { Suspense, memo } from 'react';
import { useParams, Link } from 'react-router';
import { Helmet } from 'react-helmet-async';
import { getProviderPath, routes } from '@/lib/routeFactory';
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
import EpisodePlaylist from '@/components/education/EpisodePlaylist';
import { outlineKeyFor, DATA_AS_OF as GUIDES_AS_OF } from '@/data/azure/study-guides/index.js';
import { useStudyGuideOutline } from '@/lib/studyGuideOutline';
import { DATA_AS_OF, certifications } from '@/data/azure/certifications';
import { deriveStatus, formatIsoDate, useToday } from '@/lib/certStatus';

// ── Presentation ────────────────────────────────────────────────────────────
//
// The certification data itself is the shared catalogue in
// data/azure/certifications.js — the same array the landing page links from.
// Until 2026-09-09 this file carried its own 15-entry copy, so 86 of the
// landing page's links opened "Certification Not Found" (#461 item 2).

const LEVEL_META = {
  Fundamentals: {
    badge: 'bg-sky-500/20 border-sky-500/40 text-sky-300',
    accent: 'from-sky-900/30',
    glow: 'rgba(14,165,233,0.15)',
    label: 'Fundamentals',
  },
  Associate: {
    badge: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300',
    accent: 'from-emerald-900/30',
    glow: 'rgba(16,185,129,0.15)',
    label: 'Associate',
  },
  Expert: {
    badge: 'bg-violet-500/20 border-violet-500/40 text-violet-300',
    accent: 'from-violet-900/30',
    glow: 'rgba(139,92,246,0.15)',
    label: 'Expert',
  },
  Specialty: {
    badge: 'bg-amber-500/20 border-amber-500/40 text-amber-300',
    accent: 'from-amber-900/30',
    glow: 'rgba(245,158,11,0.15)',
    label: 'Specialty',
  },
};

function getNextCertDotClass(level) {
  switch (level) {
    case 'Fundamentals':
      return 'bg-sky-500';
    case 'Associate':
      return 'bg-emerald-500';
    case 'Expert':
      return 'bg-violet-500';
    default:
      return 'bg-amber-500';
  }
}

/**
 * The accent for the shared parts in components/education/CertDetailParts.jsx;
 * the keys are explained at the top of that file.
 */
const TONE = Object.freeze({
  main: 'grow pt-28 pb-20 px-4 md:px-8 max-w-360 mx-auto w-full',
  accentText: 'text-primary',
  hoverText: 'hover:text-primary',
  primaryButton: 'bg-primary hover:bg-blue-800 text-primary-foreground',
  cardHoverBorder: 'hover:border-primary/30',
  groupHoverTitle: 'group-hover:text-primary',
  groupHoverIcon: 'group-hover:text-primary',
  numberBadge:
    'shrink-0 w-6 h-6 bg-primary/20 rounded-full flex items-center justify-center text-xs font-bold text-primary',
  sideButton: 'flex items-center justify-start px-4 gap-2',
});

/** The words on the sidebar's three buttons. */
const SIDEBAR_LABELS = {
  learn: 'View on Microsoft Learn',
  guide: 'Official Study Guide',
  practice: 'Free Practice Assessment',
};

const formatDate = formatIsoDate;

/**
 * The one line a reader must not miss: retired, retiring, or beta — derived
 * from the dates so it cannot outlive them. Nothing for an active exam.
 */
function StatusNotice({ status, cert, replacement }) {
  if (status === 'active') return null;
  const styles = {
    retired: 'bg-slate-500/15 border-slate-500/40 text-slate-800 dark:text-slate-200',
    expiring: 'bg-rose-500/15 border-rose-500/40 text-rose-900 dark:text-rose-200',
    beta: 'bg-amber-500/15 border-amber-500/40 text-amber-900 dark:text-amber-200',
  };
  const icons = { retired: 'block', expiring: 'schedule', beta: 'science' };
  let text;
  if (status === 'retired') {
    text = cert.expiryDate
      ? `Retired by Microsoft on ${formatDate(cert.expiryDate)}. It can no longer be scheduled.`
      : 'Withdrawn by Microsoft. It can no longer be scheduled.';
  } else if (status === 'expiring') {
    text = `Retires on ${formatDate(cert.expiryDate)}. Schedule it before then or plan for the replacement.`;
  } else {
    text = cert.betaEndDate
      ? `Beta exam — the beta period ends ${formatDate(cert.betaEndDate)}.`
      : 'Beta exam — scores are released after the beta period closes.';
  }
  return (
    <div
      role="status"
      data-testid="cert-status-notice"
      data-status={status}
      className={`mb-6 flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3 text-sm ${styles[status]}`}
    >
      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
        {icons[status]}
      </span>
      <span className="font-semibold capitalize">{status}.</span>
      <span>{text}</span>
      {replacement && (
        <Link
          to={getProviderPath('azure', `education/${replacement.slug}`)}
          className="font-semibold underline underline-offset-2 hover:text-slate-950 dark:hover:text-white"
        >
          Replaced by {replacement.code}: {replacement.title.replace(/Microsoft\s+/i, '')}
        </Link>
      )}
    </div>
  );
}

/**
 * The official study guide's "Skills measured" outline, area by area, each
 * deep-linked to its heading on Microsoft Learn (#498).
 *
 * LOADED PER EXAM, AND HYDRATION MUST NOT NOTICE (#500). The outline is in the
 * prerendered HTML, but its module is fetched on demand
 * (src/lib/studyGuideOutline.js), so on the hydrating render it is not there
 * yet. Rendering "no outline" then would be a hydration mismatch: React throws
 * the server markup away and client-renders — the class of bug certStatus.js's
 * `useToday` exists to prevent. So:
 *
 *   1. SkillsMeasuredOutline SUSPENDS instead of rendering nothing. Inside a
 *      <Suspense> boundary, a component that suspends during hydration leaves
 *      the boundary dehydrated: React keeps the server HTML on screen, as-is,
 *      and hydrates that boundary when the module lands. No mismatch and no
 *      flash — the outline is visible from first paint.
 *   2. The boundary lives in a memo component whose only prop is a string.
 *      A dehydrated boundary that receives NEW PROPS before it has hydrated
 *      cannot be hydrated any more; React falls back to client-rendering it,
 *      which deletes the server HTML and shows the fallback. The page does
 *      re-render straight after hydration — `useToday` moves to the real date
 *      — and without memo that re-render would hand the boundary fresh
 *      element props and blank the outline until the chunk arrived. memo
 *      bails out on an unchanged key, so the boundary is never touched.
 *   3. The fallback is null, and only matters on a client-side navigation to
 *      an exam whose chunk has not loaded: the section appears when it does.
 *      The page renders this at all only for a key the index lists, so an
 *      exam without a guide renders nothing on the server and the client alike.
 *
 * Keyed by exam at the call site, so navigating between exams mounts a fresh
 * boundary rather than showing the previous exam's outline while the next loads.
 */
function SkillsMeasuredBoundary({ guideKey }) {
  return (
    <Suspense fallback={null}>
      <SkillsMeasuredOutline guideKey={guideKey} />
    </Suspense>
  );
}

const SkillsMeasured = memo(SkillsMeasuredBoundary);

function SkillsMeasuredOutline({ guideKey }) {
  const outline = useStudyGuideOutline(guideKey);
  if (!outline) return null;
  return (
    <section
      className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6"
      aria-labelledby="skills-measured-heading"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <h2
          id="skills-measured-heading"
          className="text-xl font-bold text-slate-950 dark:text-white flex items-center gap-2"
        >
          <span className="text-primary material-symbols-outlined text-[20px]" aria-hidden="true">
            format_list_numbered
          </span>
          Skills measured
        </h2>
        <a
          href={outline.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-foreground/60 hover:text-primary underline underline-offset-2"
        >
          Official study guide
        </a>
      </div>
      <p className="text-sm text-foreground/70 mb-4">
        Microsoft&apos;s own objectives, in the order the exam presents them. Each area links to its
        section on Microsoft Learn. Checked {GUIDES_AS_OF}.
      </p>

      <ol className="space-y-3">
        {outline.areas.map((area, i) => {
          const href = area.anchor ? `${outline.sourceUrl}#${area.anchor}` : outline.sourceUrl;
          const sections = area.sections.length
            ? area.sections
            : [{ title: null, objectives: area.objectives }];
          return (
            <li key={area.slug}>
              <details open={i === 0} className="group bg-card/40 border border-card/30 rounded-xl">
                <summary className="flex items-center gap-3 px-4 py-3 cursor-pointer list-none select-none">
                  <span
                    className="shrink-0 w-6 h-6 bg-primary/20 rounded-full flex items-center justify-center text-xs font-bold text-primary"
                    aria-hidden="true"
                  >
                    {i + 1}
                  </span>
                  <span className="flex-1 min-w-0 text-sm font-semibold text-slate-950 dark:text-white">
                    {area.name}
                  </span>
                  {area.weightLabel ? (
                    <span
                      className="shrink-0 px-2 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-[11px] font-semibold text-primary"
                      title="Share of the exam this area is worth"
                    >
                      {area.weightLabel}
                    </span>
                  ) : null}
                  <span
                    className="material-symbols-outlined text-[18px] text-foreground/50 transition-transform group-open:rotate-180"
                    aria-hidden="true"
                  >
                    expand_more
                  </span>
                </summary>

                <div className="px-4 pb-4 pt-1 space-y-3">
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline underline-offset-2"
                  >
                    <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                      open_in_new
                    </span>
                    {area.anchor ? 'This area on Microsoft Learn' : 'On Microsoft Learn'}
                  </a>

                  {sections.map((section, s) => (
                    <div key={section.title || `flat-${s}`}>
                      {section.title ? (
                        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 mb-1.5">
                          {section.title}
                        </h3>
                      ) : null}
                      <ul className="space-y-1 pl-4 list-disc marker:text-primary/60">
                        {section.objectives.map((objective) => (
                          <li key={objective} className="text-sm text-foreground/80 leading-snug">
                            {objective}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CertDetailPage() {
  const { certSlug } = useParams();
  const cert = certifications.find((c) => c.slug === certSlug);
  // DATA_AS_OF on the pre-rendered and hydrating render, the real date after
  // mount — before the early return, since hooks must run in the same order.
  const today = useToday(DATA_AS_OF);

  if (!cert) {
    return (
      <DetailNotFound
        tone={TONE}
        heading="Certification Not Found"
        noun="certification"
        slug={certSlug}
        backTo={routes.education('azure')}
        backLabel="Back to Azure Education"
      />
    );
  }

  const meta = LEVEL_META[cert.level];
  const status = deriveStatus(cert, today);
  const replacement = cert.replacedBy
    ? certifications.find((c) => c.slug === cert.replacedBy) || null
    : null;
  const nextCerts = certifications.filter((c) => cert.nextCerts?.includes(c.slug));
  // The official study guide's "Skills measured" outline, joined by the
  // guide URL rather than the exam code — applied-skills entries share
  // site-assigned codes, and a URL tail can only name one guide (#498).
  // Known synchronously from the index; the outline itself loads per exam.
  const outlineKey = outlineKeyFor(cert.studyGuideUrl);

  return (
    <>
      <Helmet>
        {/* One string child: react-helmet-async drops a title made of several
            JSX children, which is why every pre-rendered detail page had an
            empty <title> the first time these routes were built. */}
        <title>{`${cert.code}: ${cert.title} | Azure Education | HCW`}</title>
        <meta name="description" content={cert.description} />
        <meta property="og:title" content={`${cert.code}: ${cert.title}`} />
        <meta property="og:description" content={cert.longDescription} />
      </Helmet>

      <main className={TONE.main}>
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-sm text-foreground/60 mb-8">
          <Link to={routes.education('azure')} className="hover:text-primary transition-colors">
            Azure Education
          </Link>
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
            chevron_right
          </span>
          <span className="text-foreground">{cert.code}</span>
        </nav>

        {/* Hero */}
        <section
          className={`mb-10 bg-linear-to-br ${meta.accent} to-card/20 backdrop-blur-md border border-card/40 rounded-2xl p-8 relative overflow-hidden`}
        >
          <div
            className="absolute -top-10 -right-10 w-64 h-64 rounded-full blur-3xl pointer-events-none"
            style={{ background: `radial-gradient(circle, ${meta.glow} 0%, transparent 70%)` }}
          />
          {/* Two columns on wide screens: the title block, and the study
              podcast as a single player with its chapters (#498). The
              playlist renders nothing when no episode has approved audio,
              and then the title block simply takes the full width. */}
          <div className="relative z-10 lg:flex lg:gap-8 lg:items-start">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <span className={`px-3 py-1 border text-xs font-bold rounded ${meta.badge}`}>
                  {cert.level}
                </span>
                <span className="text-sm font-mono text-foreground/60">{cert.code}</span>
              </div>
              <h1 className="text-3xl sm:text-4xl font-bold text-slate-950 dark:text-white mb-3">
                {cert.title}
              </h1>
              <StatusNotice status={status} cert={cert} replacement={replacement} />
              <p className="text-foreground text-lg max-w-3xl mb-6">{cert.longDescription}</p>
              <HeroStats cert={cert} hoursClass="text-primary" passRateClass="text-cyan-400" />
            </div>

            <EpisodePlaylist
              // Keyed by exam so a route change REMOUNTS it. React Router
              // reuses this page's instance when only the slug changes, and a
              // playlist that survived that would carry the previous exam's
              // selected chapter — or an index past the new exam's last one —
              // into a page it was never on (Copilot review of 05b35783).
              key={`azure:${cert.code}`}
              platform="azure"
              examCode={cert.code}
              className="mt-6 lg:mt-0 lg:w-80 lg:shrink-0"
            />
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-8">
          <div className="space-y-8">
            {/* Listen & Learn — renders nothing until an episode is approved. */}
            <ListenAndLearn
              platform="azure"
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

            {/* Skills measured — the official study guide's outline, area by
                area, each deep-linked to its heading on Microsoft Learn (#498).
                Rendered only when an outline was parsed for this exam: the
                data ships with the site (src/data/azure/study-guides/, one
                module per exam, #500), so this is in the prerendered HTML, and
                an exam with no guide shows nothing rather than an empty
                heading. SkillsMeasured explains how it hydrates. */}
            {outlineKey && <SkillsMeasured key={outlineKey} guideKey={outlineKey} />}

            {/* Microsoft Learn Modules — only when the catalogue lists any; an
                empty section under a heading reads as broken. */}
            {cert.modules?.length > 0 && (
              <DetailSection
                icon="menu_book"
                iconColor={TONE.accentText}
                title="Microsoft Learn Modules"
              >
                <NumberedModuleLinks modules={cert.modules} tone={TONE} />
              </DetailSection>
            )}

            {/* Applied Skills */}
            {cert.appliedSkills?.length > 0 && (
              <DetailSection
                icon="construction"
                iconColor="text-cyan-400"
                title="Associated Applied Skills"
                className="bg-card/40 backdrop-blur-md border border-cyan-500/20 rounded-2xl p-6"
                headingGap="mb-2"
              >
                <p className="text-sm text-foreground/70 mb-4">
                  Scenario-based assessments that complement this certification with hands-on proof.
                </p>
                <div className="space-y-3">
                  {cert.appliedSkills.map((skill, i) => (
                    <a
                      key={i}
                      href={skill.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-start gap-3 group bg-card/40 hover:bg-cyan-900/20 border border-card/30 hover:border-cyan-500/30 rounded-xl px-4 py-3 transition-all"
                    >
                      <span
                        className="text-cyan-400 material-symbols-outlined text-[18px] shrink-0 mt-0.5"
                        aria-hidden="true"
                      >
                        verified
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-mono text-foreground/50 mb-0.5">
                          {skill.code}
                        </div>
                        <div className="text-sm font-semibold text-foreground group-hover:text-cyan-300 transition-colors">
                          {skill.title}
                        </div>
                      </div>
                      <span
                        className="material-symbols-outlined text-[14px] text-foreground/40 group-hover:text-cyan-300 transition-colors shrink-0 mt-1"
                        aria-hidden="true"
                      >
                        open_in_new
                      </span>
                    </a>
                  ))}
                </div>
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
                  hrefFor={(next) => getProviderPath('azure', `education/${next.slug}`)}
                  dotClassFor={(next) => getNextCertDotClass(next.level)}
                  stripTitle={/Microsoft\s+/i}
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
                <StatRow label="Exam Code" valueClass="font-mono font-bold text-primary">
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
                  <StatRow label="Avg. Pass Rate" valueClass="font-bold text-cyan-400">
                    {cert.successRate}
                  </StatRow>
                )}
                <StatRow label="MS Learn Modules">{cert.modules?.length ?? 0}</StatRow>
                <div className="flex justify-between">
                  <span className="text-foreground/60">Catalogue checked</span>
                  <time dateTime={DATA_AS_OF} className="font-bold text-slate-950 dark:text-white">
                    {formatDate(DATA_AS_OF)}
                  </time>
                </div>
              </div>
            </div>

            <BackLink
              to={routes.education('azure')}
              hoverText={TONE.hoverText}
              label="Back to Azure Education"
            />
          </aside>
        </div>
      </main>
    </>
  );
}

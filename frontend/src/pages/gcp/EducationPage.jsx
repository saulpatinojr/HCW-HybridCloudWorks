import React from 'react';
import { Helmet } from 'react-helmet-async';
import {
  LearningPathsSection,
  LearningResourcesSection,
  OfficialLinksSection,
} from '@/pages/shared/education/EducationSections';
import CertificationCarouselSection from '@/components/education/CertificationCarouselSection';
import { useCertificationCarousel } from '@/components/education/useCertificationCarousel';
import FeaturedCertSection from '@/components/education/FeaturedCertSection';
import { DATA_AS_OF, DATA_SOURCE, certifications } from '@/data/gcp/certifications';

// ── Constants ────────────────────────────────────────────────────────────────

const LEVEL_META = {
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
};

const FILTER_LEVELS = ['All', 'Foundational', 'Associate', 'Professional'];
const STATUS_FILTER = ['All', 'Active'];
const VISIBLE_COUNT = 4;

// The hub's colour classes, handed to the shared education components so
// their markup names no colour. Full class strings, so Tailwind sees them.
const TONE = {
  headingIcon: 'text-primary',
  activeDot: 'bg-primary',
  activeFilter: 'bg-primary/30 border-primary text-primary',
  cardHover: 'hover:shadow-[0_0_20px_rgba(59,130,246,0.15)] hover:border-primary/40',
  titleHover: 'group-hover:text-primary',
  linkHover: 'hover:bg-primary/20 hover:text-primary',
  accentText: 'text-primary',
  articleHover: 'hover:shadow-[0_0_25px_rgba(59,130,246,0.15)] hover:border-primary/50',
  badge: 'bg-primary/20 border border-primary/30 text-primary',
  button: 'bg-primary hover:opacity-90 text-primary-foreground',
  gettingStartedCard:
    'bg-linear-to-br from-primary/20 to-blue-900/20 backdrop-blur-md border border-primary/30',
};

/** The hub's own link to the issuer's full catalogue, under the featured credential. */
const ALL_CERTS = { href: 'https://cloud.google.com/certification', label: 'View All GCP Certs ↗' };

/** The "Getting Started" card beside the catalogue: where a newcomer begins. */
const GETTING_STARTED = {
  text: 'New to Google Cloud? CDL (Cloud Digital Leader) and ACE (Associate Cloud Engineer) are the best entry points before Professional certifications.',
  href: 'https://cloud.google.com/certification/cloud-digital-leader',
  label: 'Start with CDL',
};

function getLevelFilterClass(levelFilter, level) {
  if (levelFilter !== level) {
    return 'bg-card/30 border-card/50 text-foreground/60 hover:text-foreground hover:border-foreground/40';
  }
  if (level === 'All') {
    return 'bg-primary/30 border-primary text-primary';
  }
  return `${LEVEL_META[level]?.badge ?? ''} border-current`;
}

// ── Data ─────────────────────────────────────────────────────────────────────

const learningPaths = [
  {
    id: 0,
    certCode: 'CDL',
    title: 'Cloud Foundations Path',
    level: 'Beginner',
    hours: 20,
    description:
      'Start your Google Cloud journey with core cloud concepts, GCP products, identity, and cost management.',
    modules: [
      { title: 'Core Cloud Concepts' },
      { title: 'GCP Products Overview' },
      { title: 'Identity & IAM' },
      { title: 'Billing & Cost Management' },
    ],
    certUrl: 'https://cloud.google.com/certification/cloud-digital-leader',
  },
  {
    id: 1,
    certCode: 'PCA',
    title: 'Cloud Architect Path',
    level: 'Advanced',
    hours: 60,
    description:
      'Design enterprise-grade architectures on Google Cloud with a focus on reliability, security, and scale.',
    modules: [
      { title: 'Compute & Containers' },
      { title: 'Storage & Databases' },
      { title: 'Networking' },
      { title: 'Security & Compliance' },
      { title: 'Cost Optimization' },
    ],
    certUrl: 'https://cloud.google.com/certification/cloud-architect',
  },
  {
    id: 2,
    certCode: 'PDE',
    title: 'Data & AI Path',
    level: 'Advanced',
    hours: 55,
    description:
      'Build data pipelines and ML systems using BigQuery, Dataflow, Pub/Sub, and Vertex AI on Google Cloud.',
    modules: [
      { title: 'BigQuery & Analytics' },
      { title: 'Dataflow & Pub/Sub' },
      { title: 'Vertex AI' },
      { title: 'MLOps & Pipelines' },
    ],
    certUrl: 'https://cloud.google.com/certification/data-engineer',
  },
];

const resources = [
  {
    id: 'skills-boost',
    title: 'Google Cloud Skills Boost',
    description:
      'Official learning platform with hands-on labs, courses, and skill badges covering all Google Cloud services.',
    type: 'Learning Platform',
    icon: 'school',
    url: 'https://cloudskillsboost.google/',
  },
  {
    id: 'gcp-docs',
    title: 'GCP Documentation',
    description:
      'Comprehensive reference documentation, quickstarts, and tutorials for every Google Cloud product.',
    type: 'Documentation',
    icon: 'description',
    url: 'https://cloud.google.com/docs',
  },
  {
    id: 'cloud-onboard',
    title: 'Cloud OnBoard',
    description:
      'Free Google Cloud onboarding events and workshops for developers and architects — live and on-demand.',
    type: 'Events',
    icon: 'event',
    url: 'https://cloudonair.withgoogle.com/',
  },
  {
    id: 'practice-exams',
    title: 'Practice Exams',
    description:
      'Official Google Cloud practice exams to gauge exam readiness across certification tracks.',
    type: 'Practice Exams',
    icon: 'checklist',
    url: 'https://cloud.google.com/certification/practice-exam',
  },
  {
    id: 'coursera',
    title: 'Coursera GCP Courses',
    description:
      'Instructor-led Google Cloud courses on Coursera covering architecture, data, security, and ML.',
    type: 'Courses',
    icon: 'play_circle',
    url: 'https://www.coursera.org/googlecloud',
  },
  {
    id: 'next-videos',
    title: 'Google Cloud Next Videos',
    description:
      'On-demand sessions from Google Cloud Next with deep dives on every product and architecture pattern.',
    type: 'Video',
    icon: 'smart_display',
    url: 'https://cloudonair.withgoogle.com/events/next',
  },
];

/** The two big links to the issuer's own sites, near the top of the page. */
const OFFICIAL_LINKS = [
  {
    href: 'https://cloudskillsboost.google/',
    tone: 'blue',
    icon: 'workspace_premium',
    title: 'Google Cloud Skills Boost',
    badge: 'Official',
    address: 'cloudskillsboost.google',
    text: 'Hands-on labs, skill badges, and learning paths from Google Cloud — the official platform for building verified cloud skills at any level.',
  },
  {
    href: 'https://cloud.google.com/certification',
    tone: 'cyan',
    icon: 'construction',
    title: 'GCP Certification Portal',
    badge: 'Exams & Badges',
    address: 'cloud.google.com/certification',
    text: 'Browse all Google Cloud certifications, find exam guides, register for exams, and access your certification transcript and digital badges.',
  },
];

// ── Page ─────────────────────────────────────────────────────────────────────

export default function GCPEducationPage() {
  const carousel = useCertificationCarousel(certifications, {
    visibleCount: VISIBLE_COUNT,
    asOf: DATA_AS_OF,
  });

  const featuredCert = certifications.find((c) => c.featured);

  return (
    <>
      <Helmet>
        <title>Google Cloud Education &amp; Certifications | HCW</title>
        <meta
          name="description"
          content="Google Cloud certification prep, learning paths, and resources — from Cloud Digital Leader to Professional certifications."
        />
        <meta property="og:title" content="Google Cloud Education & Certifications" />
        <meta
          property="og:description"
          content="Structured learning paths, certification prep, and curated resources for Google Cloud certifications."
        />
      </Helmet>

      <main className="grow pt-28 pb-20 px-4 md:px-8 max-w-360 mx-auto w-full">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className="mb-12 relative">
          <div className="absolute -top-10 -left-10 w-96 h-96 bg-blue-500/5 blur-3xl rounded-full pointer-events-none" />
          <div className="absolute -top-5 right-0 w-72 h-72 bg-cyan-500/5 blur-3xl rounded-full pointer-events-none" />
          <h1 className="text-3xl sm:text-5xl md:text-6xl font-bold mb-4 relative z-10">
            <span className="bg-clip-text text-transparent bg-linear-to-r from-gcp-primary via-slate-900 to-gcp-primary dark:via-white">
              Google Cloud Education &amp; Certifications
            </span>
          </h1>
          <p className="text-base sm:text-lg text-foreground max-w-3xl relative z-10">
            Master Google Cloud Platform with structured learning paths and official certifications
            — from Cloud Digital Leader through Professional-level specializations.
          </p>
          <div className="flex flex-wrap gap-2 mt-4 relative z-10">
            {['Foundational', 'Associate', 'Professional'].map((level) => (
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
        <OfficialLinksSection links={OFFICIAL_LINKS} />

        {/* ── Browse Certifications Carousel ───────────────────────────── */}
        <CertificationCarouselSection
          asOf={DATA_AS_OF}
          source={DATA_SOURCE}
          filterLevels={FILTER_LEVELS}
          statusFilters={STATUS_FILTER}
          levelMeta={LEVEL_META}
          getLevelFilterClass={getLevelFilterClass}
          tone={TONE}
          carousel={carousel}
        />

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
        <LearningPathsSection paths={learningPaths} palette="primary" issuer="Google Cloud" />

        {/* ── Learning Resources ───────────────────────────────────────── */}
        <LearningResourcesSection resources={resources} palette="primary" />
      </main>
    </>
  );
}

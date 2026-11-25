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
import { DATA_AS_OF, DATA_SOURCE, certifications } from '@/data/github/certifications';

// ── Constants ────────────────────────────────────────────────────────────────

const LEVEL_META = {
  Foundations: {
    badge: 'bg-sky-500/20 border-sky-500/40 text-sky-300',
    accent: 'border-l-sky-500',
    dot: 'bg-sky-500',
    label: 'Foundations',
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

const FILTER_LEVELS = ['All', 'Foundations', 'Associate', 'Professional'];
const STATUS_FILTER = ['All', 'Active'];
const VISIBLE_COUNT = 4;

// The hub's colour classes, handed to the shared education components so
// their markup names no colour. Full class strings, so Tailwind sees them.
const TONE = {
  headingIcon: 'text-slate-300',
  activeDot: 'bg-slate-400',
  activeFilter: 'bg-slate-500/25 border-slate-400 text-slate-300',
  cardHover: 'hover:shadow-[0_0_20px_rgba(148,163,184,0.12)] hover:border-slate-400/40',
  titleHover: 'group-hover:text-slate-300',
  linkHover: 'hover:bg-slate-500/20 hover:text-slate-300',
  accentText: 'text-slate-300',
  articleHover: 'hover:shadow-[0_0_25px_rgba(148,163,184,0.12)] hover:border-slate-400/50',
  badge: 'bg-slate-500/20 border border-slate-500/30 text-slate-300',
  button: 'bg-slate-600 hover:bg-slate-500 text-white',
  gettingStartedCard:
    'bg-gradient-to-br from-slate-700/30 to-slate-900/20 backdrop-blur-md border border-slate-500/30',
};

/** The hub's own link to the issuer's full catalogue, under the featured credential. */
const ALL_CERTS = {
  href: 'https://examregistration.github.com/overview',
  label: 'View All GitHub Certs ↗',
};

/** The "Getting Started" card beside the catalogue: where a newcomer begins. */
const GETTING_STARTED = {
  text: 'New to GitHub certifications? Start with GH-100 (Foundations) to build core Git and GitHub skills before tackling Actions or Advanced Security.',
  href: 'https://examregistration.github.com/overview',
  label: 'Start with GH-100',
};

function getLevelFilterClass(levelFilter, level) {
  if (levelFilter !== level) {
    return 'bg-card/30 border-card/50 text-foreground/60 hover:text-foreground hover:border-foreground/40';
  }
  if (level === 'All') {
    return 'bg-slate-500/30 border-slate-400 text-slate-300';
  }
  return `${LEVEL_META[level]?.badge ?? ''} border-current`;
}

// ── Data ─────────────────────────────────────────────────────────────────────

const learningPaths = [
  {
    id: 0,
    certCode: 'GH-900',
    title: 'GitHub Foundations Path',
    level: 'Beginner',
    hours: 20,
    description:
      'Build Git and GitHub fluency from the ground up — covering repositories, branching strategies, pull requests, and project management.',
    modules: [
      { title: 'Git Fundamentals' },
      { title: 'Repositories & Branching' },
      { title: 'Pull Requests & Code Review' },
      { title: 'GitHub Projects' },
    ],
    certUrl: 'https://examregistration.github.com/overview',
  },
  {
    id: 1,
    certCode: 'GH-200',
    title: 'Actions & CI/CD Path',
    level: 'Intermediate',
    hours: 30,
    description:
      'Automate software workflows with GitHub Actions — from basic pipelines to reusable workflows and security best practices.',
    modules: [
      { title: 'Workflow Syntax' },
      { title: 'Runners & Environments' },
      { title: 'Reusable Workflows' },
      { title: 'Security in Actions' },
    ],
    certUrl: 'https://examregistration.github.com/overview',
  },
  {
    id: 2,
    certCode: 'GH-500',
    title: 'Advanced Security Path',
    level: 'Advanced',
    hours: 40,
    description:
      'Secure your software supply chain with CodeQL code scanning, secret scanning, Dependabot alerts, and SBOM generation.',
    modules: [
      { title: 'Code Scanning with CodeQL' },
      { title: 'Secret Scanning' },
      { title: 'Dependabot Alerts' },
      { title: 'SBOM & Supply Chain' },
    ],
    certUrl: 'https://examregistration.github.com/overview',
  },
];

const resources = [
  {
    id: 'github-skills',
    title: 'GitHub Skills',
    description:
      'Learn how to use GitHub with interactive, hands-on courses built directly in GitHub repositories.',
    type: 'Learning Platform',
    icon: 'school',
    url: 'https://skills.github.com/',
  },
  {
    id: 'github-docs',
    title: 'GitHub Docs',
    description:
      'Official documentation for every GitHub feature — from Actions workflows to Advanced Security configuration.',
    type: 'Documentation',
    icon: 'description',
    url: 'https://docs.github.com/',
  },
  {
    id: 'github-universe',
    title: 'GitHub Universe Videos',
    description:
      'On-demand sessions from GitHub Universe covering AI, security, CI/CD, and developer productivity.',
    type: 'Video',
    icon: 'play_circle',
    url: 'https://githubuniverse.com/',
  },
  {
    id: 'github-learning-lab',
    title: 'GitHub Learning Lab',
    description:
      'Self-paced learning experiences that teach GitHub skills through bot-guided interactive exercises.',
    type: 'Labs',
    icon: 'science',
    url: 'https://skills.github.com/',
  },
  {
    id: 'practice-tests',
    title: 'Practice Tests',
    description:
      'Third-party practice tests for GitHub certifications covering exam objectives across all certification tracks.',
    type: 'Practice Exams',
    icon: 'checklist',
    url: 'https://examregistration.github.com/overview',
  },
  {
    id: 'github-blog',
    title: 'GitHub Blog',
    description:
      'Product announcements, engineering deep dives, and best practices from the GitHub team.',
    type: 'Blog',
    icon: 'article',
    url: 'https://github.blog/',
  },
];

/** The two big links to the issuer's own sites, near the top of the page. */
const OFFICIAL_LINKS = [
  {
    href: 'https://skills.github.com/',
    tone: 'slate',
    icon: 'workspace_premium',
    title: 'GitHub Skills',
    badge: 'Free',
    address: 'skills.github.com',
    text: 'Learn GitHub hands-on through interactive, project-based courses that run directly inside GitHub repositories — no setup required.',
  },
  {
    href: 'https://examregistration.github.com/',
    tone: 'slate',
    icon: 'construction',
    title: 'GitHub Certification Portal',
    badge: 'Register',
    address: 'examregistration.github.com',
    text: 'Register for GitHub certification exams, view available certifications, and access your exam history and digital badges after passing.',
  },
];

// ── Page ─────────────────────────────────────────────────────────────────────

export default function GitHubEducationPage() {
  const carousel = useCertificationCarousel(certifications, {
    visibleCount: VISIBLE_COUNT,
    asOf: DATA_AS_OF,
  });

  const featuredCert = certifications.find((c) => c.featured);

  return (
    <>
      <Helmet>
        <title>GitHub Skills &amp; Certifications | HCW</title>
        <meta
          name="description"
          content="GitHub certification prep, learning paths, and resources — covering Foundations, Actions, Copilot, Advanced Security, and Administration."
        />
        <meta property="og:title" content="GitHub Skills & Certifications" />
        <meta
          property="og:description"
          content="Structured learning paths, certification prep, and curated resources for GitHub certifications."
        />
      </Helmet>

      <main className="flex-grow pt-28 pb-20 px-4 md:px-8 max-w-[1440px] mx-auto w-full">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className="mb-12 relative">
          <div className="absolute -top-10 -left-10 w-96 h-96 bg-slate-500/5 blur-3xl rounded-full pointer-events-none" />
          <h1 className="text-3xl sm:text-5xl md:text-6xl font-bold mb-4 relative z-10">
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-slate-700 via-slate-900 to-slate-700 dark:from-slate-300 dark:via-white dark:to-slate-300">
              GitHub Skills &amp; Certifications
            </span>
          </h1>
          <p className="text-base sm:text-lg text-foreground max-w-3xl relative z-10">
            Validate your GitHub expertise with official certifications covering foundations, CI/CD
            automation, GitHub Copilot, advanced security, and enterprise administration.
          </p>
          <div className="flex flex-wrap gap-2 mt-4 relative z-10">
            {['Foundations', 'Associate', 'Professional'].map((level) => (
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
        <LearningPathsSection paths={learningPaths} palette="slate" issuer="GitHub" />

        {/* ── Learning Resources ───────────────────────────────────────── */}
        <LearningResourcesSection resources={resources} palette="slate" />
      </main>
    </>
  );
}

import React from 'react';
import { Link } from 'react-router';
import { routes } from '@/lib/routeFactory';
import ProviderLandingTemplate from '@/components/shared/ProviderLandingTemplate';
import {
  CertTrackGrid,
  FeatureCardGrid,
  FrameworkCardGrid,
} from '@/pages/shared/landing/LandingSections';
import HeroImageCarousel from '@/components/landing/HeroImageCarousel';
import { useCoderCornerData } from '@/hooks/useCoderCornerData';

// Generated art (#371): scripts/generate-brand-art.mjs draws this set; replace any
// file one-for-one to swap in real artwork. scripts/hero-assets-exist.test.js
// fails on a path listed here that is not under public/.
const GITHUB_HERO_IMAGES = [
  '/images/github-hero/1.png',
  '/images/github-hero/2.png',
  '/images/github-hero/3.png',
  '/images/github-hero/4.png',
  '/images/github-hero/5.png',
];

/*
 * NOTE: links previously pointed at /github/frameworks (404 — GitHub is not
 * handled by the frameworks dispatcher) and used the undefined `gh-blue`
 * utility class. All links now target live routes and theme tokens.
 */

const ACTION_CARDS = [
  {
    label: 'CI/CD',
    meta: 'Reusable',
    title: 'Workflow Templates',
    text: 'Production-ready reusable workflows for CI/CD, security scanning, and automated releases. Plug and play into any repository.',
    tags: ['Node.js', 'Python', 'Go'],
    to: routes.workflows('github'),
  },
  {
    label: 'Security',
    meta: 'GHAS',
    title: 'Security Scanning',
    text: 'CodeQL analysis, Dependabot automation, secret scanning, and SBOM generation for enterprise repositories.',
    tags: ['CodeQL', 'Dependabot', 'SBOM'],
    to: routes.code('github'),
  },
];

const PRACTICES = [
  {
    abbr: 'GH-FLOW',
    name: 'GitHub Flow',
    description:
      'Lightweight, branch-based workflow for teams of any size. Branch, commit, PR, review, deploy.',
    to: routes.workflows('github'),
  },
  {
    abbr: 'GH-AP',
    name: 'GitHub Actions Patterns',
    description:
      'Reusable workflow patterns for CI/CD, security scanning, release automation, and dependency management.',
    to: routes.workflows('github'),
  },
  {
    abbr: 'GHAS',
    name: 'GitHub Advanced Security',
    description:
      'Code scanning with CodeQL, secret scanning, Dependabot alerts, and supply chain security for enterprise repos.',
    to: routes.code('github'),
  },
];

const LEARNING = [
  {
    code: 'GH-FOUND',
    title: 'GitHub Foundations',
    difficulty: 'Beginner',
    duration: '4 weeks',
    skills: ['Git', 'Repos', 'PRs'],
    to: routes.education('github'),
  },
  {
    code: 'GH-ACTIONS',
    title: 'GitHub Actions CI/CD',
    difficulty: 'Intermediate',
    duration: '6 weeks',
    skills: ['Workflows', 'Runners', 'Secrets'],
    to: routes.workflows('github'),
  },
  {
    code: 'GHAS',
    title: 'GitHub Advanced Security',
    difficulty: 'Advanced',
    duration: '8 weeks',
    skills: ['CodeQL', 'Dependabot', 'SBOM'],
    to: routes.education('github'),
  },
];

function CoderCornerPanel() {
  const { items, loading } = useCoderCornerData('github');
  const visible = items.slice(0, 3);

  return (
    <div className="flex flex-col gap-3">
      {loading && visible.length === 0 && (
        <p className="text-sm text-slate-500 py-2">Loading community scripts…</p>
      )}
      {!loading && visible.length === 0 && (
        <p className="text-sm text-slate-500 py-2">
          No Coder Corner entries published yet — check back soon.
        </p>
      )}
      {visible.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {visible.map((item) => (
            <Link
              key={item.id}
              to={`/github/coder-corner/${item.slug}`}
              className="glass glass-hover rounded-xl p-4 flex flex-col gap-1"
            >
              <div className="flex justify-between items-center">
                <span className="text-sm font-semibold text-foreground line-clamp-1">
                  {item.title}
                </span>
                {item.date && <span className="text-[10px] text-slate-500">{item.date}</span>}
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2">
                {item.description}
              </p>
            </Link>
          ))}
        </div>
      )}
      <Link
        to={routes.coderCorner('github')}
        className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline w-fit"
      >
        Visit Coder Corner
        <span className="material-symbols-outlined text-xs" aria-hidden="true">
          arrow_forward
        </span>
      </Link>
    </div>
  );
}

export default function GitHubLandingPage() {
  return (
    <ProviderLandingTemplate
      provider="github"
      hero={{
        eyebrow: 'DEVELOPER PRODUCTIVITY & AUTOMATION',
        title: (
          <>
            Engineering intelligence with <span className="display-accent">GitHub</span>
          </>
        ),
        description:
          'Next-gen automation workflows, deep repo insights, and community-driven scripts for the modern DevOps engineer.',
        media: (
          <HeroImageCarousel
            images={GITHUB_HERO_IMAGES}
            intervalMs={3000}
            fadeMs={800}
            alt="GitHub engineering imagery"
          />
        ),
        cta: { label: 'Browse Workflows', to: routes.workflows('github') },
        stats: [
          { value: '50', suffix: '+', label: 'Template Workflows' },
          { value: '5', label: 'Languages Covered' },
          { value: '3', label: 'Learning Tracks' },
        ],
      }}
      sections={[
        {
          eyebrow: 'AUTOMATION',
          title: 'GitHub Actions Library',
          action: { label: 'All workflows', to: routes.workflows('github') },
          content: <FeatureCardGrid cards={ACTION_CARDS} />,
        },
        {
          eyebrow: 'COMMUNITY',
          title: "Coder's Corner",
          action: { label: 'All entries', to: routes.coderCorner('github') },
          content: <CoderCornerPanel />,
        },
        {
          eyebrow: 'PRACTICES',
          title: 'Engineering Practices',
          content: <FrameworkCardGrid frameworks={PRACTICES} />,
        },
        {
          eyebrow: 'LEARNING CENTER',
          title: 'Learning Tracks',
          action: { label: 'Learning hub', to: routes.education('github') },
          content: <CertTrackGrid certs={LEARNING} linkFor={(track) => track.to} columns={3} />,
        },
      ]}
    />
  );
}

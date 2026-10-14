import React from 'react';
import { Link } from 'react-router';
import { routes } from '@/lib/routeFactory';
import ProviderLandingTemplate from '@/components/shared/ProviderLandingTemplate';
import HeroImageCarousel from '@/components/landing/HeroImageCarousel';

// Generated art (#371): scripts/generate-brand-art.mjs draws this set; replace any
// file one-for-one to swap in real artwork. scripts/hero-assets-exist.test.js
// fails on a path listed here that is not under public/.
const FINOPS_HERO_IMAGES = [
  '/images/finops-hero/1.png',
  '/images/finops-hero/2.png',
  '/images/finops-hero/3.png',
  '/images/finops-hero/4.png',
  '/images/finops-hero/5.png',
];

const ARCHITECTURE_CARDS = [
  {
    label: 'Cost Allocation',
    meta: 'Multi-Cloud',
    title: 'Cost Allocation Blueprint',
    text: 'Comprehensive blueprints for multi-cloud cost allocation and shared services modeling at enterprise scale.',
    tags: ['Tagging', 'Showback', 'Chargeback'],
  },
  {
    label: 'Anomaly Detection',
    meta: 'Real-Time',
    title: 'Cost Anomaly Architecture',
    text: 'Real-time anomaly detection patterns using cloud-native tools and FOCUS-compliant billing data pipelines.',
    tags: ['FOCUS', 'Alerting', 'ML'],
  },
];

const FRAMEWORKS = [
  {
    abbr: 'FF',
    name: 'FinOps Framework',
    description:
      'The FinOps Foundation open standard covering capabilities, domains, and personas for cloud financial management.',
  },
  {
    abbr: 'FOCUS',
    name: 'FOCUS Specification',
    description:
      'FinOps Open Cost & Usage Specification — a common schema for cloud billing data across AWS, Azure, GCP, and OCI.',
  },
  {
    abbr: 'CCMM',
    name: 'Cloud Cost Maturity Model',
    description:
      'Five-stage model for assessing and advancing organizational cloud cost management practices.',
  },
];

const COURSES = [
  {
    title: 'FinOps Certified Practitioner',
    duration: '8 weeks',
    skills: ['FOCUS', 'Allocation', 'Optimization'],
  },
  {
    title: 'FinOps for Engineers',
    duration: '4 weeks',
    skills: ['Tagging', 'Budgets', 'Alerts'],
  },
];

function ArchitectureCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {ARCHITECTURE_CARDS.map((card) => (
        <Link
          key={card.title}
          to={routes.architectureDesigns('finops')}
          className="glass glass-hover rounded-xl overflow-hidden flex flex-col"
        >
          <div className="h-2 w-full bg-primary/60" aria-hidden="true" />
          <div className="p-5 flex flex-col gap-2 flex-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] bg-primary/15 text-primary px-2 py-0.5 rounded font-bold uppercase tracking-wide">
                {card.label}
              </span>
              <span className="text-[10px] text-slate-500">{card.meta}</span>
            </div>
            <h3 className="font-bold text-foreground">{card.title}</h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              {card.text}
            </p>
            <div className="flex gap-1 flex-wrap mt-auto pt-2">
              {card.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

function FocusPanel() {
  return (
    <div className="glass rounded-xl p-6 grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
          The FinOps Open Cost &amp; Usage Specification (FOCUS) is an open-source project to define
          a common schema for cloud billing data across AWS, Azure, GCP, and OCI.
        </p>
        <Link
          to={routes.focus('finops')}
          className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:underline w-fit"
        >
          View Specs
          <span className="material-symbols-outlined text-xs" aria-hidden="true">
            arrow_forward
          </span>
        </Link>
      </div>
      <ul className="space-y-3">
        {['FOCUS 1.4 Common Schema', 'Multi-Vendor Support', 'Attribution Standards'].map(
          (item) => (
            <li
              key={item}
              className="flex items-center gap-3 text-sm text-slate-700 dark:text-slate-300"
            >
              <span className="material-symbols-outlined text-primary text-lg" aria-hidden="true">
                check_circle
              </span>
              {item}
            </li>
          )
        )}
      </ul>
    </div>
  );
}

function FrameworkCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {FRAMEWORKS.map(({ abbr, name, description }) => (
        <div key={abbr} className="glass rounded-xl p-5 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="size-10 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-base" aria-hidden="true">
                account_tree
              </span>
            </div>
            <div>
              <div className="text-[10px] font-black text-primary/80 tracking-widest uppercase">
                {abbr}
              </div>
              <h3 className="text-sm font-bold text-foreground leading-snug">{name}</h3>
            </div>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            {description}
          </p>
        </div>
      ))}
    </div>
  );
}

function LearningPanel() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {COURSES.map(({ title, duration, skills }) => (
        <Link
          key={title}
          to={routes.education('finops')}
          className="glass glass-hover rounded-xl flex items-start gap-3 p-4"
        >
          <div className="size-10 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
            <span className="material-symbols-outlined text-primary text-base" aria-hidden="true">
              workspace_premium
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-[10px] text-slate-500">{duration}</span>
            <h3 className="text-sm font-bold text-foreground leading-snug">{title}</h3>
            <div className="flex gap-1 flex-wrap mt-1">
              {skills.map((s) => (
                <span
                  key={s}
                  className="text-[10px] bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 px-1.5 py-0.5 rounded"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        </Link>
      ))}
      <Link
        to={routes.tools('finops')}
        className="glass glass-hover rounded-xl flex items-start gap-3 p-4 sm:col-span-2"
      >
        <div className="size-10 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
          <span className="material-symbols-outlined text-primary text-base" aria-hidden="true">
            construction
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-bold text-foreground leading-snug">Cloud Cost Tools</h3>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            Zombie Hunter, Bill Decoder, and other utilities for hands-on cost analysis.
          </p>
        </div>
      </Link>
    </div>
  );
}

export default function FinOpsLandingPage() {
  return (
    <ProviderLandingTemplate
      provider="finops"
      hero={{
        eyebrow: 'FINOPS FOUNDATION · FOCUS STANDARD',
        title: (
          <>
            Cloud financial intelligence with <span className="display-accent">FinOps</span>
          </>
        ),
        description:
          'The central hub for FinOps standards, open-source cost specifications, and architectural best practices for the modern enterprise.',
        media: (
          <HeroImageCarousel
            images={FINOPS_HERO_IMAGES}
            intervalMs={3000}
            fadeMs={800}
            alt="FinOps cloud financial imagery"
          />
        ),
        cta: { label: 'Browse Architectures', to: routes.architectureDesigns('finops') },
        stats: [
          { value: '6', label: 'Framework Domains' },
          { value: '1.4', label: 'FOCUS Schema' },
          { value: '2', label: 'Learning Paths' },
        ],
      }}
      sections={[
        {
          eyebrow: 'REFERENCE DESIGNS',
          title: 'FinOps Reference Architectures',
          action: { label: 'All blueprints', to: routes.architectureDesigns('finops') },
          content: <ArchitectureCards />,
        },
        {
          eyebrow: 'OPEN STANDARD',
          title: 'Focus on FOCUS 1.4',
          action: { label: 'FOCUS hub', to: routes.focus('finops') },
          content: <FocusPanel />,
        },
        {
          eyebrow: 'GUIDANCE',
          title: 'Frameworks',
          action: { label: 'All frameworks', to: routes.frameworks('finops') },
          content: <FrameworkCards />,
        },
        {
          eyebrow: 'LEARNING CENTER',
          title: 'Certifications & Tools',
          action: { label: 'Learning hub', to: routes.education('finops') },
          content: <LearningPanel />,
        },
      ]}
    />
  );
}

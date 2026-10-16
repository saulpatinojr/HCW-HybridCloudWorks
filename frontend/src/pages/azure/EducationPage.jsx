import React, { useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router';
import { getProviderPath, routes } from '@/lib/routeFactory';
import ProviderLabsSection from '@/components/labs/ProviderLabsSection';
import { plural } from '@/components/labs/labsWords';
import ResourceLink, { resourceCta } from '@/components/education/ResourceLink';
import { labsForProvider } from '@/data/labs/catalogue';
import {
  DATA_AS_OF,
  LEVEL_META,
  certifications,
  appliedSkills,
  timelineEvents,
} from '@/data/azure/certifications';
import { daysUntil, deriveStatus, formatIsoDate, isPastDate, useToday } from '@/lib/certStatus';
import { certEventToTimelineEvent, mergeTimelineEvents } from '@/lib/certEvents';
import { fetchPublicCertEvents } from '@/lib/publicApi';
import { usePublicData } from '@/hooks/usePublicData';

// ── Constants ────────────────────────────────────────────────────────────────

const FILTER_LEVELS = ['All', 'Fundamentals', 'Associate', 'Expert', 'Specialty'];
const STATUS_FILTER = ['All', 'Active', 'Beta', 'Expiring', 'Retired'];
const STATUS_ORDER = { active: 0, beta: 1, expiring: 2, retired: 3 };
const CODE_BY_SLUG = new Map(certifications.map((c) => [c.slug, c.code]));
const VISIBLE_COUNT = 4;
const APPLIED_SKILLS_COLLAPSED_ROWS = 3;

function getMonthColumnFill(isCurrentMonth, index) {
  if (isCurrentMonth) {
    return 'rgba(99,102,241,0.07)';
  }
  return index % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.00)';
}

function getLevelFilterClass(levelFilter, level) {
  if (levelFilter !== level) {
    return 'bg-card/30 border-card/50 text-foreground/60 hover:text-foreground hover:border-foreground/40';
  }
  if (level === 'All') {
    return 'bg-primary/30 border-primary text-primary';
  }
  return `${LEVEL_META[level]?.badge ?? ''} border-current`;
}

function getStatusFilterClass(statusFilter, status) {
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

const TIMELINE_TYPE_META = {
  beta_launch: {
    icon: 'science',
    color: 'text-amber-400',
    bg: 'bg-amber-500/15 border-amber-500/30',
    label: 'Beta',
  },
  ga_launch: {
    icon: 'rocket_launch',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/15 border-emerald-500/30',
    label: 'Live',
  },
  retirement: {
    icon: 'schedule',
    color: 'text-rose-400',
    bg: 'bg-rose-500/15 border-rose-500/30',
    label: 'Retiring',
  },
  update: {
    icon: 'update',
    color: 'text-blue-400',
    bg: 'bg-blue-500/15 border-blue-500/30',
    label: 'Updated',
  },
};

const TIMELINE_STATUS_ORDER = ['beta_launch', 'ga_launch', 'update', 'retirement'];

const TIMELINE_CREDENTIAL_TYPE_META = {
  applied_skill: {
    icon: 'construction',
    label: 'Applied Skills',
    color: 'text-cyan-300',
  },
  certification: {
    iconSrc: '/icons/certs/certification.svg',
    label: 'Certification',
    color: 'text-primary',
  },
};

const APPLIED_SKILL_AREAS = [
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

function getAppliedSkillColumnCount() {
  if (typeof window === 'undefined') return 4;
  if (window.matchMedia('(min-width: 1280px)').matches) return 4;
  if (window.matchMedia('(min-width: 1024px)').matches) return 3;
  if (window.matchMedia('(min-width: 640px)').matches) return 2;
  return 1;
}

const learningPaths = [
  {
    id: 1,
    certCode: 'AZ-900',
    title: 'Azure Fundamentals Path',
    level: 'Beginner',
    hours: 20,
    description: 'Start your Azure journey with core concepts, services, pricing, and governance.',
    modules: [
      {
        title: 'Describe cloud concepts',
        url: 'https://learn.microsoft.com/en-us/training/modules/describe-cloud-compute/',
      },
      {
        title: 'Describe Azure architecture and services',
        url: 'https://learn.microsoft.com/en-us/training/modules/describe-core-azure-services/',
      },
      {
        title: 'Describe Azure management and governance',
        url: 'https://learn.microsoft.com/en-us/training/modules/describe-cost-management-azure/',
      },
      {
        title: 'Describe Azure subscriptions and management groups',
        url: 'https://learn.microsoft.com/en-us/training/modules/describe-azure-subscriptions-management-groups/',
      },
    ],
    relatedAppliedSkills: [],
    certUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/azure-fundamentals/',
  },
  {
    id: 2,
    certCode: 'AZ-104',
    title: 'Azure Administrator Path',
    level: 'Intermediate',
    hours: 45,
    description: 'Manage Azure resources, identities, storage, compute, and networking.',
    modules: [
      {
        title: 'Manage Azure identities and governance',
        url: 'https://learn.microsoft.com/en-us/training/modules/azure-active-directory/',
      },
      {
        title: 'Implement and manage storage',
        url: 'https://learn.microsoft.com/en-us/training/modules/azure-storage-fundamentals/',
      },
      {
        title: 'Deploy and manage Azure compute resources',
        url: 'https://learn.microsoft.com/en-us/training/modules/azure-compute-fundamentals/',
      },
      {
        title: 'Implement and manage virtual networking',
        url: 'https://learn.microsoft.com/en-us/training/modules/azure-networking-fundamentals/',
      },
      {
        title: 'Monitor and maintain Azure resources',
        url: 'https://learn.microsoft.com/en-us/training/modules/intro-to-azure-monitor/',
      },
    ],
    relatedAppliedSkills: ['APL-1002', 'APL-1003'],
    certUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/azure-administrator/',
  },
  {
    id: 3,
    certCode: 'AZ-305',
    title: 'Azure Solutions Architect Path',
    level: 'Advanced',
    hours: 60,
    description:
      'Design identity, governance, compute, storage, and networking at enterprise scale.',
    modules: [
      {
        title: 'Design identity, governance, and monitoring solutions',
        url: 'https://learn.microsoft.com/en-us/training/modules/design-identity-governance-monitor-solutions/',
      },
      {
        title: 'Design data storage solutions',
        url: 'https://learn.microsoft.com/en-us/training/modules/design-data-storage-solution-for-non-relational-data/',
      },
      {
        title: 'Design business continuity solutions',
        url: 'https://learn.microsoft.com/en-us/training/modules/design-solution-for-backup-disaster-recovery/',
      },
      {
        title: 'Design infrastructure solutions',
        url: 'https://learn.microsoft.com/en-us/training/modules/design-compute-solution/',
      },
    ],
    relatedAppliedSkills: ['APL-1001', 'APL-1004'],
    certUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/azure-solutions-architect/',
  },
  {
    id: 4,
    certCode: 'AZ-400',
    title: 'Azure DevOps Engineer Path',
    level: 'Advanced',
    hours: 50,
    description: 'Implement DevOps practices including CI/CD, IaC, monitoring, and security.',
    modules: [
      {
        title: 'Get started on a DevOps transformation journey',
        url: 'https://learn.microsoft.com/en-us/training/paths/az-400-get-started-devops-transformation-journey/',
      },
      {
        title: 'Implement CI with Azure Pipelines and GitHub Actions',
        url: 'https://learn.microsoft.com/en-us/training/paths/az-400-implement-ci-azure-pipelines-github-actions/',
      },
      {
        title: 'Design and implement a release strategy',
        url: 'https://learn.microsoft.com/en-us/training/paths/az-400-design-implement-release-strategy/',
      },
      {
        title: 'Implement security and validate code bases for compliance',
        url: 'https://learn.microsoft.com/en-us/training/paths/az-400-implement-security-validate-code-bases-compliance/',
      },
    ],
    relatedAppliedSkills: [],
    certUrl: 'https://learn.microsoft.com/en-us/credentials/certifications/devops-engineer/',
  },
  {
    id: 5,
    certCode: 'AI-103',
    title: 'Azure AI Apps & Agents Path',
    level: 'Intermediate',
    hours: 45,
    description:
      'Build AI apps and agents using Azure AI Foundry, Azure OpenAI, and Semantic Kernel.',
    modules: [
      {
        title: 'Get started with Azure AI Services',
        url: 'https://learn.microsoft.com/en-us/training/modules/introduction-to-azure-ai/',
      },
      {
        title: 'Develop Generative AI Solutions with Azure OpenAI Service',
        url: 'https://learn.microsoft.com/en-us/training/modules/explore-azure-openai/',
      },
      {
        title: 'Develop generative AI apps with Semantic Kernel',
        url: 'https://learn.microsoft.com/en-us/training/modules/develop-ai-agents-azure-open-ai-semantic-kernel-sdk/',
      },
      {
        title: 'Implement knowledge mining with Azure AI Search',
        url: 'https://learn.microsoft.com/en-us/training/modules/introduction-to-azure-search/',
      },
    ],
    relatedAppliedSkills: ['APL-1007', 'AO-9002'],
    certUrl:
      'https://learn.microsoft.com/en-us/credentials/certifications/azure-ai-apps-and-agents-developer-associate/',
  },
];

const resources = [
  {
    id: 'ai-skills-navigator',
    title: 'AI Skills Navigator',
    description:
      "Microsoft's personalized AI skilling tool — take a short assessment and get a custom learning playlist for your role.",
    count: 'Free',
    icon: 'explore',
    url: 'https://aiskillsnavigator.microsoft.com/profile-onboarding',
    highlight: true,
  },
  {
    id: 'ms-learn',
    title: 'Microsoft Learn',
    description: 'Free official learning paths, modules, and hands-on sandbox labs from Microsoft.',
    count: '1,000+',
    icon: 'school',
    url: 'https://learn.microsoft.com/en-us/training/azure/',
  },
  {
    id: 'ms-learn-tv',
    title: 'Microsoft Learn TV',
    description:
      'Live and on-demand video content including exam readiness and deep-dive sessions.',
    count: '500+',
    icon: 'play_circle',
    url: 'https://learn.microsoft.com/en-us/shows/azure/',
  },
  {
    id: 'ms-docs',
    title: 'Official Documentation',
    description: 'Comprehensive reference guides, quickstarts, and tutorials from Microsoft Docs.',
    count: '10K+',
    icon: 'description',
    url: 'https://learn.microsoft.com/en-us/azure/',
  },
  {
    id: 'practice-assessments',
    title: 'Practice Assessments',
    description: 'Free official practice questions to gauge exam readiness — no sign-up required.',
    count: '900+',
    icon: 'checklist',
    url: 'https://learn.microsoft.com/en-us/credentials/certifications/practice-assessments-for-microsoft-certifications',
  },
  {
    id: 'architecture-center',
    title: 'Azure Architecture Center',
    description:
      'Reference architectures, design patterns, and best practice guidance for Azure solutions.',
    count: '200+',
    icon: 'account_tree',
    url: 'https://learn.microsoft.com/en-us/azure/architecture/',
  },
  // The site's own labs under this hub (ADR 0033 §8), in place of the
  // Microsoft Learn labs link this entry carried until 2026-10-03: a lab here
  // opens with the tools installed and needs no subscription.
  {
    id: 'labs',
    title: 'Browser labs',
    description:
      'Hands-on Azure exercises on this site: validate a Landing Zone Builder download with terraform and az already installed, step by step, in your browser.',
    count: plural(labsForProvider('azure').length, 'lab'),
    icon: 'science',
    to: routes.labs('azure'),
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

// A bare YYYY-MM-DD parsed with `new Date(iso)` is UTC midnight, and
// formatting that in a zone west of Greenwich printed the previous day — so
// "Jun 30, 2026" read "Jun 29, 2026" for a viewer in Chicago. formatIsoDate
// formats the calendar day itself.
const formatDate = formatIsoDate;

/** Sort comparator on `date` (`YYYY-MM-DD`): the strings order correctly as text, no Date, no zone. */
const byIsoDate = (a, b) => a.date.localeCompare(b.date);

/**
 * `status` is the DERIVED status (see lib/certStatus.js), never the stored
 * field: until 2026-09-09 this badge printed "BETA · ends Jun 30, 2026" and
 * "Expiring Soon" for exams already gone, because the stored field had not
 * been touched since April (#461).
 */
function StatusBadge({ status, expiryDate, betaEndDate, replacedBy, today, className = '' }) {
  const replacementCode = replacedBy ? CODE_BY_SLUG.get(replacedBy) : null;
  if (status === 'retired') {
    return (
      <span
        className={`inline-flex items-center gap-1 px-2.5 py-1 bg-slate-500/20 border border-slate-500/40 text-slate-300 text-[10px] font-bold rounded-full ${className}`}
      >
        <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
          block
        </span>
        Retired
        {expiryDate && <span className="opacity-70">· {formatDate(expiryDate)}</span>}
        {replacementCode && <span className="opacity-70">· now {replacementCode}</span>}
      </span>
    );
  }
  if (status === 'beta') {
    return (
      <span
        className={`inline-flex items-center gap-1 px-2.5 py-1 bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[10px] font-bold rounded-full ${className}`}
      >
        <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse" />
        BETA
        {betaEndDate && <span className="opacity-70">· ends {formatDate(betaEndDate)}</span>}
      </span>
    );
  }
  if (status === 'expiring') {
    const days = expiryDate ? daysUntil(expiryDate, today) : null;
    return (
      <span
        className={`inline-flex items-center gap-1 px-2.5 py-1 bg-rose-500/20 border border-rose-500/40 text-rose-300 text-[10px] font-bold rounded-full ${className}`}
      >
        <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
          schedule
        </span>
        Expiring Soon
        {days !== null && days > 0 && <span className="opacity-70">· {days}d</span>}
        {replacementCode && <span className="opacity-70">· then {replacementCode}</span>}
      </span>
    );
  }
  return null;
}

function getTimelineStatusType(type) {
  return type === 'applied_skill_retirement' ? 'retirement' : type;
}

function getTimelineStatusMeta(type) {
  return TIMELINE_TYPE_META[getTimelineStatusType(type)] || TIMELINE_TYPE_META.update;
}

function getTimelineCredentialType(ev) {
  return (
    ev.credentialType ||
    (ev.type === 'applied_skill_retirement' ? 'applied_skill' : 'certification')
  );
}

function TimelineCredentialTypeIcon({ credentialType, className = 'h-4 w-4' }) {
  const meta = TIMELINE_CREDENTIAL_TYPE_META[credentialType];
  if (!meta) return null;
  if (meta.iconSrc) {
    return <img src={meta.iconSrc} alt="" aria-hidden="true" className={className} />;
  }
  return (
    <span className={`material-symbols-outlined text-[16px] ${meta.color}`} aria-hidden="true">
      {meta.icon}
    </span>
  );
}

// ── Horizontal Timeline ───────────────────────────────────────────────────────

// Every Date in the timeline is a UTC calendar day: a bare YYYY-MM-DD parses
// as UTC midnight, and only the UTC getters are used, so the month grid and
// the x positions are the same for every viewer and on the build runner. The
// comparisons that decide "past" and the day counts never touch a Date at all
// (isPastDate / daysUntil compare the ISO strings).
function buildMonthColumns(events) {
  if (!events.length) return { months: [], minDate: null, maxDate: null };
  const days = events.map((e) => Date.parse(e.date));
  const minDate = new Date(Math.min(...days));
  const maxDate = new Date(Math.max(...days));
  // Start from the first day of minDate's month, end last day of maxDate's month + 1 buffer
  const start = new Date(Date.UTC(minDate.getUTCFullYear(), minDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(maxDate.getUTCFullYear(), maxDate.getUTCMonth() + 2, 0));
  const months = [];
  let cur = new Date(start);
  while (cur <= end) {
    months.push(new Date(cur));
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }
  return { months, minDate: start, maxDate: end };
}

const COL_WIDTH = 160; // px per month column
const TRACK_HEIGHT = 56; // px per event row
const HEADER_HEIGHT = 40;

function HorizontalTimeline({ events }) {
  const [tooltip, setTooltip] = React.useState(null);
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);
  const scrollContainerRef = React.useRef(null);
  // The catalogue date while pre-rendering and hydrating, the real date after;
  // called before any early return so the hook order is stable. See lib/certStatus.js.
  const today = useToday(DATA_AS_OF);
  const [todayYear, todayMonth] = today.split('-').map(Number);

  const { months, minDate, maxDate } = buildMonthColumns(events);
  const liveCount = events.filter((ev) => ev.live).length;

  // Check scroll position to enable/disable buttons
  const checkScrollPosition = React.useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    setCanScrollLeft(container.scrollLeft > 0);
    setCanScrollRight(container.scrollLeft < container.scrollWidth - container.clientWidth - 1);
  }, []);

  // Scroll left/right by 300px
  const scrollLeft = () => {
    scrollContainerRef.current?.scrollBy({ left: -300, behavior: 'smooth' });
  };

  const scrollRight = () => {
    scrollContainerRef.current?.scrollBy({ left: 300, behavior: 'smooth' });
  };

  // Check scroll position on mount and when scrolling
  React.useEffect(() => {
    checkScrollPosition();
    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener('scroll', checkScrollPosition);
      window.addEventListener('resize', checkScrollPosition);
      return () => {
        container.removeEventListener('scroll', checkScrollPosition);
        window.removeEventListener('resize', checkScrollPosition);
      };
    }
  }, [checkScrollPosition]);

  if (!months.length) return null;

  const totalMs = maxDate - minDate;
  const totalWidth = months.length * COL_WIDTH;

  function xForDate(iso) {
    const ms = Date.parse(iso) - minDate;
    return Math.round((ms / totalMs) * totalWidth);
  }

  // Assign events to non-overlapping rows (greedy lane packing)
  const lanes = [];
  const sortedEvts = [...events].sort(byIsoDate);
  const laneEnds = []; // x-end per lane
  const EVENT_W = 130;
  const eventLanes = sortedEvts.map((ev) => {
    const x = xForDate(ev.date);
    let lane = laneEnds.findIndex((end) => end + 8 <= x);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(x + EVENT_W);
      lanes.push(lane);
    } else {
      laneEnds[lane] = x + EVENT_W;
    }
    return lane;
  });

  const numLanes = Math.max(...eventLanes, 0) + 1;
  const svgHeight = HEADER_HEIGHT + numLanes * TRACK_HEIGHT + 16;

  return (
    <section className="mb-16">
      <h3 className="text-2xl font-bold text-slate-950 dark:text-white mb-2 flex items-center gap-2">
        <span className="text-primary text-[24px] material-symbols-outlined" aria-hidden="true">
          timeline
        </span>
        Certification &amp; Applied Skills Lifecycle
      </h3>
      <p className="text-sm text-foreground mb-4 max-w-2xl">
        Beta launches, GA dates, and retirement deadlines, checked against{' '}
        <a
          href="https://learn.microsoft.com/en-us/credentials/support/credential-retirement"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          Microsoft Learn
        </a>{' '}
        on {formatDate(DATA_AS_OF)}.
        {liveCount > 0 && (
          <>
            {' '}
            Plus {liveCount} from the{' '}
            <a
              href="https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Microsoft Skills Hub blog
            </a>
            , as last scraped.
          </>
        )}
      </p>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4">
        {TIMELINE_STATUS_ORDER.map((type) => {
          const meta = TIMELINE_TYPE_META[type];
          return (
            <div key={type} className="flex items-center gap-1.5">
              <span
                className={`material-symbols-outlined text-[14px] ${meta.color}`}
                aria-hidden="true"
              >
                {meta.icon}
              </span>
              <span className="text-xs text-foreground/70">{meta.label}</span>
            </div>
          );
        })}
        <div className="w-6" aria-hidden="true" />
        {Object.entries(TIMELINE_CREDENTIAL_TYPE_META).map(([credentialType, meta]) => (
          <div key={credentialType} className="flex items-center gap-1.5">
            <TimelineCredentialTypeIcon credentialType={credentialType} />
            <span className="text-xs text-foreground/70">{meta.label}</span>
          </div>
        ))}
      </div>

      {/* Scrollable timeline container */}
      <div className="relative bg-card/20 backdrop-blur-md border border-card/40 rounded-2xl overflow-hidden">
        {/* Left scroll button */}
        {canScrollLeft && (
          <button
            onClick={scrollLeft}
            className="absolute left-2 top-1/2 -translate-y-1/2 z-30 bg-primary/90 hover:bg-primary text-primary-foreground rounded-full p-2 shadow-lg transition-all duration-200 hover:scale-110"
            aria-label="Scroll left"
          >
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              chevron_left
            </span>
          </button>
        )}

        {/* Right scroll button */}
        {canScrollRight && (
          <button
            onClick={scrollRight}
            className="absolute right-2 top-1/2 -translate-y-1/2 z-30 bg-primary/90 hover:bg-primary text-primary-foreground rounded-full p-2 shadow-lg transition-all duration-200 hover:scale-110"
            aria-label="Scroll right"
          >
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              chevron_right
            </span>
          </button>
        )}

        <div
          ref={scrollContainerRef}
          className="overflow-x-auto scrollbar-thin scrollbar-thumb-card/60 scrollbar-track-transparent"
        >
          <div style={{ width: totalWidth, minWidth: '100%', position: 'relative' }}>
            {/* SVG layer for grid lines and month headers */}
            <svg
              width={totalWidth}
              height={svgHeight}
              style={{ display: 'block', userSelect: 'none' }}
            >
              {/* Month columns */}
              {months.map((m, i) => {
                const x = i * COL_WIDTH;
                const isCurrentMonth =
                  m.getUTCFullYear() === todayYear && m.getUTCMonth() + 1 === todayMonth;
                return (
                  <g key={i}>
                    {/* Alternating column shading */}
                    <rect
                      x={x}
                      y={HEADER_HEIGHT}
                      width={COL_WIDTH}
                      height={svgHeight - HEADER_HEIGHT}
                      fill={getMonthColumnFill(isCurrentMonth, i)}
                    />
                    {/* Vertical grid line */}
                    <line
                      x1={x}
                      y1={0}
                      x2={x}
                      y2={svgHeight}
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth={1}
                    />
                    {/* Month label */}
                    <text
                      x={x + COL_WIDTH / 2}
                      y={HEADER_HEIGHT / 2 + 5}
                      textAnchor="middle"
                      fill={isCurrentMonth ? 'rgba(139,92,246,0.9)' : 'rgba(255,255,255,0.45)'}
                      fontSize={11}
                      fontWeight={isCurrentMonth ? '700' : '500'}
                      fontFamily="inherit"
                    >
                      {m.toLocaleDateString('en-US', {
                        month: 'short',
                        year: '2-digit',
                        timeZone: 'UTC',
                      })}
                    </text>
                  </g>
                );
              })}

              {/* Horizontal separator below header */}
              <line
                x1={0}
                y1={HEADER_HEIGHT}
                x2={totalWidth}
                y2={HEADER_HEIGHT}
                stroke="rgba(255,255,255,0.10)"
                strokeWidth={1}
              />

              {/* Event markers */}
              {sortedEvts.map((ev, idx) => {
                const isPast = isPastDate(ev.date, today);
                const x = xForDate(ev.date);
                const lane = eventLanes[idx];
                const y = HEADER_HEIGHT + lane * TRACK_HEIGHT + TRACK_HEIGHT / 2;
                const pillW = EVENT_W;
                const pillH = 36;
                const pillX = Math.min(x - 4, totalWidth - pillW - 4);
                const pillY = y - pillH / 2;

                const colorMap = {
                  beta_launch: {
                    fill: 'rgba(245,158,11,0.18)',
                    stroke: 'rgba(245,158,11,0.50)',
                    text: 'rgba(252,211,77,1)',
                  },
                  ga_launch: {
                    fill: 'rgba(16,185,129,0.18)',
                    stroke: 'rgba(16,185,129,0.50)',
                    text: 'rgba(110,231,183,1)',
                  },
                  retirement: {
                    fill: 'rgba(244,63,94,0.18)',
                    stroke: 'rgba(244,63,94,0.50)',
                    text: 'rgba(251,113,133,1)',
                  },
                  update: {
                    fill: 'rgba(59,130,246,0.18)',
                    stroke: 'rgba(59,130,246,0.50)',
                    text: 'rgba(147,197,253,1)',
                  },
                };
                const c = colorMap[getTimelineStatusType(ev.type)] || colorMap.update;

                return (
                  <g
                    key={ev.id}
                    data-event-id={ev.id}
                    data-past={isPast ? 'true' : 'false'}
                    style={{ cursor: 'pointer', opacity: isPast ? 0.55 : 1 }}
                    onMouseEnter={() => setTooltip(ev.id)}
                    onMouseLeave={() => setTooltip(null)}
                  >
                    {/* Stem line from axis to pill */}
                    <line
                      x1={x}
                      y1={HEADER_HEIGHT}
                      x2={x}
                      y2={pillY + pillH / 2}
                      stroke={c.stroke}
                      strokeWidth={1}
                      strokeDasharray="2 2"
                    />
                    {/* Diamond marker on axis */}
                    <rect
                      x={x - 5}
                      y={HEADER_HEIGHT - 5}
                      width={10}
                      height={10}
                      rx={2}
                      fill={c.fill}
                      stroke={c.stroke}
                      strokeWidth={1.5}
                      transform={`rotate(45 ${x} ${HEADER_HEIGHT})`}
                    />
                    {/* Pill background */}
                    <rect
                      x={pillX}
                      y={pillY}
                      width={pillW}
                      height={pillH}
                      rx={8}
                      fill={c.fill}
                      stroke={tooltip === ev.id ? c.text : c.stroke}
                      strokeWidth={tooltip === ev.id ? 1.5 : 1}
                    />
                    {/* Cert code */}
                    {ev.certCode && (
                      <text
                        x={pillX + 8}
                        y={pillY + 13}
                        fill={c.text}
                        fontSize={9}
                        fontWeight="700"
                        fontFamily="monospace"
                      >
                        {ev.certCode}
                      </text>
                    )}
                    {/* Event title (truncated) */}
                    <text
                      x={pillX + 8}
                      y={pillY + 26}
                      fill="hsl(var(--foreground))"
                      fontSize={9.5}
                      fontWeight="500"
                      fontFamily="inherit"
                    >
                      {ev.title.length > 18 ? `${ev.title.slice(0, 17)}…` : ev.title}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Tooltip overlay */}
        {tooltip &&
          (() => {
            const ev = sortedEvts.find((e) => e.id === tooltip);
            if (!ev) return null;
            const meta = getTimelineStatusMeta(ev.type);
            const credentialType = getTimelineCredentialType(ev);
            const credentialMeta = TIMELINE_CREDENTIAL_TYPE_META[credentialType];
            const isPast = isPastDate(ev.date, today);
            const days = daysUntil(ev.date, today);
            return (
              <div className="absolute bottom-3 right-3 max-w-xs bg-background/95 backdrop-blur-md border border-card/60 rounded-xl px-4 py-3 shadow-2xl z-20 pointer-events-none">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span
                    className={`material-symbols-outlined text-[14px] ${meta.color}`}
                    aria-hidden="true"
                  >
                    {meta.icon}
                  </span>
                  <span className={`text-[10px] font-bold ${meta.color}`}>{meta.label}</span>
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-foreground/70">
                    <TimelineCredentialTypeIcon
                      credentialType={credentialType}
                      className="h-3.5 w-3.5"
                    />
                    {credentialMeta?.label}
                  </span>
                  {ev.certCode && (
                    <span className="font-mono text-[10px] text-foreground/50">{ev.certCode}</span>
                  )}
                  {isPast && <span className="text-[10px] text-foreground/40 italic">past</span>}
                </div>
                <div className="font-semibold text-slate-950 dark:text-white text-sm mb-0.5">
                  {ev.title}
                </div>
                <div className="text-[11px] text-foreground/70 mb-1.5">{ev.description}</div>
                <div className="text-[10px] text-foreground/50 flex items-center justify-between">
                  <span>{formatDate(ev.date)}</span>
                  {!isPast && (
                    <span className="text-primary font-semibold">
                      {days === 0 ? 'today' : `in ${days}d`}
                    </span>
                  )}
                </div>
              </div>
            );
          })()}
      </div>
    </section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AzureEducationPage() {
  const [levelFilter, setLevelFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [carouselPage, setCarouselPage] = useState(0);
  const [selectedPathId, setSelectedPathId] = useState(1);
  const [appliedSkillArea, setAppliedSkillArea] = useState('All');
  const [appliedSkillsExpanded, setAppliedSkillsExpanded] = useState(false);
  const [appliedSkillColumns, setAppliedSkillColumns] = useState(getAppliedSkillColumnCount);

  // Status is derived from the dates on every render, so a retirement or beta
  // end that passes between data syncs is reflected without a deploy. Retired
  // exams stay listed — with the retirement date and the replacement — but
  // sort last so the current catalogue comes first.
  const today = useToday(DATA_AS_OF);
  const certs = certifications
    .map((c) => ({ ...c, status: deriveStatus(c, today) }))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  const skills = appliedSkills.map((s) => ({ ...s, status: deriveStatus(s, today) }));

  const featuredCert = certs.find((c) => c.featured);

  const filteredCerts = certs.filter((c) => {
    const levelOk = levelFilter === 'All' || c.level === levelFilter;
    const statusOk =
      statusFilter === 'All' ||
      (statusFilter === 'Active' && c.status === 'active') ||
      (statusFilter === 'Beta' && c.status === 'beta') ||
      (statusFilter === 'Expiring' && c.status === 'expiring') ||
      (statusFilter === 'Retired' && c.status === 'retired');
    return levelOk && statusOk;
  });

  const totalPages = Math.ceil(filteredCerts.length / VISIBLE_COUNT);
  const visibleCerts = filteredCerts.slice(
    carouselPage * VISIBLE_COUNT,
    carouselPage * VISIBLE_COUNT + VISIBLE_COUNT
  );

  const selectedPath = learningPaths.find((p) => p.id === selectedPathId);

  const filteredSkills =
    appliedSkillArea === 'All' ? skills : skills.filter((s) => s.area === appliedSkillArea);
  const appliedSkillRetirementEvents = skills
    .filter((skill) => skill.expiryDate)
    .map((skill) => ({
      id: `applied-skill-${skill.slug}-retire`,
      date: skill.expiryDate,
      type: 'applied_skill_retirement',
      credentialType: 'applied_skill',
      certCode: skill.code,
      title: `${skill.code} Retires`,
      description: `${skill.title} retires. You will no longer be able to earn this Applied Skill after this date.`,
      sourceUrl: skill.learnUrl,
    }));
  const collapsedSkillCount = APPLIED_SKILLS_COLLAPSED_ROWS * appliedSkillColumns;
  const hasMoreAppliedSkills = filteredSkills.length > collapsedSkillCount;
  const visibleAppliedSkills = appliedSkillsExpanded
    ? filteredSkills
    : filteredSkills.slice(0, collapsedSkillCount);

  const handleLevelFilter = (l) => {
    setLevelFilter(l);
    setCarouselPage(0);
  };
  const handleStatusFilter = (s) => {
    setStatusFilter(s);
    setCarouselPage(0);
  };

  useEffect(() => {
    const updateColumns = () => setAppliedSkillColumns(getAppliedSkillColumnCount());
    updateColumns();
    window.addEventListener('resize', updateColumns);
    return () => window.removeEventListener('resize', updateColumns);
  }, []);

  // The Friday Skills Hub scraper's events (GET public/cert-events), merged
  // over the hand-maintained entries by id (#461 item 4). Fetched in an
  // effect, so the pre-render and the hydrating render carry the static
  // entries alone and agree; when the list is empty or the request fails the
  // static entries are what the page shows, exactly as before.
  const liveCertEvents = usePublicData(
    () => fetchPublicCertEvents({ platform: 'azure' }),
    'cert-events:azure'
  );
  const liveTimelineEvents = useMemo(
    () => (liveCertEvents.data || []).map(certEventToTimelineEvent).filter(Boolean),
    [liveCertEvents.data]
  );
  const sortedTimeline = mergeTimelineEvents(
    [...timelineEvents, ...appliedSkillRetirementEvents],
    liveTimelineEvents
  );

  return (
    <>
      <Helmet>
        <title>Azure Education & Certifications | HCW</title>
        <meta
          name="description"
          content={`Microsoft Azure certification prep, applied skills, beta exams, retirement timeline, and learning paths — catalogue checked against Microsoft Learn on ${DATA_AS_OF}.`}
        />
        <meta property="og:title" content="Azure Education & Certifications" />
        <meta
          property="og:description"
          content="Structured learning paths, certification prep, applied skills, and beta exam tracking for Microsoft Azure."
        />
      </Helmet>

      <main className="grow pt-28 pb-20 px-4 md:px-8 max-w-360 mx-auto w-full">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className="mb-12 relative">
          <div className="absolute -top-10 -left-10 w-96 h-96 bg-primary/5 blur-3xl rounded-full pointer-events-none" />
          <h1 className="text-3xl sm:text-5xl md:text-6xl font-bold mb-4 relative z-10">
            <span className="bg-clip-text text-transparent bg-linear-to-r from-azure-primary via-slate-900 to-azure-primary dark:via-white">
              Azure Education &amp; Certifications
            </span>
          </h1>
          <p className="text-base sm:text-lg text-foreground max-w-3xl relative z-10">
            Master Azure with structured learning paths, official certifications, and applied
            skills. Beta, retirement and replacement dates come from Microsoft Learn; this catalogue
            was last checked on{' '}
            <time dateTime={DATA_AS_OF} data-testid="data-as-of">
              {formatDate(DATA_AS_OF)}
            </time>
            .
          </p>
        </section>

        {/* ── Posters Banner ───────────────────────────────────────────── */}
        <section className="mb-12">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <a
              href="https://aka.ms/CertificationsPoster"
              target="_blank"
              rel="noopener noreferrer"
              className="group relative bg-linear-to-br from-blue-900/40 to-card/40 backdrop-blur-md border border-blue-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(0,120,212,0.2)] hover:border-primary/60 transition-all duration-300 flex items-start gap-5"
            >
              <div className="w-14 h-14 shrink-0 bg-primary/20 rounded-xl flex items-center justify-center">
                <span
                  className="text-primary text-[28px] material-symbols-outlined"
                  aria-hidden="true"
                >
                  workspace_premium
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h2 className="text-lg font-bold text-slate-950 dark:text-white group-hover:text-primary transition-colors">
                    Microsoft Certifications Poster
                  </h2>
                  <span className="px-2 py-0.5 bg-primary/20 border border-primary/30 text-primary text-[10px] font-bold rounded-full uppercase tracking-wider shrink-0">
                    Official
                  </span>
                </div>
                <p className="text-sm text-foreground mb-3">
                  The official Microsoft Certifications roadmap — all role-based and specialty
                  certifications in one poster, published by Microsoft.
                </p>
                <div className="flex items-center gap-1.5 text-primary text-sm font-semibold">
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    open_in_new
                  </span>
                  aka.ms/CertificationsPoster
                </div>
              </div>
            </a>

            <a
              href="https://go.microsoft.com/fwlink/?linkid=2321752"
              target="_blank"
              rel="noopener noreferrer"
              className="group relative bg-linear-to-br from-cyan-900/40 to-card/40 backdrop-blur-md border border-cyan-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(0,188,212,0.2)] hover:border-cyan-400/60 transition-all duration-300 flex items-start gap-5"
            >
              <div className="w-14 h-14 shrink-0 bg-cyan-500/20 rounded-xl flex items-center justify-center">
                <span
                  className="text-cyan-400 text-[28px] material-symbols-outlined"
                  aria-hidden="true"
                >
                  construction
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h2 className="text-lg font-bold text-slate-950 dark:text-white group-hover:text-cyan-300 transition-colors">
                    Applied Skills Poster
                  </h2>
                  <span className="px-2 py-0.5 bg-cyan-500/20 border border-cyan-500/30 text-cyan-300 text-[10px] font-bold rounded-full uppercase tracking-wider shrink-0">
                    Scenario-Based
                  </span>
                </div>
                <p className="text-sm text-foreground mb-3">
                  Microsoft Applied Skills are scenario-based assessments that validate hands-on
                  ability with specific Azure tasks. Complements certifications with practical
                  proof.
                </p>
                <div className="flex items-center gap-1.5 text-cyan-400 text-sm font-semibold">
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                    open_in_new
                  </span>
                  View Applied Skills Poster
                </div>
              </div>
            </a>
          </div>
        </section>

        {/* ── Browse Certifications Carousel ───────────────────────────── */}
        <section className="mb-16">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <h3 className="text-2xl font-bold text-slate-950 dark:text-white flex items-center gap-2">
              <span
                className="text-primary text-[24px] material-symbols-outlined"
                aria-hidden="true"
              >
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

        {/* ── Featured Cert + Sidebar ──────────────────────────────────── */}
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
                      <div className="text-4xl font-bold text-primary mb-2">
                        {featuredCert.hours}
                      </div>
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
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${LEVEL_META[cert.level].dot}`}
                    />
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

        {/* ── Cert Lifecycle Timeline (horizontal Gantt) ───────────────── */}
        <HorizontalTimeline events={sortedTimeline} />

        {/* ── Learning Paths ───────────────────────────────────────────── */}
        <section className="mb-16">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <h3 className="text-2xl font-bold text-slate-950 dark:text-white flex items-center gap-2">
              <span
                className="text-primary text-[24px] material-symbols-outlined"
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

        {/* ── Applied Skills Reference Library ─────────────────────────── */}
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

        {/* ── Learning Resources ───────────────────────────────────────── */}
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

        <ProviderLabsSection provider="azure" className="mt-16" />
      </main>
    </>
  );
}

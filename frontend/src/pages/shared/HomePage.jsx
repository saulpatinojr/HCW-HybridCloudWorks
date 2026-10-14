import React, { useState, useEffect, useMemo } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router';
import { routes } from '@/lib/routeFactory';
import { getFunctionsBase } from '@/lib/functionsBase';
import { fetchPublicContentPage } from '@/lib/publicApi';
import { usePublicData } from '@/hooks/usePublicData';
import { feedCountLabel } from '@/data/providerFeeds';
import Eyebrow from '@/components/shared/Eyebrow';
import NumberedSection from '@/components/shared/NumberedSection';
import StatBlock from '@/components/shared/StatBlock';
import ProviderLogo from '@/components/shared/ProviderLogo';
import ProviderStrip from '@/components/home/ProviderStrip';
import WorkbenchShowcase from '@/components/home/WorkbenchShowcase';
import LatestArticles from '@/components/home/LatestArticles';
import {
  BLUEPRINT_COUNT,
  LATEST_LIMIT,
  blueprintCards,
  toLatestItems,
} from '@/components/home/homeContent';

/*
 * The design carousel: every reference blueprint the architecture pages show,
 * from homeContent.js. It was ten hand-typed cards, seven of which opened
 * "Architecture Not Found", each stamped "Snapshot v2.0".
 */
const BLUEPRINT_CARDS = blueprintCards();

/** A card's tint. Whole strings, as everywhere else Tailwind or a style reads a colour. */
const CARD_TINTS = {
  aws: 'hsl(var(--aws-orange) / 0.12)',
  azure: 'hsl(var(--azure-blue) / 0.12)',
  gcp: 'hsl(var(--gcp-red) / 0.12)',
  finops: 'hsl(var(--finops-green) / 0.12)',
  vmware: 'hsl(var(--vmware-blue) / 0.12)',
};
const NEUTRAL_TINT = 'hsl(var(--muted) / 0.6)';

/*
 * "Quick Access Hubs": each provider's news page, as data. They were eight
 * copies of one <Link> block until Docker's made it nine (#777; Qlty's
 * similar-code finding on #804), so the block is written once below and each
 * hub carries only what differs. Every class is a whole literal string here,
 * never assembled from a provider name, because Tailwind generates only the
 * classes it finds written out in the source. The hubs keep the classes they
 * had: Azure and AWS hover to neutral text, the rest to their brand colour,
 * and GCP's note alone picks up its colour on hover.
 *
 * A hub's note is how many feeds its news page reads, from
 * `data/providerFeeds.js`, which a test holds to the server's own list. The
 * notes used to be typed here ("24 FEEDS" for Azure's seven, "32" for AWS's
 * three) and three hubs said "NEW HUB" instead of a number.
 */
const HUB_LINK =
  'hub-icon-btn glass-panel rounded-lg p-3 flex items-center gap-3 group border-l-4 border-l-transparent';
const HUB_ICON = 'p-2 rounded bg-white/70 dark:bg-slate-800/50 text-slate-700 transition-colors';
const HUB_LABEL = 'text-sm font-bold text-slate-900 dark:text-(--popover-foreground)';
const HUB_NOTE = 'text-[10px] text-slate-600 dark:text-white font-mono';
const NEUTRAL_ICON =
  'dark:text-white group-hover:text-slate-900 dark:group-hover:text-(--popover-foreground)';
const NEUTRAL_LABEL = 'group-hover:text-slate-900 dark:group-hover:text-white';

export const QUICK_ACCESS_HUBS = Object.freeze([
  {
    provider: 'azure',
    label: 'Azure',
    tag: 'Cloud',
    icon: 'cloud_done',
    glow: 'rgba(0, 120, 212, 0.4)',
    hoverBorder: 'hover:border-l-azure',
    iconTone: NEUTRAL_ICON,
    labelHover: NEUTRAL_LABEL,
  },
  {
    provider: 'aws',
    label: 'AWS',
    tag: 'Cloud',
    icon: 'rocket_launch',
    glow: 'rgba(255, 153, 0, 0.4)',
    hoverBorder: 'hover:border-l-aws',
    iconTone: NEUTRAL_ICON,
    labelHover: NEUTRAL_LABEL,
  },
  {
    provider: 'gcp',
    label: 'Google Cloud (GCP)',
    tag: 'Cloud',
    icon: 'query_stats',
    glow: 'rgba(219, 68, 55, 0.4)',
    hoverBorder: 'hover:border-l-gcp',
    iconTone: 'dark:text-white group-hover:text-gcp',
    labelHover: 'group-hover:text-gcp',
    noteHover: 'group-hover:text-gcp/80 transition-colors',
  },
  {
    provider: 'terraform',
    label: 'Terraform',
    tag: 'Platform',
    icon: 'layers',
    glow: 'rgba(123, 66, 188, 0.4)',
    hoverBorder: 'hover:border-l-terraform',
    iconTone: 'dark:text-white group-hover:text-terraform',
    labelHover: 'group-hover:text-terraform',
  },
  {
    provider: 'github',
    label: 'GitHub',
    tag: 'Service',
    icon: 'terminal',
    glow: 'rgba(110, 118, 129, 0.4)',
    hoverBorder: 'hover:border-l-github',
    iconTone: 'dark:text-muted-foreground group-hover:text-github',
    labelHover: 'group-hover:text-github',
  },
  {
    provider: 'finops',
    label: 'FinOps',
    tag: 'Service',
    icon: 'payments',
    glow: 'rgba(30, 164, 130, 0.4)',
    hoverBorder: 'hover:border-l-finops',
    iconTone: 'dark:text-muted-foreground group-hover:text-finops',
    labelHover: 'group-hover:text-finops',
  },
  {
    provider: 'vmware',
    label: 'VMware',
    tag: 'Cloud',
    icon: 'dns',
    glow: 'rgba(0, 145, 218, 0.4)',
    hoverBorder: 'hover:border-l-vmware',
    iconTone: 'dark:text-muted-foreground group-hover:text-vmware',
    labelHover: 'group-hover:text-vmware',
  },
  {
    provider: 'ansible',
    label: 'Ansible',
    tag: 'Platform',
    icon: 'terminal',
    glow: 'rgba(238, 0, 0, 0.35)',
    hoverBorder: 'hover:border-l-ansible',
    iconTone: 'dark:text-muted-foreground group-hover:text-ansible',
    labelHover: 'group-hover:text-ansible',
  },
  // #777: Docker's news page reads Docker's blog feed.
  {
    provider: 'docker',
    label: 'Docker',
    tag: 'Platform',
    icon: 'deployed_code',
    glow: 'rgba(29, 99, 237, 0.4)',
    hoverBorder: 'hover:border-l-docker',
    iconTone: 'dark:text-muted-foreground group-hover:text-docker',
    labelHover: 'group-hover:text-docker',
  },
]);

/*
 * Platform Health: one row per status the server checks
 * (functions/src/lib/platform-health.js), each linking to the page where that
 * provider publishes the same status. The links used to open an unofficial
 * AWS feed and Azure's products-by-region table, and the last row said
 * "GitHub Actions" over GitHub's overall status indicator.
 */
export const STATUS_SOURCES = Object.freeze([
  {
    key: 'aws',
    label: 'Amazon Web Services',
    href: 'https://health.aws.amazon.com/health/status',
  },
  { key: 'azure', label: 'Microsoft Azure', href: 'https://azure.status.microsoft/en-us/status' },
  { key: 'gcp', label: 'Google Cloud', href: 'https://status.cloud.google.com/' },
  { key: 'github', label: 'GitHub', href: 'https://www.githubstatus.com/' },
]);

const statusesAll = (status) =>
  Object.fromEntries(STATUS_SOURCES.map((source) => [source.key, status]));

/** The small timestamp under "Platform Health". A token, so it holds contrast in both themes. */
export const HEALTH_TIMESTAMP_CLASS = 'text-[8px] text-muted-foreground font-mono mt-0.5';

/*
 * Light-mode badge text is the -800 shade, the same pairing the site's other
 * status badges use (CertStatusBadge, ProviderBlogPage). The -600 shades read
 * 3.41:1 (OPERATIONAL) and 3.03:1 (REGIONAL IMPACT) on their tints under axe
 * on 2026-09-29, once the panel showed real statuses instead of UNKNOWN.
 */
export const getHealthBadgeClass = (status) => {
  if (status === 'DEGRADED' || status === 'REGIONAL IMPACT') {
    return 'text-amber-800 dark:text-amber-400 bg-amber-100/50 dark:bg-amber-900/20';
  }
  if (status === 'OPERATIONAL') {
    return 'text-emerald-800 dark:text-emerald-400 bg-emerald-100/50 dark:bg-emerald-900/20';
  }
  return 'text-slate-600 dark:text-slate-300 bg-slate-100/70 dark:bg-slate-800/70';
};

const getOverallHealth = (statuses) => {
  const values = Object.values(statuses);
  if (values.includes('DEGRADED') || values.includes('REGIONAL IMPACT')) return 'DEGRADED';
  if (values.every((status) => status === 'OPERATIONAL')) return 'OPERATIONAL';
  if (values.includes('CHECKING')) return 'CHECKING';
  return 'UNKNOWN';
};

const getOverallHealthIconClass = (status) => {
  if (status === 'DEGRADED') return 'text-amber-500';
  if (status === 'OPERATIONAL') return 'text-emerald-500';
  return 'text-slate-500';
};

const getOverallHealthIcon = (status) => {
  if (status === 'DEGRADED') return 'warning';
  if (status === 'OPERATIONAL') return 'check_circle';
  if (status === 'UNKNOWN') return 'help';
  return 'sync';
};

// Don't call a deployed backend from a developer's machine — the health widget
// is decorative, and a cross-origin call from localhost fails on CORS anyway.
// This used to test the base for 'cloudfunctions.net'; that literal became
// unreachable when the GCP base URL was retired (T-101), so the check
// is now expressed against origin rather than against one specific host.
const shouldFetchPlatformHealth = (functionsBase) => {
  if (!functionsBase) return false;
  if (typeof window === 'undefined') return true;

  const isLocalOrigin = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (!isLocalOrigin) return true;

  // A relative base ('/api') is served by whatever is answering locally.
  if (!/^https?:\/\//i.test(functionsBase)) return true;
  return new URL(functionsBase).origin === window.location.origin;
};

/** The clock time a status was checked, from the server's `checkedAt` when it sent one. */
const checkedAtLabel = (checkedAt) => {
  const ms = Date.parse(checkedAt);
  const at = Number.isFinite(ms) ? new Date(ms) : new Date();
  return `Checked at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

/** How many blueprint cards the carousel shows at once. */
const CAROUSEL_WINDOW = 4;

export default function HomePage() {
  const [startIndex, setStartIndex] = useState(0);
  const [healthStatuses, setHealthStatuses] = useState(() => statusesAll('CHECKING'));
  const [lastVerified, setLastVerified] = useState('Syncing...');

  // The latest published articles, and the article count in the hero, from
  // one request (homeContent.js says where every number here comes from).
  const {
    data: latestPage,
    loading: latestLoading,
    error: latestError,
  } = usePublicData(() => fetchPublicContentPage({ limit: LATEST_LIMIT }), 'home:latest');
  const latestItems = useMemo(() => toLatestItems(latestPage?.items), [latestPage]);
  const articleTotal = Number.isInteger(latestPage?.total) ? latestPage.total : null;

  useEffect(() => {
    if (BLUEPRINT_CARDS.length <= CAROUSEL_WINDOW) return undefined;
    const timer = setInterval(() => {
      setStartIndex((prev) => (prev + 1) % BLUEPRINT_CARDS.length);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const fetchHealth = async () => {
      const functionsBase = getFunctionsBase();
      // Nothing was checked, so nothing may still say CHECKING.
      const unavailable = () => {
        setHealthStatuses(statusesAll('UNKNOWN'));
        setLastVerified('Health check unavailable');
      };

      if (!shouldFetchPlatformHealth(functionsBase)) {
        unavailable();
        return;
      }

      try {
        const res = await fetch(`${functionsBase}/public/platform-health`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data?.ok || !data.statuses) throw new Error('Invalid health response');

        setHealthStatuses(
          Object.fromEntries(
            STATUS_SOURCES.map(({ key }) => [key, data.statuses[key] || 'UNKNOWN'])
          )
        );
        // The server caches its checks for minutes, so the time it checked is
        // the true one; the time this page asked is not.
        setLastVerified(checkedAtLabel(data.checkedAt));
      } catch {
        unavailable();
      }
    };

    fetchHealth();
    const interval = setInterval(fetchHealth, 3600000); // Check every hour
    return () => clearInterval(interval);
  }, []);

  const visibleDesigns = Array.from(
    { length: Math.min(CAROUSEL_WINDOW, BLUEPRINT_CARDS.length) },
    (_, offset) => BLUEPRINT_CARDS[(startIndex + offset) % BLUEPRINT_CARDS.length]
  );
  const overallHealth = getOverallHealth(healthStatuses);
  // Shown while the count loads, and dropped if it cannot be had: a tile
  // without a number is better than a number nobody measured.
  const showArticleTile = articleTotal !== null || (latestLoading && !latestError);
  return (
    <main className="relative z-10 max-w-[1400px] mx-auto w-full px-4 md:px-8 py-8 flex flex-col gap-16 bg-background text-foreground">
      <Helmet>
        <title>HybridCloudWorks | Multi-Cloud Architecture Command Center</title>
      </Helmet>

      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute inset-x-0 top-0 h-[60vh] ambient-glow"></div>
        <div className="absolute -top-40 left-1/2 h-130 w-130 -translate-x-1/2 rounded-full bg-[radial-gradient(circle_at_center,rgba(214,178,120,0.1),transparent_65%)] blur-2xl"></div>
        <div className="absolute top-40 -right-24 h-90 w-90 rounded-full bg-[radial-gradient(circle_at_center,rgba(194,180,144,0.12),transparent_70%)] blur-2xl"></div>
        <div className="absolute bottom-0 left-10 h-70 w-70 rounded-full bg-[radial-gradient(circle_at_center,rgba(130,113,110,0.1),transparent_70%)] blur-2xl"></div>
      </div>

      {/* Hero Section */}
      <section className="relative w-full grid lg:grid-cols-2 gap-10 items-center pt-6">
        <div className="flex flex-col gap-6">
          <Eyebrow>Build. Document. Operationalize.</Eyebrow>
          <h1 className="display-heading text-4xl sm:text-5xl lg:text-6xl text-slate-900 dark:text-white max-w-2xl">
            Multi-cloud architecture,
            <br />
            <span className="display-accent">engineered to ship.</span>
          </h1>
          <p className="text-base sm:text-lg text-slate-700 dark:text-(--subtitle-gray) max-w-xl leading-relaxed">
            HybridCloudWorks is a centralized platform for designing, documenting, and
            operationalizing multi-cloud architectures, frameworks, and implementation patterns
            across AWS, Azure, GCP, and FinOps — curated reference designs, deployment blueprints,
            compliance checklists, and automation tools for cloud architects and engineers.
          </p>
          <div className="flex flex-wrap gap-4 mt-2">
            <a
              href="#hubs"
              className="inline-flex items-center gap-2 rounded-full bg-primary text-primary-foreground px-7 py-3 text-[11px] uppercase tracking-[0.24em] font-semibold font-sans transition-opacity hover:opacity-90"
            >
              Browse All Hubs
              <span className="material-symbols-outlined text-sm">arrow_forward</span>
            </a>
          </div>

          {/*
            Glassy stat blocks (Hyoga "Global Reach 35+" style). Counted, not
            typed: homeContent.js says where each comes from, and why the
            modules and uptime tiles that stood here are gone.
          */}
          <div className="grid grid-cols-2 gap-3 mt-4 max-w-md" data-testid="home-stats">
            <StatBlock value={BLUEPRINT_COUNT} label="Blueprints" />
            {showArticleTile && <StatBlock value={articleTotal ?? '…'} label="Articles" />}
          </div>

          {/* Audit P0-5: Capability Badges merchandising technical differentiators */}
          <div
            data-testid="capability-badges"
            className="flex flex-wrap items-center gap-2 mt-3.5 max-w-xl"
          >
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono tracking-tight bg-slate-900/60 dark:bg-slate-800/80 text-cyan-400 dark:text-cyan-300 border border-cyan-500/30">
              <span
                className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse"
                aria-hidden="true"
              />
              Terraform AVM Generator
            </span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono tracking-tight bg-slate-900/60 dark:bg-slate-800/80 text-emerald-400 dark:text-emerald-300 border border-emerald-500/30">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
              Ephemeral Container Labs
            </span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono tracking-tight bg-slate-900/60 dark:bg-slate-800/80 text-purple-400 dark:text-purple-300 border border-purple-500/30">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-400" aria-hidden="true" />
              FOCUS 1.4 FinOps
            </span>
          </div>
        </div>
        <div className="relative h-100 lg:h-130 w-full flex items-center justify-center hero-mesh rounded-2xl border border-glass-border overflow-hidden group">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(172,183,174,0.2),transparent_55%),radial-gradient(circle_at_80%_80%,rgba(194,180,144,0.14),transparent_50%)] opacity-90"></div>
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundImage:
                'linear-gradient(45deg, rgba(255,255,255,0.02) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.02) 50%, rgba(255,255,255,0.02) 75%, transparent 75%, transparent)',
              backgroundSize: '20px 20px',
              opacity: 0.28,
            }}
          ></div>
          <div className="relative z-10 w-64 h-64 md:w-80 md:h-80 flex items-center justify-center">
            <div className="w-full h-full bg-slate-800 rounded-xl flex items-center justify-center">
              <img
                src="/icons/hcw-logo.png"
                alt="HybridCloudWorks logo"
                width="320"
                height="320"
                fetchPriority="high"
                decoding="async"
                className="w-full h-full object-contain"
              />
            </div>
            <div className="absolute -top-5 -right-5 w-24 h-24 border border-slate-500/30 rounded-lg transform -rotate-12 bg-slate-700/60 backdrop-blur-md flex items-center justify-center animate-[bounce_5s_infinite]">
              <span className="material-symbols-outlined text-4xl text-(--popover-foreground)">
                cloud
              </span>
            </div>
            <div
              className="absolute -left-2.5 w-32 h-16 border border-slate-500/30 rounded-lg bg-slate-700/60 backdrop-blur-md flex items-center justify-center gap-2"
              style={{ bottom: '-35px', transform: 'rotate(7deg)' }}
            >
              <div className="w-2 h-2 rounded-full bg-muted"></div>
              <span className="text-xs font-mono text-(--popover-foreground)">Online</span>
            </div>
            <div className="absolute -top-5 -left-5 w-20 h-20 border border-slate-500/30 rounded-lg transform rotate-0 bg-slate-700/60 backdrop-blur-md flex items-center justify-center">
              <span className="material-symbols-outlined text-3xl text-(--popover-foreground)">
                shield
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Flagship Interactive Workbench Showcase (Audit P1-2) */}
      <WorkbenchShowcase />

      {/* Provider strip: two rows of hubs, and a frame that says what each one is */}
      <ProviderStrip />

      {/* Value Pillars */}
      <NumberedSection number={1} eyebrow="Capabilities" title="Build. Learn. Scale.">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Build and Test */}
          <div className="glass-panel group rounded-xl p-6 border border-secondary/40 hover:border-accent/80 transition-colors relative min-h-65 overflow-hidden hover:shadow-xl hover:shadow-black/5 dark:hover:shadow-black/20 flex flex-col">
            <div className="h-11 w-11 rounded-lg bg-white/70 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 flex items-center justify-center mb-4 transition-transform group-hover:scale-95 group-hover:opacity-0 delay-75 duration-300">
              <span className="material-symbols-outlined text-slate-700 dark:text-(--popover-foreground)">
                build
              </span>
            </div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2 font-display transition-opacity group-hover:opacity-0 delay-75 duration-300">
              Build and Test
            </h3>
            <p className="text-sm text-slate-700 dark:text-(--subtitle-gray) leading-relaxed transition-opacity group-hover:opacity-0 delay-75 duration-300">
              Explore battle-tested architecture designs and comprehensive blueprints for enterprise
              cloud deployments.
            </p>

            {/* Floating Blurry Pane */}
            <div className="absolute inset-0 bg-white/85 dark:bg-slate-900/90 backdrop-blur-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-300 z-20 flex flex-col p-6 rounded-xl border border-glass-border">
              <h4 className="text-xs uppercase tracking-widest text-slate-500 dark:text-slate-400 font-bold mb-3">
                Architectures
              </h4>
              <div className="flex flex-col gap-2.5 flex-1 justify-center">
                <Link
                  to={routes.architectureDesigns('azure')}
                  className="flex items-center gap-3 group/link hover:pl-2 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-azure shadow-[0_0_6px_hsl(var(--azure-blue))]"></span>
                  <span className="font-aptos font-semibold text-lg tracking-tight text-azure">
                    Azure Architectures
                  </span>
                </Link>
                <Link
                  to={routes.architectureDesigns('aws')}
                  className="flex items-center gap-3 group/link hover:pl-2 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-aws shadow-[0_0_6px_hsl(var(--aws-orange))]"></span>
                  <span className="font-ember font-semibold text-lg tracking-tight text-aws">
                    AWS Architectures
                  </span>
                </Link>
                <Link
                  to={routes.architectureDesigns('gcp')}
                  className="flex items-center gap-3 group/link hover:pl-2 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-[hsl(var(--gcp-red) / 1)] shadow-[0_0_6px_hsl(var(--gcp-red))]"></span>
                  <span className="font-googlesans font-semibold text-lg tracking-tight text-[hsl(var(--gcp-red))]">
                    Google Cloud (GCP) Architectures
                  </span>
                </Link>
                <Link
                  to={routes.architectureDesigns('finops')}
                  className="flex items-center gap-3 group/link hover:pl-2 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-finops shadow-[0_0_6px_hsl(var(--finops-green))]"></span>
                  <span className="font-display font-semibold text-lg tracking-tight text-finops">
                    FinOps Architectures
                  </span>
                </Link>
              </div>
            </div>
          </div>

          {/* Learn and Compare */}
          <div className="glass-panel group rounded-xl p-6 border border-secondary/40 hover:border-accent/80 transition-colors relative min-h-65 overflow-hidden hover:shadow-xl hover:shadow-black/5 dark:hover:shadow-black/20 flex flex-col">
            <div className="h-11 w-11 rounded-lg bg-white/70 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 flex items-center justify-center mb-4 transition-transform group-hover:scale-95 group-hover:opacity-0 delay-75 duration-300">
              <span className="material-symbols-outlined text-slate-700 dark:text-(--popover-foreground)">
                school
              </span>
            </div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2 font-display transition-opacity group-hover:opacity-0 delay-75 duration-300">
              Learnings and Certifications
            </h3>
            <p className="text-sm text-slate-700 dark:text-(--subtitle-gray) leading-relaxed transition-opacity group-hover:opacity-0 delay-75 duration-300">
              Study guides and certification paths to master cloud technologies.
            </p>

            {/* Floating Blurry Pane */}
            <div className="absolute inset-0 bg-white/85 dark:bg-slate-900/90 backdrop-blur-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-300 z-20 flex flex-col p-6 rounded-xl border border-glass-border">
              <h4 className="text-xs uppercase tracking-widest text-slate-500 dark:text-slate-400 font-bold mb-2">
                Learning Hubs
              </h4>
              <div className="flex flex-col gap-2 flex-1 justify-center overflow-y-auto pr-1">
                <Link
                  to={routes.education('azure')}
                  className="flex items-center gap-3 group/link hover:pl-2 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-azure shadow-[0_0_6px_hsl(var(--azure-blue))]"></span>
                  <span className="font-aptos font-semibold text-base tracking-tight text-azure">
                    Azure Learning
                  </span>
                </Link>
                <Link
                  to={routes.education('aws')}
                  className="flex items-center gap-3 group/link hover:pl-2 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-aws shadow-[0_0_6px_hsl(var(--aws-orange))]"></span>
                  <span className="font-ember font-semibold text-base tracking-tight text-aws">
                    AWS Learning
                  </span>
                </Link>
                <Link
                  to={routes.education('gcp')}
                  className="flex items-center gap-3 group/link hover:pl-2 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-[hsl(var(--gcp-red) / 1)] shadow-[0_0_6px_hsl(var(--gcp-red))]"></span>
                  <span className="font-googlesans font-semibold text-base tracking-tight text-[hsl(var(--gcp-red))]">
                    Google Cloud (GCP) Learning
                  </span>
                </Link>
                <Link
                  to={routes.education('terraform')}
                  className="flex items-center gap-3 group/link hover:pl-2 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-terraform shadow-[0_0_6px_hsl(var(--terraform-purple))]"></span>
                  <span className="font-terraform font-semibold text-base tracking-tight text-terraform">
                    Terraform Learning
                  </span>
                </Link>
                <Link
                  to={routes.education('github')}
                  className="flex items-center gap-3 group/link hover:pl-2 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-github dark:bg-slate-200"></span>
                  <span className="font-monasans font-semibold text-base tracking-tight text-github dark:text-slate-200">
                    GitHub Learning
                  </span>
                </Link>
                <Link
                  to={routes.education('vmware')}
                  className="flex items-center gap-3 group/link hover:pl-2 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-vmware shadow-[0_0_6px_hsl(var(--vmware-blue))]"></span>
                  <span className="font-sans font-semibold text-base tracking-tight text-vmware">
                    VMware Learning
                  </span>
                </Link>
                <Link
                  to={routes.education('finops')}
                  className="flex items-center gap-3 group/link hover:pl-2 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-finops shadow-[0_0_6px_hsl(var(--finops-green))]"></span>
                  <span className="font-display font-semibold text-base tracking-tight text-finops">
                    FinOps (FOCUS 1.4) Learning
                  </span>
                </Link>
              </div>
            </div>
          </div>

          {/* Share and Scale */}
          <div className="glass-panel group rounded-xl p-6 border border-secondary/40 hover:border-accent/80 transition-colors relative min-h-65 overflow-hidden hover:shadow-xl hover:shadow-black/5 dark:hover:shadow-black/20 flex flex-col">
            <div className="h-11 w-11 rounded-lg bg-white/70 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-700 flex items-center justify-center mb-4 transition-transform group-hover:scale-95 group-hover:opacity-0 delay-75 duration-300">
              <span className="material-symbols-outlined text-slate-700 dark:text-(--popover-foreground)">
                share
              </span>
            </div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2 font-display transition-opacity group-hover:opacity-0 delay-75 duration-300">
              Frameworks and Practices
            </h3>
            <p className="text-sm text-slate-700 dark:text-(--subtitle-gray) leading-relaxed transition-opacity group-hover:opacity-0 delay-75 duration-300">
              Accelerate development with standardized frameworks and automated DevOps workflows
              tailored for scale.
            </p>

            {/* Floating Blurry Pane */}
            <div className="absolute inset-0 bg-white/85 dark:bg-slate-900/90 backdrop-blur-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-300 z-20 flex flex-col p-6 rounded-xl border border-glass-border">
              <h4 className="text-xs uppercase tracking-widest text-slate-500 dark:text-slate-400 font-bold mb-3">
                Frameworks, Modules and Workflows
              </h4>
              <div className="flex flex-col gap-3 flex-1 justify-center">
                <Link
                  to={routes.frameworks('azure')}
                  className="flex items-center gap-3 group/link hover:pl-1 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-azure shadow-[0_0_6px_hsl(var(--azure-blue))]"></span>
                  <span className="font-aptos font-semibold text-lg tracking-tight text-azure">
                    Azure Frameworks
                  </span>
                </Link>
                <Link
                  to={routes.frameworks('aws')}
                  className="flex items-center gap-3 group/link hover:pl-1 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-aws shadow-[0_0_6px_hsl(var(--aws-orange))]"></span>
                  <span className="font-ember font-semibold text-lg tracking-tight text-aws">
                    AWS Frameworks
                  </span>
                </Link>
                <Link
                  to={routes.frameworks('gcp')}
                  className="flex items-center gap-3 group/link hover:pl-1 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-[hsl(var(--gcp-red) / 1)] shadow-[0_0_6px_hsl(var(--gcp-red))]"></span>
                  <span className="font-googlesans font-semibold text-lg tracking-tight text-[hsl(var(--gcp-red))]">
                    Google Cloud (GCP) Frameworks
                  </span>
                </Link>
                <Link
                  to={routes.frameworks('finops')}
                  className="flex items-center gap-3 group/link hover:pl-1 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-finops shadow-[0_0_6px_hsl(var(--finops-green))]"></span>
                  <span className="font-display font-semibold text-lg tracking-tight text-finops">
                    FinOps Frameworks
                  </span>
                </Link>
                <Link
                  to={routes.modules('terraform')}
                  className="flex items-center gap-3 group/link hover:pl-1 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-terraform shadow-[0_0_6px_hsl(var(--terraform-purple))]"></span>
                  <span className="font-terraform font-semibold text-lg tracking-tight text-terraform">
                    Terraform Modules
                  </span>
                </Link>
                <Link
                  to={routes.workflows('github')}
                  className="flex items-center gap-3 group/link hover:pl-1 transition-all"
                >
                  <span className="w-2 h-2 rounded-full bg-github dark:bg-slate-200"></span>
                  <span className="font-monasans font-semibold text-lg tracking-tight text-github dark:text-slate-200">
                    GitHub Workflows
                  </span>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </NumberedSection>

      {/* Reference blueprints: every one the architecture pages show, four at a time */}
      <NumberedSection
        number={2}
        eyebrow="Reference Blueprints"
        title="Architecture Designs by Provider"
        className="glass-panel rounded-2xl p-6 md:p-8 overflow-hidden"
      >
        <div className="relative">
          <div
            className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4"
            data-testid="blueprint-carousel"
          >
            {visibleDesigns.map((design) => (
              <Link
                key={design.key}
                to={design.to}
                className="group rounded-xl border border-slate-700/40 overflow-hidden bg-slate-900/40 flex flex-col h-50 cursor-pointer transition-transform duration-300 hover:-translate-y-1"
              >
                {/* Top half: the blueprint's icon on its provider's tint */}
                <div className="flex-1 bg-slate-800/50 flex items-center justify-center relative overflow-hidden">
                  <div
                    className="absolute inset-0 opacity-20"
                    style={{
                      backgroundImage: `radial-gradient(circle at center, ${CARD_TINTS[design.provider] || NEUTRAL_TINT} 0%, transparent 70%)`,
                    }}
                  ></div>
                  <span
                    className="material-symbols-outlined text-4xl dark:text-white/30 text-slate-400 z-10"
                    aria-hidden="true"
                  >
                    {design.icon}
                  </span>
                </div>

                {/* Bottom Half: Ultra-Light Provider Shaded Color */}
                <div
                  className="p-4 pt-3 pb-1 h-22.5 flex flex-col relative"
                  style={{ backgroundColor: CARD_TINTS[design.provider] || NEUTRAL_TINT }}
                >
                  <h3 className="text-sm font-extrabold text-slate-900 dark:text-white leading-tight line-clamp-2">
                    {design.title}
                  </h3>
                  <div className="absolute bottom-0 left-2 h-6 w-6 flex items-center">
                    {design.provider === 'github' ? (
                      <ProviderLogo
                        provider="github"
                        alt="GitHub logo"
                        loading="lazy"
                        decoding="async"
                        className="h-4 w-auto object-contain"
                      />
                    ) : (
                      <ProviderLogo
                        provider={design.provider}
                        alt={`${design.provider} logo`}
                        loading="lazy"
                        decoding="async"
                        className={`${design.provider === 'finops' || design.provider === 'vmware' ? 'h-6' : 'h-4'} w-auto object-contain`}
                        onError={(e) => {
                          e.target.style.display = 'none';
                        }}
                      />
                    )}
                  </div>
                  <p className="text-[9px] uppercase font-black text-slate-800 dark:text-slate-300 tracking-wider absolute bottom-0 right-3">
                    {design.category}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </NumberedSection>

      {/* Content Grid: Audit P1-3 Editorial Deep-Dives vs. Multi-Cloud Release Wire Split */}
      <NumberedSection
        number={3}
        eyebrow="Editorial & Live Signal"
        title="Engineering Deep-Dives & Release Wire"
        id="hubs"
      >
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-full">
          {/* Latest published original engineering articles (components/home/LatestArticles.jsx) */}
          <div className="lg:col-span-8">
            <LatestArticles items={latestItems} loading={latestLoading} error={latestError} />
          </div>

          {/* Sidebar */}
          <aside className="lg:col-span-4 flex flex-col gap-6">
            <div className="glass-panel rounded-lg p-4 flex flex-col gap-4">
              <div className="flex items-center justify-between border-b border-slate-300/70 dark:border-slate-700/50 pb-2">
                <div className="flex flex-col">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-400">
                    Platform Health
                  </h3>
                  <span className={HEALTH_TIMESTAMP_CLASS} data-testid="health-checked-at">
                    {lastVerified}
                  </span>
                </div>
                <span
                  className={`material-symbols-outlined text-sm animate-pulse ${getOverallHealthIconClass(overallHealth)}`}
                  aria-hidden="true"
                >
                  {getOverallHealthIcon(overallHealth)}
                </span>
              </div>
              <div className="flex flex-col gap-3">
                {STATUS_SOURCES.map((source) => (
                  <a
                    key={source.key}
                    href={source.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-between group/status hover:bg-slate-100/50 dark:hover:bg-slate-800/50 p-1 -m-1 rounded transition-colors"
                  >
                    <span className="text-xs text-slate-700 dark:text-slate-300 group-hover/status:text-slate-900 dark:group-hover/status:text-white flex items-center gap-1">
                      {source.label}
                      <span
                        className="material-symbols-outlined text-[10px] opacity-0 group-hover/status:opacity-100 transition-opacity"
                        aria-hidden="true"
                      >
                        open_in_new
                      </span>
                    </span>
                    <span
                      className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${getHealthBadgeClass(healthStatuses[source.key])}`}
                    >
                      {healthStatuses[source.key]}
                    </span>
                  </a>
                ))}
              </div>
            </div>

            {/* Multi-Cloud Release Wire (Quick Access Hubs) */}
            <div className="glass-panel rounded-lg p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between border-b border-slate-300/70 dark:border-slate-700/50 pb-2">
                <h4 className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-400">
                  Quick Access Hubs
                </h4>
                <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-500 border border-cyan-500/20">
                  Release Wire
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2.5">
                {QUICK_ACCESS_HUBS.map((hub) => (
                  <Link
                    key={hub.provider}
                    className={`${HUB_LINK} ${hub.hoverBorder}`}
                    to={routes.rss(hub.provider)}
                    style={{ '--glow-color': hub.glow }}
                  >
                    <div className={`${HUB_ICON} ${hub.iconTone}`}>
                      <span className="material-symbols-outlined text-xl">{hub.icon}</span>
                    </div>
                    <div className="flex flex-col flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1">
                        <span className={`${HUB_LABEL} ${hub.labelHover} truncate`}>
                          {hub.label}
                        </span>
                        {hub.tag && (
                          <span className="text-[9px] font-mono font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-200/60 dark:bg-slate-800/80 text-slate-600 dark:text-slate-400 border border-slate-300/40 dark:border-slate-700/50 shrink-0">
                            {hub.tag}
                          </span>
                        )}
                      </div>
                      <span className={[HUB_NOTE, hub.noteHover].filter(Boolean).join(' ')}>
                        {feedCountLabel(hub.provider)}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </aside>
        </div>
      </NumberedSection>
    </main>
  );
}

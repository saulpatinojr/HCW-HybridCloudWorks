import React, { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import CertificationCarouselSection from '@/components/education/CertificationCarouselSection';
import { useCertificationCarousel } from '@/components/education/useCertificationCarousel';
import FeaturedCertSection from '@/components/education/FeaturedCertSection';
import ProviderLabsSection from '@/components/labs/ProviderLabsSection';
import { DATA_AS_OF, DATA_SOURCE, certifications } from '@/data/terraform/certifications';

// ── Constants ────────────────────────────────────────────────────────────────

const LEVEL_META = {
  Associate: {
    badge: 'bg-emerald-500/20 border-emerald-500/40 text-emerald-300',
    accent: 'border-l-emerald-500',
    dot: 'bg-emerald-500',
    label: 'Associate',
  },
  Advanced: {
    badge: 'bg-violet-500/20 border-violet-500/40 text-violet-300',
    accent: 'border-l-violet-500',
    dot: 'bg-violet-500',
    label: 'Advanced',
  },
};

const FILTER_LEVELS = ['All', 'Associate', 'Advanced'];
const STATUS_FILTER = ['All', 'Active'];
const VISIBLE_COUNT = 4;

// The hub's colour classes, handed to the shared education components so
// their markup names no colour. Full class strings, so Tailwind sees them.
const TONE = {
  headingIcon: 'text-purple-400',
  activeDot: 'bg-purple-400',
  activeFilter: 'bg-purple-500/25 border-purple-400 text-purple-300',
  cardHover: 'hover:shadow-[0_0_20px_rgba(168,85,247,0.15)] hover:border-purple-400/40',
  titleHover: 'group-hover:text-purple-300',
  linkHover: 'hover:bg-purple-500/20 hover:text-purple-300',
  accentText: 'text-purple-400',
  articleHover: 'hover:shadow-[0_0_25px_rgba(168,85,247,0.15)] hover:border-purple-400/50',
  badge: 'bg-purple-500/20 border border-purple-500/30 text-purple-300',
  button: 'bg-purple-600 hover:bg-purple-500 text-white',
  gettingStartedCard: 'bg-gradient-to-br from-purple-500/20 to-violet-900/20 backdrop-blur-md border border-purple-500/30',
};

/** The hub's own link to the issuer's full catalogue, under the featured credential. */
const ALL_CERTS = { href: 'https://www.hashicorp.com/certification', label: 'View All HashiCorp Certs ↗' };

/** The "Getting Started" card beside the catalogue: where a newcomer begins. */
const GETTING_STARTED = {
  text: 'New to HashiCorp? TA-003 (Terraform Associate) is the most widely adopted IaC certification and the ideal first HashiCorp exam.',
  href: 'https://developer.hashicorp.com/certifications/infrastructure-automation',
  label: 'Start with TA-003',
};

function getLevelFilterClass(levelFilter, level) {
  if (levelFilter !== level) {
    return 'bg-card/30 border-card/50 text-foreground/60 hover:text-foreground hover:border-foreground/40';
  }
  if (level === 'All') {
    return 'bg-purple-500/30 border-purple-400 text-purple-300';
  }
  return `${LEVEL_META[level]?.badge ?? ''} border-current`;
}

// ── Data ─────────────────────────────────────────────────────────────────────

const learningPaths = [
  {
    id: 0,
    certCode: 'TA-004',
    title: 'Terraform Associate Path',
    level: 'Intermediate',
    hours: 25,
    description: 'Master Terraform fundamentals from HCL syntax through state management, modules, workspaces, and integrating Terraform into CI/CD pipelines.',
    modules: [
      { title: 'HCL Syntax & Basics' },
      { title: 'Providers & Resources' },
      { title: 'State Management' },
      { title: 'Modules & Workspaces' },
      { title: 'CI/CD with Terraform' },
    ],
    certUrl: 'https://developer.hashicorp.com/certifications/infrastructure-automation',
  },
  {
    id: 1,
    certCode: 'TA-004',
    title: 'Multi-Cloud IaC Path',
    level: 'Advanced',
    hours: 40,
    description: 'Use Terraform to manage infrastructure across AWS, Azure, and Google Cloud with remote state backends and plans reviewed in pull requests before they apply.',
    modules: [
      { title: 'AWS Provider' },
      { title: 'AzureRM Provider' },
      { title: 'Google Provider' },
      { title: 'Remote State & Pull Request Reviews' },
    ],
    certUrl: 'https://developer.hashicorp.com/certifications/infrastructure-automation',
  },
  {
    id: 2,
    certCode: 'HCP-TF',
    title: 'HCP Terraform Enterprise Path',
    level: 'Advanced',
    hours: 35,
    description: 'Operate Terraform at enterprise scale using HCP Terraform — covering VCS-driven workflows, Sentinel policy as code, drift detection, and run triggers.',
    modules: [
      { title: 'Team Workflows & VCS' },
      { title: 'Policy as Code (Sentinel)' },
      { title: 'Drift Detection' },
      { title: 'Run Triggers & Audit' },
    ],
    certUrl: 'https://developer.hashicorp.com/terraform/cloud-docs',
  },
];

const resources = [
  {
    id: 'hashicorp-developer',
    title: 'HashiCorp Developer Docs',
    description: 'Official documentation for Terraform, Vault, Consul, Nomad, and all HashiCorp tools — tutorials, reference guides, and API docs.',
    type: 'Documentation',
    icon: 'description',
    url: 'https://developer.hashicorp.com/',
  },
  {
    id: 'hc-tutorials',
    title: 'HashiCorp Tutorials',
    description: 'Hands-on step-by-step tutorials for every HashiCorp product hosted on HashiCorp Developer — formerly HashiCorp Learn.',
    type: 'Tutorials',
    icon: 'school',
    url: 'https://developer.hashicorp.com/tutorials',
  },
  {
    id: 'terraform-registry',
    title: 'Terraform Registry',
    description: 'Browse 10,000+ providers and modules from HashiCorp and the community for every major cloud platform and service.',
    type: 'Registry',
    icon: 'inventory',
    url: 'https://registry.terraform.io/',
  },
  {
    id: 'hcp-terraform',
    title: 'HCP Terraform Free Tier',
    description: 'HashiCorp Cloud Platform Terraform — remote state, team collaboration, and Sentinel policy as code, free for up to 500 resources.',
    type: 'Platform',
    icon: 'cloud',
    url: 'https://app.terraform.io/',
  },
  {
    id: 'tflint',
    title: 'TFLint',
    description: 'A Terraform linter focused on detecting errors and enforcing best practices — supports AWS, Azure, and GCP provider rules.',
    type: 'Tool',
    icon: 'bug_report',
    url: 'https://github.com/terraform-linters/tflint',
  },
];

// ── Page ─────────────────────────────────────────────────────────────────────

export default function TerraformEducationPage() {
  const [selectedPathId, setSelectedPathId] = useState(0);
  const carousel = useCertificationCarousel(certifications, {
    visibleCount: VISIBLE_COUNT,
    asOf: DATA_AS_OF,
  });

  const featuredCert = certifications.find((c) => c.featured);

  const selectedPath = learningPaths[selectedPathId];

  return (
    <>
      <Helmet>
        <title>Terraform &amp; HashiCorp Certifications | HCW</title>
        <meta
          name="description"
          content="HashiCorp Terraform and Vault certification prep — Associate and Advanced — with learning paths and IaC resources."
        />
        <meta property="og:title" content="Terraform & HashiCorp Certifications" />
        <meta
          property="og:description"
          content="Structured learning paths, certification prep, and curated resources for HashiCorp certifications."
        />
      </Helmet>

      <main className="flex-grow pt-28 pb-20 px-4 md:px-8 max-w-[1440px] mx-auto w-full">
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className="mb-12 relative">
          <div className="absolute -top-10 -left-10 w-96 h-96 bg-purple-500/5 blur-3xl rounded-full pointer-events-none" />
          <h1 className="text-3xl sm:text-5xl md:text-6xl font-bold mb-4 relative z-10">
            <span className="bg-clip-text text-transparent bg-gradient-to-r from-terraform-primary via-slate-900 to-terraform-primary dark:via-white">
              Terraform &amp; HashiCorp Certifications
            </span>
          </h1>
          <p className="text-base sm:text-lg text-foreground max-w-3xl relative z-10">
            Master infrastructure as code and secrets management with HashiCorp certifications
            for Terraform and Vault — the Associate exams and the lab-based Advanced credentials.
          </p>
          <div className="flex flex-wrap gap-2 mt-4 relative z-10">
            {['Associate', 'Advanced'].map((level) => (
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
              href="https://developer.hashicorp.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="group relative bg-gradient-to-br from-purple-900/40 to-card/40 backdrop-blur-md border border-purple-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(168,85,247,0.2)] hover:border-purple-400/60 transition-all duration-300 flex items-start gap-5"
            >
              <div className="w-14 h-14 shrink-0 bg-purple-500/20 rounded-xl flex items-center justify-center">
                <span className="text-purple-400 text-[28px] material-symbols-outlined" aria-hidden="true">
                  workspace_premium
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h2 className="text-lg font-bold text-slate-950 dark:text-white group-hover:text-purple-300 transition-colors">
                    HashiCorp Developer
                  </h2>
                  <span className="px-2 py-0.5 bg-purple-500/20 border border-purple-500/30 text-purple-300 text-[10px] font-bold rounded-full uppercase tracking-wider shrink-0">
                    Official
                  </span>
                </div>
                <p className="text-sm text-foreground mb-3">
                  The official HashiCorp developer portal — tutorials, documentation, and
                  certification prep for Terraform, Vault, and every HashiCorp tool.
                </p>
                <div className="flex items-center gap-1.5 text-purple-400 text-sm font-semibold">
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">open_in_new</span>
                  developer.hashicorp.com
                </div>
              </div>
            </a>

            <a
              href="https://www.hashicorp.com/certification"
              target="_blank"
              rel="noopener noreferrer"
              className="group relative bg-gradient-to-br from-violet-900/40 to-card/40 backdrop-blur-md border border-violet-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(139,92,246,0.2)] hover:border-violet-400/60 transition-all duration-300 flex items-start gap-5"
            >
              <div className="w-14 h-14 shrink-0 bg-violet-500/20 rounded-xl flex items-center justify-center">
                <span className="text-violet-400 text-[28px] material-symbols-outlined" aria-hidden="true">
                  construction
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <h2 className="text-lg font-bold text-slate-950 dark:text-white group-hover:text-violet-300 transition-colors">
                    HashiCorp Certification
                  </h2>
                  <span className="px-2 py-0.5 bg-violet-500/20 border border-violet-500/30 text-violet-300 text-[10px] font-bold rounded-full uppercase tracking-wider shrink-0">
                    Exams & Badges
                  </span>
                </div>
                <p className="text-sm text-foreground mb-3">
                  View all HashiCorp certifications, register for exams, review exam objectives,
                  and access study guides for the Terraform and Vault credentials.
                </p>
                <div className="flex items-center gap-1.5 text-violet-400 text-sm font-semibold">
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">open_in_new</span>
                  hashicorp.com/certification
                </div>
              </div>
            </a>
          </div>
        </section>

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
        <section className="mb-16">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
            <h3 className="text-2xl font-bold text-slate-950 dark:text-white flex items-center gap-2">
              <span className="text-purple-400 text-[24px] material-symbols-outlined" aria-hidden="true">bookmark</span>
              Learning Paths
            </h3>
            <div className="relative">
              <select
                value={selectedPathId}
                onChange={(e) => setSelectedPathId(Number(e.target.value))}
                className="appearance-none bg-card/40 backdrop-blur-md border border-card/50 text-foreground text-sm rounded-xl px-4 pr-10 h-10 hover:border-purple-400/50 focus:outline-none focus:border-purple-400 transition-colors cursor-pointer"
              >
                {learningPaths.map((p, i) => (
                  <option key={i} value={i} className="bg-slate-900">
                    {p.certCode} — {p.title}
                  </option>
                ))}
              </select>
              <span className="absolute right-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-[16px] text-foreground pointer-events-none" aria-hidden="true">
                expand_more
              </span>
            </div>
          </div>

          {selectedPath && (
            <article className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-8 hover:shadow-[0_0_25px_rgba(168,85,247,0.15)] hover:border-purple-400/50 transition-all duration-300">
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <span className="px-3 py-1 bg-purple-500/20 border border-purple-500/30 text-purple-300 text-xs font-bold rounded font-mono">
                  {selectedPath.certCode}
                </span>
                <span className="px-3 py-1 bg-card/50 text-foreground text-xs font-bold rounded">
                  {selectedPath.level}
                </span>
                <span className="text-sm text-foreground/60">{selectedPath.hours} hours</span>
              </div>
              <h2 className="text-3xl font-bold text-slate-950 dark:text-white mb-2">{selectedPath.title}</h2>
              <p className="text-foreground mb-6 text-lg">{selectedPath.description}</p>

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
                <div className="bg-card/60 rounded-lg p-4">
                  <div className="text-sm text-foreground mb-1">Total Hours</div>
                  <div className="text-2xl font-bold text-purple-400">{selectedPath.hours}</div>
                </div>
                <div className="bg-card/60 rounded-lg p-4">
                  <div className="text-sm text-foreground mb-1">Modules</div>
                  <div className="text-2xl font-bold text-violet-400">{selectedPath.modules.length}</div>
                </div>
              </div>

              <h3 className="text-sm font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-3">
                Modules
              </h3>
              <div className="space-y-2">
                {selectedPath.modules.map((mod, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 p-3 bg-card/30 rounded-lg border border-card/40"
                  >
                    <span className="w-6 h-6 rounded-full bg-purple-500/20 text-purple-300 text-xs font-bold flex items-center justify-center shrink-0">
                      {i + 1}
                    </span>
                    <span className="text-sm text-foreground">{mod.title}</span>
                  </div>
                ))}
              </div>

              <div className="mt-8 flex flex-col sm:flex-row gap-3">
                <a
                  href={selectedPath.certUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 h-11 px-4 bg-purple-600 hover:bg-purple-500 text-white font-bold rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-[16px]" aria-hidden="true">open_in_new</span>
                  View {selectedPath.certCode} on HashiCorp Developer
                </a>
              </div>
            </article>
          )}
        </section>

        {/* ── Labs (ADR 0033 §8) ───────────────────────────────────────── */}
        <ProviderLabsSection provider="terraform" className="mb-16" />

        {/* ── Learning Resources ───────────────────────────────────────── */}
        <section className="mb-16">
          <h3 className="text-2xl font-bold text-slate-950 dark:text-white mb-6 flex items-center gap-2">
            <span className="text-purple-400 text-[24px] material-symbols-outlined" aria-hidden="true">
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
                className="group bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6 flex flex-col hover:shadow-[0_0_25px_rgba(168,85,247,0.15)] hover:border-purple-400/50 transition-all duration-300"
              >
                <div className="w-12 h-12 rounded-xl bg-purple-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                  <span className="material-symbols-outlined text-purple-400 text-[24px]" aria-hidden="true">
                    {resource.icon}
                  </span>
                </div>
                <div className="text-xs font-bold text-purple-400/70 uppercase tracking-wider mb-1">
                  {resource.type}
                </div>
                <h4 className="font-bold text-slate-950 dark:text-white mb-2 group-hover:text-purple-300 transition-colors">
                  {resource.title}
                </h4>
                <p className="text-xs text-foreground flex-1">{resource.description}</p>
                <div className="mt-4 flex items-center gap-1 text-purple-400 text-xs font-semibold">
                  Explore{' '}
                  <span className="material-symbols-outlined text-[14px]" aria-hidden="true">open_in_new</span>
                </div>
              </a>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}

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

/** The two big links to the issuer's own sites, near the top of the page. */
const OFFICIAL_LINKS = [
  {
    href: 'https://developer.hashicorp.com/',
    tone: 'purple',
    icon: 'workspace_premium',
    title: 'HashiCorp Developer',
    badge: 'Official',
    address: 'developer.hashicorp.com',
    text: 'The official HashiCorp developer portal — tutorials, documentation, and certification prep for Terraform, Vault, and every HashiCorp tool.',
  },
  {
    href: 'https://www.hashicorp.com/certification',
    tone: 'violet',
    icon: 'construction',
    title: 'HashiCorp Certification',
    badge: 'Exams & Badges',
    address: 'hashicorp.com/certification',
    text: 'View all HashiCorp certifications, register for exams, review exam objectives, and access study guides for the Terraform and Vault credentials.',
  },
];

// ── Page ─────────────────────────────────────────────────────────────────────

export default function TerraformEducationPage() {
  const carousel = useCertificationCarousel(certifications, {
    visibleCount: VISIBLE_COUNT,
    asOf: DATA_AS_OF,
  });

  const featuredCert = certifications.find((c) => c.featured);


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
        <LearningPathsSection paths={learningPaths} palette="purple" issuer="HashiCorp Developer" />

        {/* ── Labs (ADR 0033 §8) ───────────────────────────────────────── */}
        <ProviderLabsSection provider="terraform" className="mb-16" />

        {/* ── Learning Resources ───────────────────────────────────────── */}
        <LearningResourcesSection resources={resources} palette="purple" />
      </main>
    </>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { routes } from '@/lib/routeFactory';
import ProviderLabsSection from '@/components/labs/ProviderLabsSection';
import { plural } from '@/components/labs/labsWords';
import { labsForProvider } from '@/data/labs/catalogue';
import {
  DATA_AS_OF,
  certifications,
  appliedSkills,
  timelineEvents,
} from '@/data/azure/certifications';
import { deriveStatus, useToday } from '@/lib/certStatus';
import { certEventToTimelineEvent, mergeTimelineEvents } from '@/lib/certEvents';
import { fetchPublicCertEvents } from '@/lib/publicApi';
import { usePublicData } from '@/hooks/usePublicData';
import {
  AppliedSkillsLibrary,
  AzureLearningPaths,
  AzureLearningResources,
  CertificationCarousel,
  EducationHero,
  FeaturedCertSection,
  PostersBanner,
  VISIBLE_COUNT,
} from './education/AzureEducationSections';
import { HorizontalTimeline } from './education/azureTimeline';

const STATUS_ORDER = { active: 0, beta: 1, expiring: 2, retired: 3 };
const APPLIED_SKILLS_COLLAPSED_ROWS = 3;

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
        <EducationHero />

        {/* ── Posters Banner ───────────────────────────────────────────── */}
        <PostersBanner />

        {/* ── Browse Certifications Carousel ───────────────────────────── */}
        <CertificationCarousel
          carouselPage={carouselPage}
          filteredCerts={filteredCerts}
          handleLevelFilter={handleLevelFilter}
          handleStatusFilter={handleStatusFilter}
          levelFilter={levelFilter}
          setCarouselPage={setCarouselPage}
          statusFilter={statusFilter}
          today={today}
          totalPages={totalPages}
          visibleCerts={visibleCerts}
        />

        {/* ── Featured Cert + Sidebar ──────────────────────────────────── */}
        <FeaturedCertSection certs={certs} featuredCert={featuredCert} />

        {/* ── Cert Lifecycle Timeline (horizontal Gantt) ───────────────── */}
        <HorizontalTimeline events={sortedTimeline} />

        {/* ── Learning Paths ───────────────────────────────────────────── */}
        <AzureLearningPaths
          learningPaths={learningPaths}
          selectedPath={selectedPath}
          selectedPathId={selectedPathId}
          setSelectedPathId={setSelectedPathId}
        />

        {/* ── Applied Skills Reference Library ─────────────────────────── */}
        <AppliedSkillsLibrary
          appliedSkillArea={appliedSkillArea}
          appliedSkillsExpanded={appliedSkillsExpanded}
          filteredSkills={filteredSkills}
          hasMoreAppliedSkills={hasMoreAppliedSkills}
          setAppliedSkillArea={setAppliedSkillArea}
          setAppliedSkillsExpanded={setAppliedSkillsExpanded}
          visibleAppliedSkills={visibleAppliedSkills}
        />

        {/* ── Learning Resources ───────────────────────────────────────── */}
        <AzureLearningResources resources={resources} />

        <ProviderLabsSection provider="azure" className="mt-16" />
      </main>
    </>
  );
}

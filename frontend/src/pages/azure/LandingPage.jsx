import React from 'react';
import { routes } from '@/lib/routeFactory';
import ProviderLandingTemplate from '@/components/shared/ProviderLandingTemplate';
import {
  certTracksSection,
  designsSection,
  episodesSection,
  frameworksSection,
} from '@/pages/shared/landing/LandingSections';
import HeroImageCarousel from '@/components/landing/HeroImageCarousel';
import { useInterviewList } from '@/pages/azure/InterviewsPage';

const AZURE_HERO_IMAGES = [
  '/images/azure-hero/1.png',
  '/images/azure-hero/2.png',
  '/images/azure-hero/3.png',
  '/images/azure-hero/4.png',
  '/images/azure-hero/5.png',
];

const ARCHITECTURE_CARDS = [
  {
    label: 'Networking',
    meta: 'Hub-Spoke',
    title: 'Hub-and-Spoke Network',
    text: 'ExpressRoute gateway, Azure Firewall, shared services VNet with spoke isolation and route tables.',
    tags: ['ExpressRoute', 'Firewall', 'VNet'],
  },
  {
    label: 'Containers',
    meta: 'Production AKS',
    title: 'AKS Landing Zone',
    text: 'Private AKS cluster with Azure CNI, Defender, workload identity, and integrated Container Registry.',
    tags: ['AKS', 'Workload Identity', 'Defender'],
  },
];

const FRAMEWORKS = [
  {
    abbr: 'CAF',
    name: 'Cloud Adoption Framework',
    description:
      'Microsoft guidance for end-to-end Azure adoption — strategy, planning, readiness, and governance at enterprise scale.',
  },
  {
    abbr: 'WAF',
    name: 'Well-Architected Framework',
    description:
      'Five pillars for building reliable, secure, cost-efficient, and operationally excellent Azure workloads.',
  },
  {
    abbr: 'ALZ',
    name: 'Azure Landing Zones',
    description:
      'Prescriptive architecture and platform accelerators for deploying governed Azure environments at scale.',
  },
];

const CERTS = [
  {
    code: 'AZ-104',
    slug: 'az-104',
    title: 'Azure Administrator Associate',
    difficulty: 'Associate',
    duration: '~3 months',
    skills: ['Entra ID', 'Networking', 'Storage'],
  },
  {
    code: 'AZ-305',
    slug: 'az-305',
    title: 'Azure Solutions Architect Expert',
    difficulty: 'Expert',
    duration: '~6 months',
    skills: ['Landing Zones', 'Hybrid', 'Cost'],
  },
  {
    code: 'AZ-400',
    slug: 'az-400',
    title: 'Azure DevOps Engineer Expert',
    difficulty: 'Expert',
    duration: '~6 months',
    skills: ['Pipelines', 'GitHub', 'IaC'],
  },
  {
    code: 'AI-103',
    slug: 'ai-103',
    title: 'Azure AI Apps & Agents Developer',
    difficulty: 'Associate',
    duration: '~3 months',
    skills: ['Azure AI', 'OpenAI', 'Agents'],
    isBeta: true,
  },
];

// Azure's interviews, linked from here and not from the header: the header's
// toolbar is a fixed grid of nine slots and a tenth link overflowed it.
// Carries no interview text: the card is the same sentence whatever is
// published, and whether it shows at all is read live from the public list
// (ADR 0040, D6; the pre-render seeds the same key from the manifest).
//
// The book view is promised only where it is offered: a wide screen, and a
// visitor who has not asked for less motion (pages/azure/InterviewsPage.jsx).
// Saying it to everyone would promise a phone something it does not get.
function InterviewsCard() {
  return (
    <div className="glass rounded-xl p-5 max-w-2xl">
      <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
        Conversations with people building and running Microsoft Azure, written up in full to read
        as an article. On a wide screen there is also a book view that turns the pages.
      </p>
    </div>
  );
}

export default function LandingPage() {
  const { interviews } = useInterviewList();
  const hasInterviews = interviews.length > 0;
  return (
    <ProviderLandingTemplate
      provider="azure"
      hero={{
        eyebrow: 'ENTERPRISE CLOUD SOLUTIONS',
        title: (
          <>
            Architecture intelligence for <span className="display-accent">Azure</span>
          </>
        ),
        description:
          'Deploy enterprise-grade Azure landing zones with Bicep-driven infrastructure as code, hub-spoke networks with ExpressRoute connectivity, private AKS clusters, and battle-tested security patterns.',
        media: (
          <HeroImageCarousel
            images={AZURE_HERO_IMAGES}
            intervalMs={3000}
            fadeMs={800}
            alt="Azure cloud architecture imagery"
          />
        ),
        cta: { label: 'Explore Architectures', to: routes.architectureDesigns('azure') },
        stats: [
          { value: '5', label: 'WAF Pillars' },
          { value: '2', suffix: '+', label: 'Reference Designs' },
          { value: '4', label: 'Cert Tracks' },
        ],
      }}
      sections={[
        designsSection('azure', 'Azure Reference Architectures', ARCHITECTURE_CARDS),
        frameworksSection('azure', FRAMEWORKS),
        episodesSection('azure', 'Azure Podcasts'),
        // Only once there is a published interview (the live list above).
        ...(hasInterviews
          ? [
              {
                eyebrow: 'IN CONVERSATION',
                title: 'Interviews',
                action: { label: 'All interviews', to: routes.interviews('azure') },
                content: <InterviewsCard />,
              },
            ]
          : []),
        certTracksSection('azure', {
          certs: CERTS,
          linkFor: (cert) => `/azure/education/${cert.slug}`,
          columns: 2,
        }),
      ]}
    />
  );
}

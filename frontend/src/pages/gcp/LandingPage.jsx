import React from 'react';
import { routes } from '@/lib/routeFactory';
import ProviderLandingTemplate from '@/components/shared/ProviderLandingTemplate';
import {
  architectureHero,
  certTracksSection,
  designsSection,
  episodesSection,
  frameworksSection,
} from '@/pages/shared/landing/LandingSections';

// Generated art (#371): scripts/generate-brand-art.mjs draws this set; replace any
// file one-for-one to swap in real artwork. scripts/hero-assets-exist.test.js
// fails on a path listed here that is not under public/.
const GCP_HERO_IMAGES = [
  '/images/gcp-hero/1.png',
  '/images/gcp-hero/2.png',
  '/images/gcp-hero/3.png',
  '/images/gcp-hero/4.png',
  '/images/gcp-hero/5.png',
];

const ARCHITECTURE_CARDS = [
  {
    label: 'Data Platform',
    meta: 'Streaming',
    title: 'Streaming Analytics Platform',
    text: 'Pub/Sub ingestion, Dataflow processing, BigQuery warehousing, and Looker dashboards with governance controls.',
    tags: ['Pub/Sub', 'Dataflow', 'BigQuery'],
  },
  {
    label: 'Containers',
    meta: 'Production GKE',
    title: 'Enterprise GKE Blueprint',
    text: 'Private GKE clusters, Workload Identity, policy guardrails, and GitOps deployment for production workloads.',
    tags: ['GKE', 'IAM', 'GitOps'],
  },
];

const FRAMEWORKS = [
  {
    abbr: 'GCAF',
    name: 'Google Cloud Architecture Framework',
    description:
      'Six areas of system design for reliable, secure, high-performing, cost-optimized GCP workloads.',
  },
  {
    abbr: 'GCAF-A',
    name: 'Google Cloud Adoption Framework',
    description:
      "Assess and improve your organization's cloud maturity across four themes: Learn, Lead, Scale, Secure.",
  },
  {
    abbr: 'GCLZ',
    name: 'Google Cloud Landing Zone',
    description:
      'Prescriptive, automated foundational environment for deploying GCP workloads with security and governance.',
  },
];

const CERTS = [
  {
    code: 'ACE',
    title: 'Associate Cloud Engineer',
    difficulty: 'Associate',
    duration: '~3 months',
    skills: ['Compute', 'Storage', 'Networking'],
  },
  {
    code: 'PCA',
    title: 'Professional Cloud Architect',
    difficulty: 'Professional',
    duration: '~6 months',
    skills: ['Architecture', 'GKE', 'Multi-Region'],
  },
  {
    code: 'PDE',
    title: 'Professional Data Engineer',
    difficulty: 'Professional',
    duration: '~6 months',
    skills: ['BigQuery', 'Dataflow', 'Pub/Sub'],
  },
];

export default function GCPLandingPage() {
  return (
    <ProviderLandingTemplate
      provider="gcp"
      hero={architectureHero('gcp', {
        eyebrow: 'DATA + AI + PLATFORM',
        name: 'Google Cloud',
        description:
          "Unlock Google Cloud's data and AI capabilities with production-ready architectures for streaming analytics, enterprise GKE deployments, and machine learning pipelines — from Pub/Sub ingestion to BigQuery warehousing.",
        images: GCP_HERO_IMAGES,
        alt: 'Google Cloud architecture imagery',
        stats: [
          { value: '6', label: 'Framework Areas' },
          { value: '2', suffix: '+', label: 'Reference Designs' },
          { value: '3', label: 'Cert Tracks' },
        ],
      })}
      sections={[
        designsSection('gcp', 'Google Cloud Reference Architectures', ARCHITECTURE_CARDS),
        frameworksSection('gcp', FRAMEWORKS),
        episodesSection('gcp', 'Google Cloud Podcasts'),
        certTracksSection('gcp', {
          certs: CERTS,
          linkFor: () => routes.education('gcp'),
          columns: 3,
        }),
      ]}
    />
  );
}

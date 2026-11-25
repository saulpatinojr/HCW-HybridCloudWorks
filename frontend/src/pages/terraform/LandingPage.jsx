import React from 'react';
import { routes } from '@/lib/routeFactory';
import ProviderLandingTemplate from '@/components/shared/ProviderLandingTemplate';
import {
  CertTrackGrid,
  FeatureCardGrid,
  QuickLinkGrid,
} from '@/pages/shared/landing/LandingSections';
import HeroImageCarousel from '@/components/landing/HeroImageCarousel';

// Generated art (#371): scripts/generate-brand-art.mjs draws this set; replace any
// file one-for-one to swap in real artwork. scripts/hero-assets-exist.test.js
// fails on a path listed here that is not under public/.
const TERRAFORM_HERO_IMAGES = [
  '/images/terraform-hero/1.png',
  '/images/terraform-hero/2.png',
  '/images/terraform-hero/3.png',
  '/images/terraform-hero/4.png',
  '/images/terraform-hero/5.png',
];

/*
 * NOTE: links previously pointed at /terraform/frameworks and
 * /terraform/architecture-designs which 404 (Terraform is not handled by
 * the frameworks/architecture dispatchers). All links now target live
 * routes: /terraform/modules, /terraform/code, /terraform/education.
 */

const MODULE_CARDS = [
  {
    label: 'Multi-Cloud',
    meta: 'Reusable',
    title: 'Module Collections',
    text: 'Curated, production-ready Terraform modules for common infrastructure patterns across AWS, Azure, and GCP.',
    tags: ['AWS', 'Azure', 'GCP'],
    to: routes.modules('terraform'),
  },
  {
    label: 'Enterprise',
    meta: 'HCP Terraform',
    title: 'Sentinel Policies',
    text: 'Policy-as-code with Sentinel and OPA for team workflows, drift detection, and VCS integration.',
    tags: ['Sentinel', 'OPA', 'Drift'],
    to: routes.modules('terraform'),
  },
];

const QUICK_LINKS = [
  {
    icon: 'layers',
    title: 'Reusable Modules',
    desc: 'Production-ready modules for AWS, Azure, and GCP.',
    to: routes.modules('terraform'),
  },
  {
    icon: 'code',
    title: 'Code Patterns',
    desc: 'Terraform snippets and implementation notes from Coder Corner.',
    to: routes.code('terraform'),
  },
  {
    icon: 'bolt',
    title: 'CI/CD Integration',
    desc: 'Automated testing and deployment pipelines for IaC.',
    to: routes.tools('terraform'),
  },
  {
    icon: 'school',
    title: 'Certification Prep',
    desc: 'Terraform Associate and enterprise learning tracks.',
    to: routes.education('terraform'),
  },
];

const LEARNING = [
  {
    code: 'TA-004',
    title: 'Terraform Associate',
    difficulty: 'Associate',
    duration: '6 weeks',
    skills: ['HCL', 'State', 'Modules'],
  },
  {
    code: 'TF-MULTI',
    title: 'Multi-Cloud IaC',
    difficulty: 'Intermediate',
    duration: '8 weeks',
    skills: ['AWS', 'Azure', 'GCP'],
  },
  {
    code: 'HCP-TF',
    title: 'HCP Terraform Enterprise',
    difficulty: 'Professional',
    duration: '10 weeks',
    skills: ['Sentinel', 'OPA', 'Drift'],
  },
];

export default function TerraformLandingPage() {
  return (
    <ProviderLandingTemplate
      provider="terraform"
      hero={{
        eyebrow: 'INFRASTRUCTURE AS CODE',
        title: (
          <>
            Infrastructure intelligence with <span className="display-accent">Terraform</span>
          </>
        ),
        description:
          'Master Terraform with battle-tested modules, multi-cloud patterns, and enterprise-grade IaC workflows.',
        media: (
          <HeroImageCarousel
            images={TERRAFORM_HERO_IMAGES}
            intervalMs={3000}
            fadeMs={800}
            alt="Terraform infrastructure imagery"
          />
        ),
        cta: { label: 'Browse Modules', to: routes.modules('terraform') },
        stats: [
          { value: '12', label: 'Module Collections' },
          { value: '3', label: 'Cloud Providers' },
          { value: '40', suffix: '+', label: 'Ready-to-Use Modules' },
        ],
      }}
      sections={[
        {
          eyebrow: 'MODULE LIBRARY',
          title: 'Terraform Module Library',
          action: { label: 'All modules', to: routes.modules('terraform') },
          content: <FeatureCardGrid cards={MODULE_CARDS} />,
        },
        {
          eyebrow: 'QUICK REFERENCE',
          title: 'Most-Used Resources',
          content: <QuickLinkGrid links={QUICK_LINKS} />,
        },
        {
          eyebrow: 'LEARNING CENTER',
          title: 'Certification & Learning Tracks',
          action: { label: 'Learning hub', to: routes.education('terraform') },
          content: (
            <CertTrackGrid
              certs={LEARNING}
              linkFor={() => routes.education('terraform')}
              columns={3}
            />
          ),
        },
      ]}
    />
  );
}

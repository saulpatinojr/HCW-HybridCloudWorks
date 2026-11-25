import React from 'react';
import { routes } from '@/lib/routeFactory';
import ProviderLandingTemplate from '@/components/shared/ProviderLandingTemplate';
import {
  certTracksSection,
  designsSection,
  frameworksSection,
} from '@/pages/shared/landing/LandingSections';

const ARCHITECTURE_CARDS = [
  {
    label: 'Private Cloud',
    meta: 'VCF',
    title: 'VMware Cloud Foundation',
    text: 'Full-stack SDDC blueprint — vSphere, vSAN, NSX, and Aria automation for a consistent private-cloud platform.',
    tags: ['vSphere', 'vSAN', 'NSX'],
  },
  {
    label: 'Hybrid',
    meta: 'Multi-Cloud',
    title: 'Hybrid Cloud Extension',
    text: 'HCX-based workload mobility between on-premises vSphere and hyperscaler-hosted VMware SDDCs with zero-downtime migration.',
    tags: ['HCX', 'AVS', 'VMC'],
  },
];

const FRAMEWORKS = [
  {
    abbr: 'VCF',
    name: 'VMware Cloud Foundation',
    description:
      'Integrated software-defined data center stack with standardized architecture for compute, storage, and networking.',
  },
  {
    abbr: 'VVD',
    name: 'VMware Validated Designs',
    description:
      'Prescriptive, tested blueprints for deploying and operating VMware SDDC environments at scale.',
  },
  {
    abbr: 'NSX-REF',
    name: 'NSX Reference Designs',
    description:
      'Network virtualization and micro-segmentation patterns for zero-trust east-west security.',
  },
];

const CERTS = [
  {
    code: 'VCP-VCF',
    title: 'VCP — VMware Cloud Foundation',
    difficulty: 'Professional',
    duration: '~3 months',
    skills: ['vSphere', 'vSAN', 'NSX'],
  },
  {
    code: 'VCAP-VCF',
    title: 'VCAP — VMware Cloud Foundation',
    difficulty: 'Advanced',
    duration: '~6 months',
    skills: ['Administrator', 'Architect', 'Support'],
  },
];

export default function VMwareLandingPage() {
  return (
    <ProviderLandingTemplate
      provider="vmware"
      hero={{
        eyebrow: 'PRIVATE CLOUD · VIRTUALIZATION · HYBRID',
        title: (
          <>
            Architecture intelligence for <span className="display-accent">VMware</span>
          </>
        ),
        description:
          'Private-cloud and hybrid architectures built on VMware Cloud Foundation — vSphere, vSAN, and NSX patterns for modernizing the data center and extending it to the hyperscalers.',
        cta: { label: 'Explore Architectures', to: routes.architectureDesigns('vmware') },
        stats: [
          { value: '3', label: 'Validated Designs' },
          { value: '2', suffix: '+', label: 'Reference Blueprints' },
          { value: '2', label: 'Cert Tracks' },
        ],
      }}
      sections={[
        designsSection('vmware', 'VMware Reference Architectures', ARCHITECTURE_CARDS),
        frameworksSection('vmware', FRAMEWORKS),
        certTracksSection('vmware', {
          certs: CERTS,
          linkFor: () => routes.education('vmware'),
        }),
      ]}
    />
  );
}

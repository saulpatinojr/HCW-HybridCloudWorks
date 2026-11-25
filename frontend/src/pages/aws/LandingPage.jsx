import React from 'react';
import ProviderLandingTemplate from '@/components/shared/ProviderLandingTemplate';
import {
  architectureHero,
  certTracksSection,
  designsSection,
  episodesSection,
  frameworksSection,
} from '@/pages/shared/landing/LandingSections';

const AWS_HERO_IMAGES = [
  '/images/aws-hero/1.png',
  '/images/aws-hero/2.png',
  '/images/aws-hero/3.png',
  '/images/aws-hero/4.png',
  '/images/aws-hero/5.png',
  '/images/aws-hero/6.png',
];

const ARCHITECTURE_CARDS = [
  {
    label: 'Networking',
    meta: 'Multi-Region',
    title: 'Global Load Balancing',
    text: 'Route 53 latency routing, CloudFront distributions, and ALB across regions with health-check failover and active-active traffic splitting.',
    tags: ['Route 53', 'CloudFront', 'ALB'],
  },
  {
    label: 'Serverless',
    meta: 'Event-Driven',
    title: 'Serverless API',
    text: 'API Gateway with Lambda authorizers, DynamoDB single-table design, WAF edge protection, and X-Ray distributed tracing.',
    tags: ['API Gateway', 'Lambda', 'DynamoDB'],
  },
];

const FRAMEWORKS = [
  {
    abbr: 'WAF',
    name: 'AWS Well-Architected Framework',
    description:
      'Six pillars for building secure, reliable, efficient, cost-effective, sustainable AWS workloads.',
  },
  {
    abbr: 'CAF',
    name: 'AWS Cloud Adoption Framework',
    description:
      'Guidance for accelerating cloud adoption across six perspectives: Business, People, Governance, Platform, Security, Operations.',
  },
  {
    abbr: 'LZA',
    name: 'AWS Landing Zone Accelerator',
    description:
      'Automated, multi-account AWS environment setup with security and governance guardrails built in.',
  },
];

const CERTS = [
  {
    slug: 'clf-c02',
    code: 'CLF-C02',
    title: 'Cloud Practitioner',
    difficulty: 'Foundational',
    duration: '1 month',
    skills: ['Cloud Basics', 'Billing', 'Security'],
  },
  {
    slug: 'saa-c03',
    code: 'SAA-C03',
    title: 'Solutions Architect Associate',
    difficulty: 'Associate',
    duration: '3 months',
    skills: ['EC2', 'S3', 'VPC', 'IAM'],
  },
  {
    slug: 'sap-c02',
    code: 'SAP-C02',
    title: 'Solutions Architect Professional',
    difficulty: 'Professional',
    duration: '6 months',
    skills: ['Multi-Region', 'Hybrid', 'Cost'],
  },
  {
    slug: 'scs-c03',
    code: 'SCS-C03',
    title: 'Security Specialty',
    difficulty: 'Specialty',
    duration: '4 months',
    skills: ['IAM', 'KMS', 'GuardDuty'],
  },
];

export default function AWSLandingPage() {
  return (
    <ProviderLandingTemplate
      provider="aws"
      hero={architectureHero('aws', {
        eyebrow: 'BUILD. INNOVATE. ELEVATE.',
        name: 'AWS',
        description:
          'Master AWS with proven patterns for global load balancing, serverless architectures, and event-driven microservices — reference implementations that combine AWS best practices with real-world operational insight.',
        images: AWS_HERO_IMAGES,
        alt: 'AWS cloud architecture imagery',
        stats: [
          { value: '6', label: 'WAF Pillars' },
          { value: '2', suffix: '+', label: 'Reference Designs' },
          { value: '4', label: 'Cert Tracks' },
        ],
      })}
      sections={[
        designsSection('aws', 'AWS Reference Architectures', ARCHITECTURE_CARDS),
        frameworksSection('aws', FRAMEWORKS),
        episodesSection('aws', 'AWS Podcasts'),
        certTracksSection('aws', {
          certs: CERTS,
          linkFor: (cert) => `/aws/education/${cert.slug}`,
          columns: 2,
        }),
      ]}
    />
  );
}

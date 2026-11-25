import React from 'react';
import { routes } from '@/lib/routeFactory';
import ProviderLandingTemplate from '@/components/shared/ProviderLandingTemplate';
import {
  CertTrackGrid,
  FeatureCardGrid,
  QuickLinkGrid,
} from '@/pages/shared/landing/LandingSections';

const CODE_CARDS = [
  {
    label: 'Playbooks',
    meta: 'Reusable',
    title: 'Playbook Patterns',
    text: 'Idempotent, role-driven playbooks for configuration management across Linux, Windows, and network devices.',
    tags: ['Roles', 'Idempotency', 'Vault'],
    to: routes.code('ansible'),
  },
  {
    label: 'Event-Driven',
    meta: 'EDA',
    title: 'Event-Driven Automation',
    text: 'Rulebooks and event sources that trigger remediation automatically — self-healing infrastructure with Ansible EDA.',
    tags: ['Rulebooks', 'Webhooks', 'Remediation'],
    to: routes.code('ansible'),
  },
];

const QUICK_LINKS = [
  {
    icon: 'code',
    title: 'Code Patterns',
    desc: 'Playbooks, roles, and automation snippets from Coder Corner.',
    to: routes.code('ansible'),
  },
  {
    icon: 'article',
    title: 'Automation Blog',
    desc: 'Playbook design and platform engineering deep dives.',
    to: routes.blog('ansible'),
  },
  {
    icon: 'rss_feed',
    title: 'Ansible News',
    desc: 'Latest from the Ansible and Red Hat ecosystem.',
    to: routes.rss('ansible'),
  },
  {
    icon: 'school',
    title: 'Certification Prep',
    desc: 'RHCE and Ansible Automation Platform learning tracks.',
    to: routes.education('ansible'),
  },
];

const LEARNING = [
  {
    code: 'RHCE',
    title: 'Red Hat Certified Engineer',
    difficulty: 'Professional',
    duration: '~4 months',
    skills: ['Playbooks', 'Roles', 'Vault'],
  },
  {
    code: 'EX374',
    title: 'Developing Automation with AAP',
    difficulty: 'Specialist',
    duration: '~3 months',
    skills: ['Collections', 'EEs', 'CI/CD'],
  },
  {
    code: 'EX467',
    title: 'Managing Automation with AAP',
    difficulty: 'Specialist',
    duration: '~3 months',
    skills: ['Controller', 'Hub', 'RBAC'],
  },
];

export default function AnsibleLandingPage() {
  return (
    <ProviderLandingTemplate
      provider="ansible"
      hero={{
        eyebrow: 'AUTOMATE. ORCHESTRATE. SCALE.',
        title: (
          <>
            Automation intelligence with <span className="display-accent">Ansible</span>
          </>
        ),
        description:
          'Battle-tested playbooks, event-driven automation patterns, and enterprise workflows for the Red Hat Ansible Automation Platform.',
        cta: { label: 'Browse Code Patterns', to: routes.code('ansible') },
        stats: [
          { value: '2', suffix: '+', label: 'Pattern Collections' },
          { value: '3', label: 'Cert Tracks' },
          { value: '100', suffix: '%', label: 'Idempotent' },
        ],
      }}
      sections={[
        {
          eyebrow: 'CODE LIBRARY',
          title: 'Automation Patterns',
          action: { label: 'All patterns', to: routes.code('ansible') },
          content: <FeatureCardGrid cards={CODE_CARDS} />,
        },
        {
          eyebrow: 'QUICK REFERENCE',
          title: 'Most-Used Resources',
          content: <QuickLinkGrid links={QUICK_LINKS} />,
        },
        {
          eyebrow: 'LEARNING CENTER',
          title: 'Certification & Learning Tracks',
          action: { label: 'Learning hub', to: routes.education('ansible') },
          content: (
            <CertTrackGrid
              certs={LEARNING}
              linkFor={() => routes.education('ansible')}
              columns={3}
            />
          ),
        },
      ]}
    />
  );
}

/**
 * Provider Tiers Taxonomy (Stage 2 / Audit P1-1)
 *
 * Categorized by architectural tiers:
 *   - Cloud Providers: Hyperscalers & Private/Hybrid Cloud (AWS, Azure, GCP, VMware)
 *   - Platform Providers: Infrastructure as Code, Automation & Container Runtimes (Terraform, Ansible, Docker)
 *   - Service Providers: Developer Collaboration & Financial Governance (GitHub, FinOps FOCUS 1.4)
 */

export const PROVIDER_TIERS = Object.freeze([
  Object.freeze({
    id: 'cloud',
    title: 'Cloud Providers',
    subtitle: 'Hyperscalers & Private Hybrid Cloud',
    providers: Object.freeze([
      Object.freeze({
        id: 'aws',
        name: 'AWS',
        fullName: 'Amazon Web Services',
        path: '/aws',
        icon: 'cloud',
        badge: 'Public Cloud',
        role: 'Hyperscaler compute, networking & serverless',
      }),
      Object.freeze({
        id: 'azure',
        name: 'Azure',
        fullName: 'Microsoft Azure',
        path: '/azure',
        icon: 'cloud_queue',
        badge: 'Public Cloud',
        role: 'Enterprise cloud, identity & Landing Zones',
      }),
      Object.freeze({
        id: 'gcp',
        name: 'Google Cloud (GCP)',
        fullName: 'Google Cloud Platform',
        path: '/gcp',
        icon: 'cloud_circle',
        badge: 'Public Cloud',
        role: 'Global networking, data & Cloud Foundation',
      }),
      Object.freeze({
        id: 'vmware',
        name: 'VMware',
        fullName: 'VMware Cloud Foundation',
        path: '/vmware',
        icon: 'lan',
        badge: 'Private / Hybrid',
        role: 'On-premises virtualization & hybrid cloud',
      }),
    ]),
  }),
  Object.freeze({
    id: 'platform',
    title: 'Platform Providers',
    subtitle: 'IaC, Automation & Container Runtimes',
    providers: Object.freeze([
      Object.freeze({
        id: 'terraform',
        name: 'Terraform',
        fullName: 'HashiCorp Terraform',
        path: '/terraform',
        icon: 'deployed_code',
        badge: 'IaC',
        role: 'Declarative infrastructure provisioning & AVM',
      }),
      Object.freeze({
        id: 'ansible',
        name: 'Ansible',
        fullName: 'Red Hat Ansible Automation',
        path: '/ansible',
        icon: 'terminal',
        badge: 'Automation',
        role: 'Configuration management & machine orchestration',
      }),
      Object.freeze({
        id: 'docker',
        name: 'Docker',
        fullName: 'Docker & Agent Sandboxes',
        path: '/docker',
        icon: 'layers',
        badge: 'Containers',
        role: 'Container packaging, runtimes & desktop sandboxes',
      }),
    ]),
  }),
  Object.freeze({
    id: 'service',
    title: 'Service Providers',
    subtitle: 'Developer Platforms & Cloud Governance',
    providers: Object.freeze([
      Object.freeze({
        id: 'github',
        name: 'GitHub',
        fullName: 'GitHub & Actions CI/CD',
        path: '/github',
        icon: 'commit',
        badge: 'DevOps & CI/CD',
        role: 'Version control, automated workflows & security',
      }),
      Object.freeze({
        id: 'finops',
        name: 'FinOps',
        fullName: 'FinOps Foundation (FOCUS 1.4)',
        path: '/finops',
        icon: 'payments',
        badge: 'FOCUS 1.4',
        role: 'Cloud cost governance & unit economics',
      }),
    ]),
  }),
]);

/** Flat list of all 9 providers in tier order */
export const ALL_TIER_PROVIDERS = Object.freeze(PROVIDER_TIERS.flatMap((tier) => tier.providers));

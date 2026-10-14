/**
 * Global Search Index for Cmd+K / Ctrl+K Command Palette (Stage 2 / Audit P1-1)
 *
 * Indexed items across Providers (Cloud, Platform, Service), Reference Architectures
 * (including FOCUS 1.4 FinOps), Interactive Tools, Browser Labs, and Certifications.
 */

import { ALL_TIER_PROVIDERS } from './providerTiers';

export const SEARCH_CATEGORIES = Object.freeze({
  PROVIDERS: 'Providers',
  BLUEPRINTS: 'Blueprints',
  TOOLS: 'Interactive Tools',
  LABS: 'Browser Labs',
  CERTS: 'Certifications',
});

export const STATIC_SEARCH_ITEMS = Object.freeze([
  // Providers (Mapped from ALL_TIER_PROVIDERS)
  ...ALL_TIER_PROVIDERS.map((provider) => ({
    id: `provider-${provider.id}`,
    title: provider.name,
    subtitle: `${provider.fullName} • ${provider.role}`,
    category: SEARCH_CATEGORIES.PROVIDERS,
    path: provider.path,
    icon: provider.icon,
    badge: provider.badge,
    keywords: [
      provider.name,
      provider.fullName,
      provider.id,
      provider.badge,
      'cloud',
      'ecosystem',
      'hub',
    ],
  })),

  // Reference Architecture Blueprints
  {
    id: 'blueprint-finops-optimization',
    title: 'Multi-Cloud Cost Optimization',
    subtitle: 'Normalized FOCUS 1.4 cost datasets uniting Azure, AWS, and GCP billing exports',
    category: SEARCH_CATEGORIES.BLUEPRINTS,
    path: '/finops/architecture-designs/multi-cloud-cost-optimization',
    icon: 'payments',
    badge: 'FOCUS 1.4',
    keywords: [
      'finops',
      'cost',
      'focus 1.4',
      'billing',
      'rightsizing',
      'multi-cloud',
      'optimization',
      'budget',
    ],
  },
  {
    id: 'blueprint-azure-2tier',
    title: 'Azure Secure 2-Tier Architecture',
    subtitle: 'Production App Service with private endpoint integration and Azure SQL database',
    category: SEARCH_CATEGORIES.BLUEPRINTS,
    path: '/azure/architecture-designs/secure-2-tier',
    icon: 'cloud_queue',
    badge: 'Azure',
    keywords: ['azure', '2-tier', 'app service', 'sql', 'private endpoint', 'web', 'database'],
  },
  {
    id: 'blueprint-azure-hub-spoke',
    title: 'Azure Enterprise Hub-and-Spoke',
    subtitle: 'Centralized egress, firewall inspection, and transit virtual network peering',
    category: SEARCH_CATEGORIES.BLUEPRINTS,
    path: '/azure/architecture-designs/hub-spoke-network',
    icon: 'lan',
    badge: 'Azure',
    keywords: ['azure', 'hub spoke', 'firewall', 'network', 'peering', 'vnet', 'transit'],
  },
  {
    id: 'blueprint-aws-serverless',
    title: 'AWS Multi-Region Serverless API',
    subtitle: 'API Gateway, AWS Lambda functions, and DynamoDB Global Tables with route failover',
    category: SEARCH_CATEGORIES.BLUEPRINTS,
    path: '/aws/architecture-designs/multi-region-serverless-api',
    icon: 'cloud',
    badge: 'AWS',
    keywords: ['aws', 'serverless', 'lambda', 'dynamodb', 'api gateway', 'multi-region'],
  },
  {
    id: 'blueprint-gcp-cloud-foundation',
    title: 'Google Cloud Global Foundation',
    subtitle:
      'Cloud Armor DDoS protection, Cloud CDN, and Global External Application Load Balancers',
    category: SEARCH_CATEGORIES.BLUEPRINTS,
    path: '/gcp/architecture-designs/global-load-balancing-cdn',
    icon: 'cloud_circle',
    badge: 'Google Cloud',
    keywords: ['gcp', 'google cloud', 'load balancer', 'cloud cdn', 'cloud armor', 'foundation'],
  },
  {
    id: 'blueprint-vmware-hybrid',
    title: 'VMware Cloud Foundation Hybrid',
    subtitle:
      'Software-defined data center virtualization, NSX-T networking, and multi-cloud extension',
    category: SEARCH_CATEGORIES.BLUEPRINTS,
    path: '/vmware/architecture-designs/vmware-hybrid-cloud',
    icon: 'lan',
    badge: 'VMware',
    keywords: ['vmware', 'vcf', 'sddc', 'vsphere', 'nsx', 'hybrid cloud', 'private cloud'],
  },

  // Interactive Tools
  {
    id: 'tool-landing-zone-builder',
    title: 'Landing Zone Builder',
    subtitle: 'Live interactive multi-cloud IaC blueprint generator for Azure, AWS, and GCP',
    category: SEARCH_CATEGORIES.TOOLS,
    path: '/tools/landing-zone',
    icon: 'architecture',
    badge: 'Interactive Tool',
    keywords: [
      'landing zone',
      'generator',
      'terraform',
      'builder',
      'iac',
      'azure default',
      'secure 2-tier',
    ],
  },
  {
    id: 'tool-pricing-comparison',
    title: 'Multi-Cloud Pricing Comparison',
    subtitle:
      'Cross-cloud cost estimator comparing compute, storage, and networking across hyperscalers',
    category: SEARCH_CATEGORIES.TOOLS,
    path: '/tools/comparison',
    icon: 'currency_exchange',
    badge: 'Calculator',
    keywords: ['pricing', 'calculator', 'cost comparison', 'aws vs azure vs gcp', 'estimate'],
  },
  {
    id: 'tool-resource-matrix',
    title: 'Resource Comparison Matrix',
    subtitle: 'Direct service parity matrix mapping services between AWS, Azure, GCP, and VMware',
    category: SEARCH_CATEGORIES.TOOLS,
    path: '/tools/resources',
    icon: 'view_column',
    badge: 'Matrix',
    keywords: ['resource', 'matrix', 'comparison', 'parity', 'aws to azure', 'service mapping'],
  },
  {
    id: 'tool-decision-matrix',
    title: 'Architectural Decision Matrix',
    subtitle:
      'Interactive framework for evaluating multi-cloud architectural tradeoffs and selection',
    category: SEARCH_CATEGORIES.TOOLS,
    path: '/tools/decisions',
    icon: 'tune',
    badge: 'Decisions',
    keywords: ['decision matrix', 'architecture', 'tradeoffs', 'evaluator', 'strategy'],
  },

  // Browser Labs
  {
    id: 'lab-browser-labs-hub',
    title: 'Browser Labs Hub',
    subtitle: 'Interactive hands-on sandbox environments for cloud, Terraform, Ansible, and Docker',
    category: SEARCH_CATEGORIES.LABS,
    path: '/education/labs',
    icon: 'terminal',
    badge: 'Interactive Labs',
    keywords: ['labs', 'browser labs', 'hands-on', 'practice', 'sandbox', 'terminal'],
  },
  {
    id: 'lab-terraform-validate',
    title: 'Terraform Lab: Validate & Plan',
    subtitle: 'In-browser Terraform syntax checking, linting, and declarative plan generation',
    category: SEARCH_CATEGORIES.LABS,
    path: '/education/labs',
    icon: 'deployed_code',
    badge: 'IaC Lab',
    keywords: ['terraform lab', 'validate', 'terraform plan', 'hcl', 'syntax', 'iac'],
  },
  {
    id: 'lab-ansible-syntax',
    title: 'Ansible Lab: Playbook Linting',
    subtitle: 'Interactive YAML playbook syntax validation and Ansible lint execution harness',
    category: SEARCH_CATEGORIES.LABS,
    path: '/education/labs',
    icon: 'terminal',
    badge: 'Automation Lab',
    keywords: ['ansible lab', 'playbook', 'lint', 'yaml', 'syntax check', 'automation'],
  },
  {
    id: 'lab-docker-sandboxes',
    title: 'Docker Sandboxes & Runtimes',
    subtitle: 'Isolated developer sandboxes and reproducible multi-container runtimes',
    category: SEARCH_CATEGORIES.LABS,
    path: '/docker/sandboxes',
    icon: 'layers',
    badge: 'Container Lab',
    keywords: ['docker', 'sandboxes', 'containers', 'dockerfile', 'isolation', 'runtime'],
  },

  // Certifications
  {
    id: 'cert-learn-all-clouds',
    title: 'Learn Any Cloud',
    subtitle: 'Comprehensive multi-cloud certification roadmap and exam preparation directory',
    category: SEARCH_CATEGORIES.CERTS,
    path: '/education',
    icon: 'school',
    badge: 'Education Hub',
    keywords: ['education', 'learn', 'certifications', 'exams', 'roadmap', 'study guide'],
  },
  {
    id: 'cert-azure-az104',
    title: 'Microsoft Azure Administrator (AZ-104)',
    subtitle: 'Identity, governance, virtual networking, compute, and cloud storage management',
    category: SEARCH_CATEGORIES.CERTS,
    path: '/azure/education/az-104',
    icon: 'verified',
    badge: 'Certification',
    keywords: ['az-104', 'azure administrator', 'exam', 'cert', 'identity', 'entra'],
  },
  {
    id: 'cert-azure-az305',
    title: 'Azure Solutions Architect Expert (AZ-305)',
    subtitle: 'Design infrastructure, identity, governance, business continuity, and data storage',
    category: SEARCH_CATEGORIES.CERTS,
    path: '/azure/education/az-305',
    icon: 'verified',
    badge: 'Expert Cert',
    keywords: ['az-305', 'solutions architect', 'azure expert', 'exam', 'design'],
  },
  {
    id: 'cert-aws-saac03',
    title: 'AWS Solutions Architect Associate (SAA-C03)',
    subtitle: 'Design cost-optimized, secure, high-performing, and resilient architectures',
    category: SEARCH_CATEGORIES.CERTS,
    path: '/aws/education/saa-c03',
    icon: 'verified',
    badge: 'Certification',
    keywords: ['saa-c03', 'aws solutions architect', 'exam', 'associate', 'well-architected'],
  },
  {
    id: 'cert-gcp-pca',
    title: 'Google Cloud Professional Cloud Architect',
    subtitle: 'Design, develop, and manage dynamic, secure, robust, and highly scalable solutions',
    category: SEARCH_CATEGORIES.CERTS,
    path: '/gcp/education',
    icon: 'verified',
    badge: 'Professional Cert',
    keywords: ['pca', 'google cloud architect', 'professional', 'gcp certification', 'exam'],
  },
  {
    id: 'cert-terraform-associate',
    title: 'HashiCorp Certified Terraform Associate',
    subtitle: 'Infrastructure as Code fundamentals, modules, workflow, and state management',
    category: SEARCH_CATEGORIES.CERTS,
    path: '/terraform/education',
    icon: 'verified',
    badge: 'IaC Cert',
    keywords: ['terraform associate', 'hashicorp cert', 'exam', 'iac', 'state'],
  },
  {
    id: 'cert-finops-focp',
    title: 'FinOps Certified Practitioner (FOCUS 1.4)',
    subtitle: 'Cloud financial management principles, unit economics, and FOCUS 1.4 compliance',
    category: SEARCH_CATEGORIES.CERTS,
    path: '/finops/education',
    icon: 'verified',
    badge: 'FOCUS 1.4',
    keywords: ['focp', 'finops cert', 'focus 1.4', 'practitioner', 'cost management', 'exam'],
  },
]);

/**
 * Filter search items with substring/fuzzy match on title, subtitle, category, and keywords
 * @param {string} query
 * @param {Array} items
 * @returns {Array} Filtered and scored items
 */
export function filterSearchItems(query, items = STATIC_SEARCH_ITEMS) {
  const clean = (query || '').trim().toLowerCase();
  if (!clean) return items;

  const terms = clean.split(/\s+/).filter(Boolean);

  return items
    .map((item) => {
      let score = 0;
      const titleLower = item.title.toLowerCase();
      const subtitleLower = item.subtitle.toLowerCase();
      const categoryLower = item.category.toLowerCase();
      const keywords = item.keywords || [];

      for (const term of terms) {
        if (titleLower.includes(term)) {
          score += titleLower.startsWith(term) ? 20 : 10;
        } else if (categoryLower.includes(term)) {
          score += 5;
        } else if (keywords.some((k) => k.toLowerCase().includes(term))) {
          score += 6;
        } else if (subtitleLower.includes(term)) {
          score += 3;
        } else {
          return null;
        }
      }

      return { item, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map((result) => result.item);
}

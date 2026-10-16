/**
 * Global Search Index for Cmd+K / Ctrl+K Command Palette (Stage 2 / Audit P1-1)
 *
 * Indexed items across Providers (Cloud, Platform, Service), Provider Hubs & Sections,
 * Reference Architectures (including FOCUS 1.4 FinOps), Interactive Tools & AddOns,
 * Browser Labs (from data/labs/catalogue.js), and Certifications (including the
 * Azure certification catalogue).
 */

import { ALL_TIER_PROVIDERS } from './providerTiers';
import { availableLabs, labPanePath, labsPath } from './labs/catalogue';
import { addonPanePath, availableAddons } from './addons/catalogue';
import { certifications as azureCertifications } from './azure/certifications';

export const SEARCH_CATEGORIES = Object.freeze({
  PROVIDERS: 'Providers',
  SECTIONS: 'Hubs & Sections',
  BLUEPRINTS: 'Blueprints',
  TOOLS: 'Interactive Tools',
  LABS: 'Browser Labs',
  CERTS: 'Certifications',
});

const CURATED_AZURE_CERT_SLUGS = new Set(['az-104', 'az-305']);

const PROVIDER_SECTION_ITEMS = ALL_TIER_PROVIDERS.flatMap((provider) => {
  const { id, name, fullName } = provider;
  const baseKeywords = [name, fullName, id];

  const items = [
    {
      id: `section-${id}-news`,
      title: `${name} News & RSS`,
      subtitle: `Curated platform updates, release notes, and RSS feeds for ${name}`,
      category: SEARCH_CATEGORIES.SECTIONS,
      path: `/${id}/rss`,
      icon: 'newspaper',
      badge: name,
      keywords: [...baseKeywords, 'news', 'rss', 'updates', 'releases', 'announcements'],
    },
    {
      id: `section-${id}-blog`,
      title: `${name} Blogs & Articles`,
      subtitle: `Deep-dive engineering articles, guides, and field notes for ${name}`,
      category: SEARCH_CATEGORIES.SECTIONS,
      path: `/${id}/blog`,
      icon: 'article',
      badge: name,
      keywords: [...baseKeywords, 'blog', 'blogs', 'articles', 'posts', 'guides'],
    },
    {
      id: `section-${id}-coder-corner`,
      title: `${name} Coder Corner`,
      subtitle: `Hands-on code patterns, automation snippets, and engineering recipes for ${name}`,
      category: SEARCH_CATEGORIES.SECTIONS,
      path: `/${id}/coder-corner`,
      icon: 'code_blocks',
      badge: name,
      keywords: [...baseKeywords, 'coder corner', 'snippets', 'recipes', 'patterns'],
    },
    {
      id: `section-${id}-learn`,
      title: `${name} Learn & Certifications`,
      subtitle: `Learning paths, exam study guides, and training resources for ${name}`,
      category: SEARCH_CATEGORIES.SECTIONS,
      path: `/${id}/education`,
      icon: 'school',
      badge: name,
      keywords: [...baseKeywords, 'learn', 'education', 'training', 'certifications', 'courses'],
    },
    {
      id: `section-${id}-labs`,
      title: `${name} Browser Labs`,
      subtitle: `Interactive browser container labs and hands-on exercises for ${name}`,
      category: SEARCH_CATEGORIES.LABS,
      path: labsPath(id),
      icon: 'terminal',
      badge: `${name} Labs`,
      keywords: [...baseKeywords, 'labs', 'browser labs', 'hands-on', 'workspace', 'sandbox'],
    },
  ];

  if (['azure', 'aws', 'gcp', 'vmware', 'finops'].includes(id)) {
    items.push(
      {
        id: `section-${id}-architecture`,
        title: `${name} Architecture Designs`,
        subtitle: `Reference architectures, topology diagrams, and design patterns for ${name}`,
        category: SEARCH_CATEGORIES.SECTIONS,
        path: `/${id}/architecture-designs`,
        icon: 'account_tree',
        badge: name,
        keywords: [
          ...baseKeywords,
          'architecture',
          'designs',
          'diagrams',
          'blueprints',
          'topology',
        ],
      },
      {
        id: `section-${id}-frameworks`,
        title: `${name} Frameworks`,
        subtitle: `Well-Architected and Cloud Adoption frameworks, pillars, and governance for ${name}`,
        category: SEARCH_CATEGORIES.SECTIONS,
        path: `/${id}/frameworks`,
        icon: 'Rule',
        badge: name,
        keywords: [
          ...baseKeywords,
          'frameworks',
          'well-architected',
          'caf',
          'governance',
          'pillars',
        ],
      }
    );
  }

  if (['azure', 'aws', 'gcp', 'vmware', 'ansible', 'docker'].includes(id)) {
    items.push({
      id: `section-${id}-podcast`,
      title: `${name} Architecture Podcast`,
      subtitle: `Audio architecture episodes and Listen & Learn briefings for ${name}`,
      category: SEARCH_CATEGORIES.SECTIONS,
      path: `/${id}/audio-architecture`,
      icon: 'podcasts',
      badge: name,
      keywords: [...baseKeywords, 'podcast', 'audio', 'episodes', 'listen'],
    });
  }

  if (['github', 'terraform', 'docker', 'ansible'].includes(id)) {
    items.push(
      {
        id: `section-${id}-code`,
        title: `${name} Code & Templates`,
        subtitle: `Production-ready code repositories, configurations, and patterns for ${name}`,
        category: SEARCH_CATEGORIES.SECTIONS,
        path: `/${id}/code`,
        icon: 'code',
        badge: name,
        keywords: [...baseKeywords, 'code', 'templates', 'repositories', 'examples'],
      },
      {
        id: `section-${id}-tools`,
        title: `${name} Tools & Utilities`,
        subtitle: `CLI utilities, linters, scanners, and developer tooling for ${name}`,
        category: SEARCH_CATEGORIES.TOOLS,
        path: `/${id}/tools`,
        icon: 'build',
        badge: `${name} Tools`,
        keywords: [...baseKeywords, 'tools', 'utilities', 'cli', 'linter'],
      }
    );
  }

  return items;
});

export const STATIC_SEARCH_ITEMS = Object.freeze([
  // Providers (Mapped from ALL_TIER_PROVIDERS — exact 9 providers)
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

  // Interactive Tools & AddOns
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
  {
    id: 'tool-finops-focus-validator',
    title: 'FinOps Schema Validator & Spec',
    subtitle:
      'FinOps Open Cost & Usage Specification (FOCUS 1.4) billing normalization and schema validator',
    category: SEARCH_CATEGORIES.TOOLS,
    path: '/finops/focus',
    icon: 'center_focus_strong',
    badge: 'FOCUS 1.4',
    keywords: [
      'focus 1.4',
      'finops schema',
      'validator',
      'billing data',
      'cost export',
      'open cost',
    ],
  },
  {
    id: 'tool-finops-tools',
    title: 'FinOps Tools & Calculators',
    subtitle: 'Cost allocation, anomaly detection, and cloud financial management tools',
    category: SEARCH_CATEGORIES.TOOLS,
    path: '/finops/tools',
    icon: 'calculate',
    badge: 'FinOps Tools',
    keywords: ['finops', 'tools', 'cost', 'budget', 'allocation'],
  },
  ...availableAddons.map((addon) => ({
    id: `addon-${addon.id}`,
    title: addon.menuLabel ? `${addon.menuLabel} (${addon.title})` : addon.title,
    subtitle: addon.summary,
    category: SEARCH_CATEGORIES.TOOLS,
    path: addonPanePath(addon),
    icon: 'handyman',
    badge: 'Interactive Tool',
    keywords: [
      addon.id,
      addon.title,
      ...(addon.menuLabel ? [addon.menuLabel] : []),
      ...addon.providers,
      ...addon.technology,
      'assessment',
      'tool',
    ],
  })),

  // Browser Labs (Curated + Full Lab Catalogue)
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
    path: '/terraform/education/labs/terraform-validate-walkthrough',
    icon: 'deployed_code',
    badge: 'IaC Lab',
    keywords: ['terraform lab', 'validate', 'terraform plan', 'hcl', 'syntax', 'iac'],
  },
  {
    id: 'lab-ansible-syntax',
    title: 'Ansible Lab: Playbook Linting',
    subtitle: 'Interactive YAML playbook syntax validation and Ansible lint execution harness',
    category: SEARCH_CATEGORIES.LABS,
    path: '/ansible/education/labs/ansible-syntax-check-walkthrough',
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
  ...availableLabs.map((lab) => ({
    id: `lab-catalogue-${lab.id}`,
    title: lab.title,
    subtitle: lab.summary,
    category: SEARCH_CATEGORIES.LABS,
    path: labPanePath(lab.providers[0] ?? null, lab.id),
    icon: 'terminal',
    badge: `${(lab.providers[0] || 'Cloud').toUpperCase()} Lab`,
    keywords: [
      lab.id,
      ...lab.providers,
      ...lab.technology,
      ...lab.tools,
      'lab',
      'hands-on',
      'workspace',
    ],
  })),

  // Certifications (Curated + Full Active Azure Catalogue)
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
  {
    id: 'cert-finops-fofa',
    title: 'FinOps Certified FOCUS Analyst (FOCUS 1.4)',
    subtitle:
      'Cross-cloud billing dataset ingestion, interpretation, and FOCUS 1.4 schema compliance',
    category: SEARCH_CATEGORIES.CERTS,
    path: '/finops/education',
    icon: 'verified',
    badge: 'FOCUS 1.4',
    keywords: ['fofa', 'focus analyst', 'focus 1.4', 'billing data', 'usage datasets', 'exam'],
  },
  ...azureCertifications
    .filter((cert) => cert.status !== 'retired' && !CURATED_AZURE_CERT_SLUGS.has(cert.slug))
    .map((cert) => ({
      id: `cert-azure-${cert.slug}`,
      title: `${cert.title} (${cert.code})`,
      subtitle: cert.description,
      category: SEARCH_CATEGORIES.CERTS,
      path: `/azure/education/${cert.slug}`,
      icon: 'verified',
      badge: `Azure ${cert.level}`,
      keywords: [
        cert.code,
        cert.slug,
        cert.title,
        cert.level,
        'azure',
        'certification',
        'exam',
        ...(cert.topics || []),
      ],
    })),

  // Provider Hubs, Dedicated Sections & Site Pages
  ...PROVIDER_SECTION_ITEMS,
  {
    id: 'section-terraform-modules',
    title: 'Terraform Verified Modules',
    subtitle: 'Reusable, validated Terraform modules for Azure, AWS, and Google Cloud',
    category: SEARCH_CATEGORIES.SECTIONS,
    path: '/terraform/modules',
    icon: 'view_module',
    badge: 'Terraform',
    keywords: ['terraform', 'modules', 'avm', 'registry', 'iac', 'reusable'],
  },
  {
    id: 'section-github-workflows',
    title: 'GitHub Actions & Workflows',
    subtitle: 'CI/CD pipelines, reusable GitHub Actions workflows, and OIDC deployment patterns',
    category: SEARCH_CATEGORIES.SECTIONS,
    path: '/github/workflows',
    icon: 'account_tree',
    badge: 'GitHub',
    keywords: ['github', 'workflows', 'actions', 'ci/cd', 'pipelines', 'oidc'],
  },
  {
    id: 'section-docker-building-images',
    title: 'Docker Building Images Guide',
    subtitle: 'Multi-stage builds, layer caching, BuildKit, and minimal container base images',
    category: SEARCH_CATEGORIES.SECTIONS,
    path: '/docker/building-images',
    icon: 'layers',
    badge: 'Docker',
    keywords: ['docker', 'building images', 'dockerfile', 'multi-stage', 'buildkit'],
  },
  {
    id: 'section-docker-desktop',
    title: 'Docker Desktop Guide',
    subtitle: 'Local container development, Compose watch, and resource configuration',
    category: SEARCH_CATEGORIES.SECTIONS,
    path: '/docker/desktop',
    icon: 'desktop_windows',
    badge: 'Docker',
    keywords: ['docker', 'docker desktop', 'compose', 'containers', 'local dev'],
  },
  {
    id: 'section-site-about',
    title: 'About HybridCloudWorks',
    subtitle: 'Platform mission, multi-cloud architecture coverage, and engineering principles',
    category: SEARCH_CATEGORIES.SECTIONS,
    path: '/about',
    icon: 'info',
    badge: 'Site',
    keywords: ['about', 'hybridcloudworks', 'mission', 'platform'],
  },
  {
    id: 'section-site-contact',
    title: 'Contact HybridCloudWorks',
    subtitle: 'Get in touch with the HybridCloudWorks team for questions or feedback',
    category: SEARCH_CATEGORIES.SECTIONS,
    path: '/contact',
    icon: 'mail',
    badge: 'Site',
    keywords: ['contact', 'support', 'feedback', 'reach out'],
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

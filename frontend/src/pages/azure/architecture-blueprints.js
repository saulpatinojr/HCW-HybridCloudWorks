/**
 * The Azure reference architectures this page renders whatever the content
 * API returns.
 *
 * WHY THIS IS ITS OWN FILE. These blueprints used to be declared inside
 * azure/ArchitecturePage.jsx, which made "can this page be empty?" a question
 * only a human reading JSX could answer — and the sitemap has to answer it at
 * build time. `/vmware/architecture-designs` was advertised while rendering
 * nothing (issue #373) precisely because the pre-render could not tell a
 * provider with hardcoded blueprints from one without.
 *
 * So the answer moves somewhere a build script can read it. `sitemapRoutes` in
 * frontend/scripts/prerender.mjs imports every `architecture-blueprints.js`
 * under src/pages and counts what it exports; a provider whose module is empty
 * AND whose API count is zero has an empty page and loses its sitemap entry.
 * Nothing restates the count, so adding or removing a blueprint here is
 * immediately true for the sitemap as well as for the page.
 *
 * Plain data, no JSX and no `@/` imports, because that build script imports
 * this file directly in Node with no bundler and no alias resolution.
 */
export const staticBlueprints = [
  {
    icon: 'shield_lock',
    category: 'Security',
    categoryColor: 'blue',
    title: 'Secure 2-Tier Application on Azure',
    slug: 'secure-2-tier-azure',
    description:
      'A simple, secure and scalable architecture using Application Gateway with WAF, segmented VNet subnets with NSGs, and a Private Endpoint to Azure SQL.',
    rpo: '< 15 min',
    rto: '< 30 min',
    level: '300',
    cost: '$680/mo',
    costColor: 'green',
  },
  {
    icon: 'hub',
    category: 'Networking',
    categoryColor: 'blue',
    title: 'Enterprise Hub-and-Spoke Landing Zone',
    slug: 'enterprise-hub-spoke-landing-zone',
    description:
      'Reference architecture for centralized connectivity, policy-driven segmentation, and shared security services across enterprise subscriptions.',
    rpo: '< 15 min',
    rto: '< 1 hr',
    level: '400',
    cost: '$2.1k/mo',
  },
  {
    icon: 'cloud_sync',
    category: 'Migration',
    categoryColor: 'purple',
    title: 'Azure VMware Estate Migration',
    slug: 'azure-vmware-estate-migration',
    description:
      'Phased migration blueprint using Azure VMware Solution, Recovery Services, and dependency mapping for low-risk cutovers.',
    rpo: '24 hr',
    rto: '4 hr',
    level: '200',
    cost: '$1.4k/mo',
    costColor: 'green',
  },
  {
    icon: 'monitoring',
    category: 'FinOps',
    categoryColor: 'green',
    title: 'FinOps Guardrails for Azure Subscriptions',
    slug: 'finops-guardrails-azure',
    description:
      'Policy and budget-control pattern with Cost Management exports, Azure Policy enforcement, and automated anomaly alerts.',
    rpo: '1 hr',
    rto: '2 hr',
    level: '300',
    cost: '$950/mo',
    costColor: 'green',
  },
  {
    icon: 'database',
    category: 'Database',
    categoryColor: 'orange',
    title: 'Global Data Tier with Cosmos DB + SQL',
    slug: 'global-data-tier-cosmos-sql',
    description:
      'Multi-region data architecture combining Cosmos DB and Azure SQL with geo-replication and strict consistency controls.',
    rpo: '< 1s',
    rto: '< 1 min',
    level: '400',
    cost: '$3.2k/mo',
  },
  {
    icon: 'security',
    category: 'Security',
    categoryColor: 'red',
    title: 'Zero Trust Identity Control Plane',
    slug: 'zero-trust-identity-control-plane',
    description:
      'Identity-first architecture using Entra ID, Conditional Access, PIM, and Defender for Cloud to enforce least privilege at scale.',
    rpo: 'N/A',
    rto: 'N/A',
    level: '300',
    cost: '$780/mo',
    costColor: 'green',
  },
  {
    icon: 'api',
    category: 'Serverless',
    categoryColor: 'blue',
    title: 'Event-Driven Serverless Integration Mesh',
    slug: 'event-driven-serverless-mesh',
    description:
      'Serverless integration pattern based on Event Grid, Functions, and Service Bus for near real-time distributed workflows.',
    rpo: '< 5 min',
    rto: 'Immediate',
    level: '200',
    cost: '$420/mo',
    costColor: 'green',
  },
];


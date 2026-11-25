/**
 * The AWS reference architectures this page renders whatever the content
 * API returns.
 *
 * WHY THIS IS ITS OWN FILE. These blueprints used to be declared inside
 * aws/ArchitecturePage.jsx, which made "can this page be empty?" a question
 * only a human reading JSX could answer — and the sitemap has to answer it at
 * build time. `/vmware/architecture-designs` was advertised while rendering
 * nothing (issue #373) precisely because the pre-render could not tell a
 * provider with hardcoded blueprints from one without.
 *
 * So the answer moves somewhere a build script can read it. `sitemapRoutes` in
 * frontend/scripts/prerender-routes.mjs imports every `architecture-blueprints.js`
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
    icon: 'public',
    category: 'Networking',
    categoryColor: 'blue',
    title: 'Global Load Balancing',
    slug: 'global-load-balancing',
    description:
      'High-availability routing using ELB and Route 53 with multi-region failover and health checks.',
    rpo: '< 1 min',
    rto: '< 5 min',
    level: '300',
    cost: '$1.2k/mo',
    costColor: 'blue',
  },
  {
    icon: 'rebase_edit',
    category: 'Disaster Recovery',
    categoryColor: 'red',
    title: 'Multi-Region DR',
    slug: 'multi-region-dr',
    description:
      'Active-Passive setup using RDS Aurora Global Database and S3 Cross-Region Replication for mission-critical apps.',
    rpo: '< 15 min',
    rto: '< 30 min',
    level: '400',
    cost: '$3.8k/mo',
    costColor: 'red',
  },
  {
    icon: 'hub',
    category: 'Containers',
    categoryColor: 'orange',
    title: 'Container Orchestration',
    slug: 'container-orchestration',
    description:
      'Modern microservices deployment on ECS Fargate with automated scaling and service discovery.',
    rpo: 'N/A',
    rto: '< 5 min',
    level: '300',
    cost: '$2.2k/mo',
  },
  {
    icon: 'api',
    category: 'Serverless',
    categoryColor: 'blue',
    title: 'Serverless API',
    slug: 'serverless-api',
    description:
      'Cost-optimized event-driven backend using Lambda, API Gateway, and DynamoDB for massive scale.',
    rpo: 'Real-time',
    rto: 'N/A',
    level: '200',
    cost: '$400/mo',
    costColor: 'green',
  },
  {
    icon: 'database',
    category: 'Analytics',
    categoryColor: 'purple',
    title: 'Data Lake Architecture',
    slug: 'data-lake',
    description:
      'Scalable data storage and analytics pipeline using S3, Glue, and Athena for serverless queries.',
    rpo: '24 hr',
    rto: '4 hr',
    level: '300',
    cost: '$800/mo',
    costColor: 'green',
  },
  {
    icon: 'settings_input_component',
    category: 'Connectivity',
    categoryColor: 'blue',
    title: 'Hybrid Connectivity',
    slug: 'hybrid-connectivity',
    description:
      'Secure enterprise connection via Direct Connect and Transit Gateway for hybrid cloud workloads.',
    rpo: 'N/A',
    rto: 'Immediate',
    level: '400',
    cost: '$2.4k/mo',
  },
];

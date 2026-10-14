/**
 * The Google Cloud reference architectures this page renders whatever the content
 * API returns.
 *
 * WHY THIS IS ITS OWN FILE. These blueprints used to be declared inside
 * gcp/ArchitecturePage.jsx, which made "can this page be empty?" a question
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
    id: 1,
    icon: 'hub',
    category: 'Compute',
    categoryColor: 'text-blue-400',
    title: 'Global Load Balancing',
    slug: 'global-load-balancing',
    description:
      'Global external HTTP(S) load balancing with Cloud Armor, regional failover policies, and CDN edge caching for resilient web workloads.',
    rpo: '1h',
    rto: '30m',
    level: 'Production',
    cost: '$2,400/mo',
    costColor: 'text-green-400',
    featured: true,
    waf: 96,
  },
  {
    id: 2,
    icon: 'storage',
    category: 'Data',
    categoryColor: 'text-yellow-400',
    title: 'BigQuery Data Lake',
    slug: 'bigquery-data-lake',
    description:
      'Unified analytics architecture combining BigQuery, Dataplex, and Cloud Storage lifecycle controls for governed enterprise reporting.',
    rpo: '4h',
    rto: '2h',
    level: 'Production',
    cost: '$1,800/mo',
    costColor: 'text-green-400',
    waf: 93,
  },
  {
    id: 3,
    icon: 'computer',
    category: 'Networking',
    categoryColor: 'text-purple-400',
    title: 'Hybrid Interconnect',
    slug: 'hybrid-interconnect',
    description:
      'Low-latency private connectivity pattern using Dedicated Interconnect, Cloud Router, and HA VPN fallback for critical hybrid systems.',
    rpo: '15m',
    rto: '5m',
    level: 'Mission Critical',
    cost: '$3,600/mo',
    costColor: 'text-orange-400',
    waf: 98,
  },
  {
    id: 4,
    icon: 'psychology',
    category: 'AI/ML',
    categoryColor: 'text-pink-400',
    title: 'Vertex AI Pipeline',
    slug: 'vertex-ai-pipeline',
    description:
      'End-to-end MLOps blueprint with Vertex AI Pipelines, Feature Store, and model registry promotion across dev/stage/prod projects.',
    rpo: '1h',
    rto: '30m',
    level: 'Production',
    cost: '$2,200/mo',
    costColor: 'text-green-400',
    waf: 91,
  },
  {
    id: 5,
    icon: 'shield',
    category: 'Security',
    categoryColor: 'text-red-400',
    title: 'Zero Trust Security',
    slug: 'zero-trust-security',
    description:
      'Identity-aware proxy and BeyondCorp Enterprise architecture enforcing context-aware access and workload isolation across environments.',
    rpo: '30m',
    rto: '15m',
    level: 'Mission Critical',
    cost: '$2,800/mo',
    costColor: 'text-orange-400',
    waf: 99,
  },
  {
    id: 6,
    icon: 'cloud',
    category: 'Serverless',
    categoryColor: 'text-cyan-400',
    title: 'Cloud Run Microservices',
    slug: 'cloud-run-microservices',
    description:
      'Containerized microservices pattern using Cloud Run, Eventarc, and Pub/Sub with autoscaling and per-service least-privilege IAM.',
    rpo: '1h',
    rto: '20m',
    level: 'Production',
    cost: '$1,200/mo',
    costColor: 'text-green-400',
    waf: 94,
  },
];

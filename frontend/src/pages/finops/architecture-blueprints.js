/**
 * The FinOps reference architectures this page renders whatever the content
 * API returns.
 *
 * WHY THIS IS ITS OWN FILE. These blueprints used to be declared inside
 * finops/ArchitecturePage.jsx, which made "can this page be empty?" a question
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
    icon: 'trending_down',
    category: 'Cost Analysis',
    categoryColor: 'text-emerald-400',
    title: 'Multi-Cloud Cost Optimization',
    slug: 'multi-cloud-cost-optimization',
    description:
      'Cross-cloud optimization architecture with shared tagging taxonomy, cost telemetry normalization, and rightsizing recommendation pipelines.',
    rpo: '1h',
    rto: '30m',
    level: 'Production',
    cost: '$1,800/mo',
    costColor: 'text-green-400',
    featured: true,
    waf: 94,
  },
  {
    id: 2,
    icon: 'analytics',
    category: 'Reporting',
    categoryColor: 'text-blue-400',
    title: 'Real-time Cost Dashboard',
    slug: 'real-time-cost-dashboard',
    description:
      'Streaming dashboard pattern for near real-time cloud spend visibility across business units, products, and environments.',
    rpo: '15m',
    rto: '5m',
    level: 'Production',
    cost: '$1,200/mo',
    costColor: 'text-green-400',
    waf: 92,
  },
  {
    id: 3,
    icon: 'calculate',
    category: 'Billing',
    categoryColor: 'text-purple-400',
    title: 'Chargeback & Allocation',
    slug: 'chargeback-allocation',
    description:
      'Allocation framework for unit-economics reporting with cost ownership, shared resource split rules, and monthly chargeback automation.',
    rpo: '1d',
    rto: '4h',
    level: 'Standard',
    cost: '$900/mo',
    costColor: 'text-green-400',
    waf: 89,
  },
  {
    id: 4,
    icon: 'optimization',
    category: 'Automation',
    categoryColor: 'text-yellow-400',
    title: 'RI & Savings Plan Automation',
    slug: 'ri-savings-plan-automation',
    description:
      'Automation workflow for committed-use planning, purchase simulation, and policy-based guardrails to reduce avoidable spend.',
    rpo: '6h',
    rto: '2h',
    level: 'Production',
    cost: '$2,100/mo',
    costColor: 'text-orange-400',
    waf: 95,
  },
  {
    id: 5,
    icon: 'policy',
    category: 'Governance',
    categoryColor: 'text-red-400',
    title: 'Budget & Policy Framework',
    slug: 'budget-policy-framework',
    description:
      'Governance architecture tying budget thresholds to policy enforcement, alert routing, and escalation workflows by cost center.',
    rpo: '24h',
    rto: '1h',
    level: 'Mission Critical',
    cost: '$1,600/mo',
    costColor: 'text-orange-400',
    waf: 97,
  },
  {
    id: 6,
    icon: 'lightbulb',
    category: 'Optimization',
    categoryColor: 'text-pink-400',
    title: 'Waste Identification & Alerts',
    slug: 'waste-identification-alerts',
    description:
      'Continuous anomaly and idle-resource detection pipeline with actionable alerts for compute, storage, and network waste classes.',
    rpo: '30m',
    rto: '15m',
    level: 'Production',
    cost: '$1,400/mo',
    costColor: 'text-green-400',
    waf: 93,
  },
];

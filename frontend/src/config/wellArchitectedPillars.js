// One pillar: our stable id, the vendor's label, and the vendor's page for it.
const pillar = (id, label, docUrl) => ({ id, label, docUrl });

/**
 * Official Well-Architected pillar sets, per cloud provider.
 *
 * Reference data about published vendor frameworks, so it lives as code for the
 * same reasons the certification catalogue does (public-pages-handoff §2.3): it
 * must be reviewable in a diff, it is needed at build time by tests, and a
 * scoring scheme whose axes can change without a commit is one nobody can
 * audit.
 *
 * **Every set below was read off the vendor's own documentation on 2026-07-30,
 * not recalled.** That matters because the counts are not what you would guess:
 * AWS and Google both have six, Azure has five, and Google's set is not a
 * superset of Azure's — "Performance optimization" and "Security, privacy, and
 * compliance" are Google's names, not Azure's. Publishing a score against a
 * pillar a vendor does not define would be a claim we could not defend, so
 * `frameworkUrl` is on every entry to say where the definition came from.
 *
 * `id` is ours and must stay stable — stored assessments reference it forever.
 * `label` is the vendor's wording and may be corrected to match theirs.
 */
export const WELL_ARCHITECTED = {
  aws: {
    provider: 'aws',
    frameworkName: 'AWS Well-Architected Framework',
    frameworkUrl: 'https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html',
    pillars: [
      pillar(
        'operationalExcellence',
        'Operational Excellence',
        'https://docs.aws.amazon.com/wellarchitected/latest/framework/operational-excellence.html'
      ),
      pillar(
        'security',
        'Security',
        'https://docs.aws.amazon.com/wellarchitected/latest/framework/security.html'
      ),
      pillar(
        'reliability',
        'Reliability',
        'https://docs.aws.amazon.com/wellarchitected/latest/framework/reliability.html'
      ),
      pillar(
        'performanceEfficiency',
        'Performance Efficiency',
        'https://docs.aws.amazon.com/wellarchitected/latest/framework/performance-efficiency.html'
      ),
      pillar(
        'costOptimization',
        'Cost Optimization',
        'https://docs.aws.amazon.com/wellarchitected/latest/framework/cost-optimization.html'
      ),
      pillar(
        'sustainability',
        'Sustainability',
        'https://docs.aws.amazon.com/wellarchitected/latest/framework/sustainability.html'
      ),
    ],
  },

  azure: {
    provider: 'azure',
    frameworkName: 'Azure Well-Architected Framework',
    frameworkUrl: 'https://learn.microsoft.com/en-us/azure/well-architected/',
    // Five, not six. Azure has no Sustainability pillar — it treats
    // sustainability as a workload guide instead.
    pillars: [
      pillar(
        'reliability',
        'Reliability',
        'https://learn.microsoft.com/en-us/azure/well-architected/reliability/'
      ),
      pillar(
        'security',
        'Security',
        'https://learn.microsoft.com/en-us/azure/well-architected/security/'
      ),
      pillar(
        'costOptimization',
        'Cost Optimization',
        'https://learn.microsoft.com/en-us/azure/well-architected/cost-optimization/'
      ),
      pillar(
        'operationalExcellence',
        'Operational Excellence',
        'https://learn.microsoft.com/en-us/azure/well-architected/operational-excellence/'
      ),
      pillar(
        'performanceEfficiency',
        'Performance Efficiency',
        'https://learn.microsoft.com/en-us/azure/well-architected/performance-efficiency/'
      ),
    ],
  },

  gcp: {
    provider: 'gcp',
    frameworkName: 'Google Cloud Well-Architected Framework',
    frameworkUrl: 'https://docs.cloud.google.com/architecture/framework',
    pillars: [
      pillar(
        'operationalExcellence',
        'Operational excellence',
        'https://docs.cloud.google.com/architecture/framework/operational-excellence'
      ),
      {
        // Google's pillar is broader than the AWS/Azure "Security" pillar and
        // is named accordingly. Kept verbatim rather than normalised.
        id: 'securityPrivacyCompliance',
        label: 'Security, privacy, and compliance',
        docUrl: 'https://docs.cloud.google.com/architecture/framework/security',
      },
      pillar(
        'reliability',
        'Reliability',
        'https://docs.cloud.google.com/architecture/framework/reliability'
      ),
      pillar(
        'costOptimization',
        'Cost optimization',
        'https://docs.cloud.google.com/architecture/framework/cost-optimization'
      ),
      {
        // "Performance optimization", not Azure/AWS's "Performance efficiency".
        id: 'performanceOptimization',
        label: 'Performance optimization',
        docUrl: 'https://docs.cloud.google.com/architecture/framework/performance-optimization',
      },
      pillar(
        'sustainability',
        'Sustainability',
        'https://docs.cloud.google.com/architecture/framework/sustainability'
      ),
    ],
  },

  /*
   * VMware is deliberately absent, and it is not an oversight.
   *
   * The VMware Cloud Well-Architected Framework's five pillars are Plan, Build,
   * Secure, Modernize and Operate — **lifecycle phases, not quality
   * attributes**. Scoring a design 0–100 on "Plan" does not mean what scoring it
   * on "Reliability" means, and putting the two on the same radar would imply a
   * comparability that does not exist.
   *
   * Nothing is blocked by this: VMware has no architecture designs and no
   * blueprint data. Decide the shape when there is a design to score — the
   * honest options are to score VMware designs against the framework of the
   * cloud they run on (AVS → Azure, VMC → AWS), or to give VMware its own
   * non-radar presentation that respects the lifecycle model.
   */
};

/** Providers that can carry a Well-Architected assessment today. */
export const ASSESSABLE_PROVIDERS = Object.keys(WELL_ARCHITECTED);

/** The framework definition for a provider, or null when it has none. */
export function getFramework(provider) {
  return WELL_ARCHITECTED[String(provider || '').toLowerCase()] || null;
}

/** Pillar ids for a provider, in the vendor's own order. */
export function getPillarIds(provider) {
  return (getFramework(provider)?.pillars || []).map((pillar) => pillar.id);
}

/**
 * Is this pillar id part of this provider's framework?
 *
 * The guard the AI scorer needs: a model asked for Azure pillars will happily
 * return `sustainability`, which Azure does not define, and storing it would
 * publish a score against a pillar the vendor has no such thing as.
 */
export function isPillarOfProvider(provider, pillarId) {
  return getPillarIds(provider).includes(pillarId);
}

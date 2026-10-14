/**
 * The nine providers on the home page strip, in the order they appear, and
 * the text the strip's frame shows for each (owner request 2026-09-28).
 *
 * Data, not JSX, so the copy can be read, reviewed and tested in one place:
 * `providerGuide.test.js` pins the providers, their rows, their types, their
 * websites and a length ceiling, and `public-copy.test.js` scans every string
 * here because this file is under `components/`.
 *
 * TYPES. Three kinds, woven into each description rather than shown as a
 * separate label: Azure, AWS, Google Cloud and VMware are cloud providers;
 * GitHub and FinOps are framework providers; Terraform, Docker and Ansible
 * are service providers.
 *
 * "HOW WE USE IT" IS A CLAIM ABOUT THIS REPOSITORY, so each one was checked
 * against it when written:
 *   - Azure: the site is hosted on it (infra/); its Learn pages carry study
 *     guides built from Microsoft's exam outlines (src/data/azure/study-guides);
 *     the Landing Zone Builder assembles an Azure landing zone (/tools/landing-zone).
 *   - AWS and Google Cloud: blueprints (pages/<provider>/architecture-blueprints.js),
 *     certification catalogues with learning paths, and news feeds
 *     (functions/src/lib/rss/feeds.js). Neither hosts anything here.
 *   - VMware: reference designs, the VCF/VVD/NSX frameworks and seven
 *     certification tracks (pages/vmware, data/vmware/education.js). It has no
 *     blueprints (its architecture-blueprints.js is empty), so none is claimed.
 *   - GitHub: the repository, the workflows that test and deploy
 *     (.github/workflows), GitHub sign-in for lab workspaces, and the container
 *     registry the lab image is published to (publish-lab-image.yml).
 *   - FinOps: the FinOps pages — FOCUS, frameworks, the maturity model, the
 *     allocation and anomaly blueprints and the tools page (pages/finops).
 *   - Terraform: infra/ is Terraform; so is the lab workspace template
 *     (lab-host/coder/templates/hcw-lab); the Landing Zone Builder's download
 *     is Terraform on Azure Verified Modules; two labs validate Terraform.
 *   - Docker: lab-image/Dockerfile builds hcw-lab in stages; each lab workspace
 *     is a container from it; Docker Sandboxes on /education/labs.
 *   - Ansible: lab-host/ansible configures the lab host (hardening, the
 *     container runtime, the workspace service); the Ansible lab lints that
 *     same playbook.
 * Change the repository and one of these can stop being true; change the
 * sentence with it.
 *
 * LENGTH. The frame is four lines tall at desktop width and never changes
 * height, so every description must fit in four lines there.
 * DESCRIPTION_MAX_CHARS is the test's proxy for that, measured in a browser
 * at the frame's desktop width (see the test for the numbers).
 */

/** The three kinds of provider, as the descriptions name them. */
export const PROVIDER_TYPES = Object.freeze({
  cloud: 'Cloud Provider',
  framework: 'Framework Provider',
  service: 'Service Provider',
});

/** What the frame says before anyone has pointed at a provider. */
export const PROVIDER_GUIDE_DEFAULT =
  'Point at or tap a provider to see what it is and how we use it.';

/** The longest a description may be and still fit four lines at desktop width. */
export const DESCRIPTION_MAX_CHARS = 320;

export const PROVIDER_GUIDE = Object.freeze([
  Object.freeze({
    provider: 'azure',
    label: 'Azure',
    name: 'Microsoft Azure',
    type: 'cloud',
    row: 1,
    website: 'https://azure.microsoft.com',
    description:
      'Microsoft Azure is our reference enterprise cloud provider. Design and deploy hub-and-spoke landing zones, validate two-tier secure application topologies, and download production Terraform modules aligned to Microsoft’s Cloud Adoption Framework and Azure Verified Modules.',
  }),
  Object.freeze({
    provider: 'aws',
    label: 'AWS',
    name: 'Amazon Web Services',
    type: 'cloud',
    row: 1,
    website: 'https://aws.amazon.com',
    description:
      'As a premier hyperscale cloud provider, Amazon Web Services powers resilient architectures. Explore reference designs for multi-region disaster recovery, serverless event-driven APIs, and Transit Gateway networks, backed by role-based AWS certification paths.',
  }),
  Object.freeze({
    provider: 'gcp',
    label: 'GCP',
    name: 'Google Cloud',
    type: 'cloud',
    row: 1,
    website: 'https://cloud.google.com',
    description:
      'Google Cloud is the cloud provider for data and modern app platforms. Explore blueprints for BigQuery analytics lakes, Cloud Run microservices, global HTTPS load balancing, and BeyondCorp zero-trust perimeters, supported by Google Cloud learning paths.',
  }),
  Object.freeze({
    provider: 'vmware',
    label: 'VMware',
    name: 'VMware by Broadcom',
    type: 'cloud',
    row: 1,
    website: 'https://www.vmware.com',
    description:
      'Private and hybrid architectures find their cloud provider in VMware by Broadcom. Explore VMware Cloud Foundation designs across vSphere, vSAN, and NSX, discover migration patterns into public hyperscalers, and advance through certification tracks.',
  }),
  Object.freeze({
    provider: 'github',
    label: 'GitHub',
    name: 'GitHub',
    type: 'framework',
    row: 2,
    website: 'https://github.com',
    description:
      'GitHub serves as our framework provider for secure multi-cloud delivery. Study production GitHub CI/CD workflows for infrastructure deployment, master OpenID Connect (OIDC) cloud federation to eliminate static keys, and explore browser lab environments.',
  }),
  Object.freeze({
    provider: 'finops',
    label: 'FinOps',
    name: 'FinOps Foundation',
    type: 'framework',
    row: 2,
    website: 'https://www.finops.org',
    description:
      'The FinOps Foundation is the framework provider shaping multi-cloud cost governance. Implement FOCUS 1.1 billing data normalization, eliminate cloud cost traps across Azure, AWS, and GCP, and build organizational maturity with unit economic allocation models.',
  }),
  Object.freeze({
    provider: 'terraform',
    label: 'Terraform',
    name: 'Terraform',
    type: 'service',
    row: 2,
    // www.terraform.io redirects here, and this is the canonical URL it names.
    website: 'https://developer.hashicorp.com/terraform',
    description:
      'HashiCorp Terraform is the service provider for declarative multi-cloud infrastructure. Generate enterprise landing zones using official verified modules, examine modular state structures, and practice automated syntax and policy validation inside browser labs.',
  }),
  Object.freeze({
    provider: 'docker',
    label: 'Docker',
    name: 'Docker',
    type: 'service',
    row: 2,
    website: 'https://www.docker.com',
    description:
      'Docker operates as the service provider packaging our container toolchains. Learn multi-stage image builds, inspect the container image that powers every browser lab workspace, and use Docker Sandboxes to run coding agents safely against your landing zone locally.',
  }),
  Object.freeze({
    provider: 'ansible',
    label: 'Ansible',
    name: 'Red Hat Ansible',
    type: 'service',
    row: 2,
    website: 'https://www.ansible.com',
    description:
      'Red Hat Ansible is the service provider behind automated system configuration and host hardening. Explore production playbooks for enterprise Linux security baselines, and test your configuration playbooks against real cloud environments in browser-based labs.',
  }),
]);

/** The strip's two rows, each in display order. */
export const PROVIDER_GUIDE_ROWS = Object.freeze(
  [1, 2].map((row) => Object.freeze(PROVIDER_GUIDE.filter((entry) => entry.row === row)))
);

/** "Microsoft Azure's website (opens in a new tab)"; "Amazon Web Services' website …". */
export function websiteLinkLabel(entry) {
  const owner = entry.name.endsWith('s') ? `${entry.name}'` : `${entry.name}'s`;
  return `${owner} website (opens in a new tab)`;
}

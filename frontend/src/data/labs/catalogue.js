/**
 * The lab catalogue (#681, Coder Phase 3 of #659; per-provider structure in
 * ADR 0033 §4 "Labs").
 *
 * PURE DATA. Nothing here fetches, formats or renders; the pages derive every
 * card, step and link from these rows and `catalogue.test.js` asserts each
 * row carries every field below with the right shape, that no two share an
 * `id`, and that every provider, difficulty, tool and validation job type
 * comes from the fixed lists this file exports.
 *
 * ADDING A LAB IS ADDING A ROW — AND ONE TEMPLATE ENTRY. A new lab family
 * (an AWS lab, a Kubernetes lab under Azure, a second Ansible lab) needs:
 *
 *   1. one row here, with `providers` naming the provider hub(s) it is
 *      listed under (`/<provider>/education/labs`, every provider already
 *      has that route) and `technology` naming what it exercises;
 *   2. one entry in the Coder template's lab map and parameter options
 *      (lab-host/coder/templates/hcw-lab/main.tf) and one in the launcher's
 *      LAB_WORKSPACES (lab-host/coder/launcher/launcher.js), both keyed by
 *      the same `id`.
 *
 * No new route, page or component: the provider list filters by
 * `providers`, the cross-provider index groups by it, the pane page renders
 * the row's steps, and the admin Catalogue tab lists it. A provider that is
 * not yet in VALID_PROVIDERS (context/ProviderContext.jsx) is the one thing
 * this cannot do, because the `/:provider` routes do not exist for it.
 *
 * `id` doubles as the Coder template parameter: the lab's pane
 * (`/<provider>/education/labs/<id>`, or `/education/labs/<id>` from the
 * index, #751) loads the lab launcher with `?lab=<id>` (`labLauncherUrl`),
 * which creates the learner's workspace from the `hcw-lab` template (#679)
 * with `param.lab=<id>`, and the template opens that lab's folder in
 * code-server. So an `id` is a path segment and a Terraform variable value at
 * once — lowercase, hyphenated, no spaces — which the test also enforces.
 *
 * `workspaceName` is the name the launcher gives the learner's workspace for
 * this lab, one per lab per learner. The launcher keeps the same map
 * (LAB_WORKSPACES in lab-host/coder/launcher/launcher.js) because it may only
 * act on names it holds itself; this test and
 * scripts/lab-host-launcher.test.mjs both fail when the two differ. At most
 * 16 characters: code-server's address is `code-server--<workspace>--<owner>`,
 * one DNS label of 63, and a Coder username can be 32.
 *
 * `tools` names what the lab actually exercises, from the toolchain the
 * `hcw-lab` image ships (ADR 0032 §5). `status` is `available` for every lab
 * the public pages list; a `coming` lab is kept out of them and must carry
 * `comingSince` (a date) and `comingReason`, so nothing is promised without
 * saying since when and why.
 *
 * EVERY STRING HERE IS VISITOR COPY. The rows render on public pages, so
 * they name what a learner sees (the workspace, the lab host, the runner's
 * checks) and never the tools behind the site; public-copy.test.js scans
 * this directory and LabPanePage.test.jsx holds the pane page to the same
 * rule.
 */
import { routes, staticRoutes } from '@/lib/routeFactory';

/** Every tool a lab may name; the test refuses anything outside this set. */
export const LAB_TOOLS = Object.freeze(['az', 'terraform', 'kubectl', 'helm', 'ansible', 'docker']);

/**
 * The provider hubs a lab may be listed under. A subset of VALID_PROVIDERS
 * (context/ProviderContext.jsx), which the test checks; a lab's first
 * provider is the one its canonical page lives under.
 */
export const LAB_PROVIDERS = Object.freeze([
  'azure',
  'aws',
  'gcp',
  'vmware',
  'terraform',
  'ansible',
  'docker',
]);

/** How much a lab assumes, in the order the pages sort by. */
export const LAB_DIFFICULTIES = Object.freeze(['intro', 'intermediate', 'advanced']);

/** The words the pages print for each difficulty. */
export const DIFFICULTY_LABELS = Object.freeze({
  intro: 'Introductory',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
});

/** A lab is listed publicly only while `available`. */
export const LAB_STATUSES = Object.freeze(['available', 'coming']);

/**
 * The runner job types a lab's validation may name: the four that check
 * work (vps-agent capabilities, mirrored in functions/src/lib/labs.js
 * LAB_JOB_TYPES and components/admin/labs/labsView.js FALLBACK_JOB_TYPES).
 * `shell-echo` is a smoke test and checks nothing, so it is not here.
 */
export const LAB_VALIDATION_JOB_TYPES = Object.freeze([
  'terraform-validate',
  'ansible-check',
  'helm-template',
  'kubeconform',
]);

/** The one Coder template every lab runs on today (#679). */
export const LAB_TEMPLATE = 'hcw-lab';

/**
 * Coder's public origin. Learners sign in there with GitHub; the site never
 * does. Since #750 it answers a top-level visit with a redirect to
 * `/education/labs`, so the site only ever frames it (#751). It is also the
 * origin of the lab launcher, the one sender whose messages the pane page
 * accepts.
 */
export const CODER_ORIGIN = 'https://coder.lab.hybridcloudworks.com';

/**
 * Where the lab launcher is served on Coder's name
 * (lab-host/ansible/roles/coder/templates/10-coder.caddy.j2). It opens
 * code-server inside the pane, which Coder's dashboard cannot: it opens apps
 * in a new window, and #750 turns every new window into the labs page.
 */
export const LAB_LAUNCHER_PATH = '/_hcw/lab/';

/**
 * Where a workspace's apps are served: one label below Coder's own name
 * (`CODER_WILDCARD_ACCESS_URL` in lab-host/coder/docker-compose.yml), which
 * is where code-server runs (`subdomain = true` in the `hcw-lab` template).
 * The site's `frame-src` and the pane's `allow` name exactly this and
 * `CODER_ORIGIN`, and `csp.test.js` holds the CSP to the same two strings.
 */
export const CODER_APPS_ORIGIN = 'https://*.coder.lab.hybridcloudworks.com';

/**
 * The one Coder path #750 lets through at the top level
 * (lab-host/ansible/roles/coder/templates/10-coder.caddy.j2), and the path
 * Coder's own "GitHub" button links to. Coder v2.37.3 serves the start and
 * the end of GitHub sign-in from it: without a `code` it sets its state
 * cookie and redirects to GitHub (coderd/httpmw/oauth2.go, ExtractOAuth2),
 * and GitHub sends the visitor back to it with one.
 */
export const CODER_GITHUB_SIGN_IN_PATH = '/api/v2/users/oauth2/github/callback';

/**
 * The image the labs run in, as the learner pulls it. `latest` on purpose:
 * this is the interactive, network-attached form a person runs on their own
 * machine, not the digest-pinned form `vps-agent` executes under
 * `--network none` (ADR 0032 §5 and `vps-agent/lib/capabilities.js`).
 *
 * Docker Hub since 2026-09-29, when `publish-lab-image.yml` first copied the
 * image there through Docker's OIDC connection (#779, #790), and Docker Hub
 * only since 2026-10-08: the workflow pushes there directly and GHCR is no
 * longer published. Docker Hub's short name is the one a learner can
 * type, and Docker is the sponsor the labs are pitched to (#678).
 */
export const LAB_IMAGE = 'hybridcloudworks/hcw-lab:latest';

/**
 * The two "Run it locally" lines, exactly as a learner pastes them. Two
 * because the quoting differs: PowerShell expands `${PWD}` and bash expands
 * `"$PWD"`, and either form pasted at the other prompt mounts the wrong
 * directory or nothing. The page labels each with its shell.
 *
 * `\${PWD}` is escaped because this is a JavaScript template literal and an
 * unescaped `${PWD}` would be interpolated here, at build time, into
 * "undefined" — the test pins the rendered text so that cannot slip through.
 */
export const RUN_LOCALLY_COMMANDS = Object.freeze([
  Object.freeze({
    shell: 'PowerShell',
    command: `docker run --rm -it -v \${PWD}:/workspace ${LAB_IMAGE}`,
  }),
  Object.freeze({
    shell: 'bash',
    command: `docker run --rm -it -v "$PWD":/workspace ${LAB_IMAGE}`,
  }),
]);

/**
 * The fields every lab carries, in the order the test reports a missing one.
 * `comingSince` and `comingReason` are required only while `status` is
 * `coming`, and refused otherwise.
 */
export const LAB_FIELDS = Object.freeze([
  'id',
  'workspaceName',
  'title',
  'summary',
  'providers',
  'technology',
  'tools',
  'difficulty',
  'estimatedMinutes',
  'status',
  'objectives',
  'prerequisites',
  'steps',
  'resources',
  'validation',
  'template',
  'params',
  'articleSlugs',
]);

/** Markdown from lines, so a fenced block can be written line by line. */
const md = (lines) => lines.join('\n');

/** A lab step: `validation` is present only on the step a runner job can check. */
const step = (title, body, validation = null) =>
  Object.freeze(
    validation ? { title, body, validation: Object.freeze(validation) } : { title, body }
  );

/** A learner-facing link: `url` is a site path or an https address. */
const resource = (label, url) => Object.freeze({ label, url });

/**
 * A published article on this site, `/<provider>/blog/<slug>`: the three
 * parts of the landing-zone series, published from the CMS.
 */
const article = (provider, slug, title) => Object.freeze({ provider, slug, title });

const ARTICLE_LANDING_ZONE = article(
  'azure',
  'build-a-landing-zone-you-can-read',
  'Build a landing zone you can read'
);
const ARTICLE_ONE_CONTAINER = article(
  'terraform',
  'follow-along-in-one-container',
  'Follow along in one container'
);
const ARTICLE_AGENT_EXPLAINS = article(
  'terraform',
  'let-an-agent-explain-it',
  'Let an agent explain it'
);

/**
 * A small Terraform root for the runner's `terraform-validate` job: the
 * Landing Zone Builder's management module at the version the builder pins,
 * which the runner has an offline copy of. Fits the job's text payload.
 */
const LANDING_ZONE_SAMPLE = md([
  'terraform {',
  '  required_version = ">= 1.12"',
  '  required_providers {',
  '    azurerm = {',
  '      source  = "hashicorp/azurerm"',
  '      version = "~> 4.0"',
  '    }',
  '  }',
  '}',
  '',
  'provider "azurerm" {',
  '  features {}',
  '}',
  '',
  'module "management" {',
  '  source  = "Azure/avm-ptn-alz-management/azurerm"',
  '  version = "~> 0.9"',
  '',
  '  location                = "centralus"',
  '  resource_group_name     = "rg-alz-management"',
  '  automation_account_name = "aa-alz-management"',
  '}',
]);

/** The root the walkthrough opens, as the runner's text payload. */
const PROVIDERS_ONLY_SAMPLE = md([
  'terraform {',
  '  required_version = ">= 1.9"',
  '  required_providers {',
  '    azurerm = {',
  '      source  = "hashicorp/azurerm"',
  '      version = "~> 5.0"',
  '    }',
  '    random = {',
  '      source  = "hashicorp/random"',
  '      version = "~> 3.6"',
  '    }',
  '  }',
  '}',
  '',
  'provider "azurerm" {',
  '  features {}',
  '}',
  '',
  'resource "random_pet" "smoke" {',
  '  length = 2',
  '}',
]);

/** A playbook on ansible.builtin only, which is all the runner resolves. */
const ANSIBLE_SAMPLE = md([
  '---',
  '- name: Configure a web host',
  '  hosts: all',
  '  gather_facts: false',
  '  vars:',
  '    site_root: /var/www/hcw',
  '  tasks:',
  '    - name: Install nginx',
  '      ansible.builtin.package:',
  '        name: nginx',
  '        state: present',
  '',
  '    - name: Create the site root',
  '      ansible.builtin.file:',
  '        path: "{{ site_root }}"',
  '        state: directory',
  '        mode: "0755"',
]);

/** A sample root for the AWS multi-account validation runner job. */
const AWS_TRANSIT_GATEWAY_SAMPLE = md([
  'terraform {',
  '  required_version = ">= 1.9"',
  '  required_providers {',
  '    aws = {',
  '      source  = "hashicorp/aws"',
  '      version = "~> 5.80"',
  '    }',
  '  }',
  '}',
  '',
  'provider "aws" {',
  '  region = "us-east-1"',
  '}',
  '',
  'resource "aws_organizations_organization" "org" {',
  '  feature_set = "ALL"',
  '}',
]);

/** A sample root for the Google Cloud Shared VPC validation runner job. */
const GCP_SHARED_VPC_SAMPLE = md([
  'terraform {',
  '  required_version = ">= 1.9"',
  '  required_providers {',
  '    google = {',
  '      source  = "hashicorp/google"',
  '      version = "~> 6.15"',
  '    }',
  '  }',
  '}',
  '',
  'provider "google" {',
  '  region = "us-central1"',
  '}',
  '',
  'resource "google_folder" "platform" {',
  '  display_name = "Platform"',
  '  parent       = "organizations/123456789012"',
  '}',
]);

/** A sample root for the VMware HCX / AVS validation runner job. */
const VMWARE_HCX_SAMPLE = md([
  'terraform {',
  '  required_version = ">= 1.9"',
  '  required_providers {',
  '    vsphere = {',
  '      source  = "hashicorp/vsphere"',
  '      version = "~> 2.11"',
  '    }',
  '    azurerm = {',
  '      source  = "hashicorp/azurerm"',
  '      version = "~> 4.0"',
  '    }',
  '  }',
  '}',
  '',
  'provider "vsphere" {',
  '  user                 = "administrator@vsphere.local"',
  '  password             = "stub-password-offline"',
  '  vsphere_server       = "vcenter.corp.local"',
  '  allow_unverified_ssl = true',
  '}',
  '',
  'provider "azurerm" {',
  '  features {}',
  '}',
  '',
  'data "vsphere_datacenter" "dc" {',
  '  name = "Datacenter-OnPrem"',
  '}',
]);

/** A sample root for the Docker agent containment runner job. */
const DOCKER_SANDBOX_SAMPLE = md([
  'terraform {',
  '  required_version = ">= 1.9"',
  '  required_providers {',
  '    docker = {',
  '      source  = "kreuzwerker/docker"',
  '      version = "~> 3.0"',
  '    }',
  '  }',
  '}',
  '',
  'provider "docker" {',
  '  host = "unix:///var/run/docker.sock"',
  '}',
  '',
  'resource "docker_image" "sandbox_image" {',
  '  name = "hybridcloudworks/hcw-lab:latest"',
  '}',
]);

export const labs = Object.freeze([
  Object.freeze({
    id: 'landing-zone-builder-output',
    workspaceName: 'lab-lzb',
    title: 'Validate a Landing Zone Builder download',
    summary:
      'Take the zip the Landing Zone Builder at /tools/landing-zone hands you, unpack it in the workspace, and run terraform init, fmt and validate against the Azure Verified Modules it declares — the same checks the lab runner applies before anything is planned.',
    providers: Object.freeze(['azure', 'terraform']),
    technology: Object.freeze(['terraform', 'azure-verified-modules', 'landing-zone']),
    tools: Object.freeze(['terraform', 'az']),
    difficulty: 'intermediate',
    estimatedMinutes: 25,
    status: 'available',
    objectives: Object.freeze([
      'Read the nine Terraform files the Landing Zone Builder produces and say what each module call is for.',
      'Initialise the root with the network on and see what terraform downloads for an Azure landing zone.',
      'Run terraform fmt and terraform validate, break one reference, and watch validate name the line.',
      'Say what validate cannot tell you, and why a plan — not a validate — is where credentials enter.',
      'Send the same root to the lab runner and compare its offline check with yours.',
    ]),
    prerequisites: Object.freeze([
      'A download from the Landing Zone Builder at /tools/landing-zone (a zip of Terraform files).',
      'A GitHub account in the HybridCloudWorks organization to open the workspace; or Docker on your own machine and the Run it locally line.',
      'No Azure subscription: init and validate need none. Only the optional plan at the end asks for a sign-in.',
    ]),
    steps: Object.freeze([
      step(
        'Build and download a landing zone',
        md([
          'Open the [Landing Zone Builder](/tools/landing-zone), choose the components you want (management groups, policy, management, a hub and spokes) and download the zip. The builder writes plain Terraform on Azure Verified Modules: every `module` block names a registry module and a version, so the files initialise anywhere Terraform can reach the registry.',
        ])
      ),
      step(
        'Upload it into the workspace and unzip',
        md([
          'The lab folder starts empty apart from a README. Drag the zip into the file explorer (or use File > Upload), then in the terminal:',
          '',
          '```bash',
          'unzip landing-zone-*.zip -d landing-zone && cd landing-zone && ls',
          '```',
          '',
          'You should see nine `.tf` files. Read `main.tf` first: the comments say why each call looks the way it does, not only what it is.',
        ])
      ),
      step(
        'terraform init, with the network on',
        md([
          '```bash',
          'terraform init',
          '```',
          '',
          'This workspace reaches the Terraform registry, so init downloads the Azure Verified Modules and their providers — tens of megabytes for a full landing zone. Note how long it takes and what lands in `.terraform/`; the lab runner at the end does the same work with no network at all, from offline copies of these modules.',
        ])
      ),
      step(
        'fmt and validate, then break something',
        md([
          '```bash',
          'terraform fmt -check -diff',
          'terraform validate',
          '```',
          '',
          '`fmt -check` reports formatting only and changes nothing; `validate` checks that every reference resolves and every argument is one the provider or module accepts. Now open `main.tf`, misspell a reference inside one module call (for example the resource group name a module reads), and run `terraform validate` again. It names the file and line. Fix it and re-run until both pass.',
        ])
      ),
      step(
        'What validate cannot tell you',
        md([
          'Validate never contacts Azure, so it cannot know whether a name is taken, whether a policy definition exists, or what will be created. That is a plan. If you want to see one:',
          '',
          '```bash',
          'az login --use-device-code',
          'terraform plan',
          '```',
          '',
          'A plan needs a subscription and read permissions; it changes nothing. Stop there: the articles for this lab explain why nothing from a lab is ever applied.',
        ])
      ),
      step(
        'Check it on the lab runner',
        md([
          'The Landing Zone Builder page offers to validate your download on the lab: the runner receives the root, swaps each module source for its offline copy of that Azure Verified Module at a version that satisfies your constraint, and runs `terraform init -backend=false` and `terraform validate` with the network switched off. Compare its log with what you ran here — same result, no download.',
        ]),
        {
          jobType: 'terraform-validate',
          hint: 'The runner takes one main.tf as text or a whole root as a tar archive, and inits it with no network from offline copies of the Azure Verified Modules the builder emits.',
        }
      ),
    ]),
    resources: Object.freeze([
      resource('Landing Zone Builder', staticRoutes.landingZone),
      resource('Azure Verified Modules', 'https://azure.github.io/Azure-Verified-Modules/'),
      resource(
        'terraform validate',
        'https://developer.hashicorp.com/terraform/cli/commands/validate'
      ),
      resource(
        'Azure landing zones',
        'https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/ready/landing-zone/'
      ),
    ]),
    validation: Object.freeze({
      jobType: 'terraform-validate',
      payloadEncoding: 'text',
      samplePayload: LANDING_ZONE_SAMPLE,
    }),
    template: LAB_TEMPLATE,
    params: Object.freeze({ lab: 'landing-zone-builder-output' }),
    articleSlugs: Object.freeze([
      ARTICLE_LANDING_ZONE,
      ARTICLE_ONE_CONTAINER,
      ARTICLE_AGENT_EXPLAINS,
    ]),
  }),
  Object.freeze({
    id: 'wsl-containers-walkthrough',
    workspaceName: 'lab-wslc',
    title: 'WSL2 Container Sandbox for Coding Agents',
    summary:
      'Supplementary Linux container simulation (no Windows 11 Azure VM): step into a rootless Linux container workspace that models a WSL2 Ubuntu distribution, inspect Dockerfile.agentic-wslc and /etc/wsl.conf isolation, and validate the Terraform harness offline.',
    providers: Object.freeze(['azure']),
    technology: Object.freeze(['wsl2', 'containers', 'terraform', 'linux-sandbox']),
    tools: Object.freeze(['az', 'terraform']),
    difficulty: 'intermediate',
    estimatedMinutes: 25,
    status: 'available',
    objectives: Object.freeze([
      'Inspect a supplementary rootless Linux container simulation that models a WSL2 Ubuntu 24.04 environment for agentic workflows without provisioning a Windows 11 Azure VM.',
      'Verify why bind-mounting only a single project folder in Docker—and disabling Windows drive automount via /etc/wsl.conf in WSL2—prevents a coding agent from reading host SSH keys or cloud credentials.',
      'Compare importing a container rootfs into WSL2 on your own Windows 11 workstation with running the OCI image in the browser lab workspace.',
      'Run the verification script and offline Terraform validation against the pre-seeded workspace harness.',
    ]),
    prerequisites: Object.freeze([
      'Nothing to bring: the per-lab bootloader seeds ~/wsl-containers-lab with Dockerfile.agentic-wslc, verify-sandbox.sh, and a Terraform root inside a Linux container simulation.',
      'A GitHub account in the HybridCloudWorks organization to open the workspace; or Docker on your own machine and the Run it locally line.',
    ]),
    steps: Object.freeze([
      step(
        'Inspect the WSL2-equivalent container workspace',
        md([
          'The workspace opens directly in `~/wsl-containers-lab`, seeded by the lab bootloader. List the files and read `Dockerfile.agentic-wslc` to see how the Ubuntu 24.04 rootfs is configured for a non-root user:',
          '',
          '```bash',
          'ls -la ~/wsl-containers-lab',
          'cat ~/wsl-containers-lab/Dockerfile.agentic-wslc',
          '```',
          '',
          'The imported WSL distribution uses its own `/etc/wsl.conf`: Windows drive automount is disabled (`[automount] enabled=false`) and the default user is `nobody` (`[user] default=nobody`). It does not inherit Docker’s single-folder bind-mount boundary.',
        ])
      ),
      step(
        'Run the sandbox boundary verification check',
        md([
          'Execute `verify-sandbox.sh` in `bash` to inspect the active Linux kernel, user identity, workspace mount, and offline provider mirror:',
          '',
          '```bash',
          '~/wsl-containers-lab/verify-sandbox.sh',
          '```',
          '',
          'Confirm that `User` resolves to a non-root account and that `TF_CLI_CONFIG_FILE` points at the baked-in filesystem mirror.',
        ])
      ),
      step(
        'Compare Windows 11 WSL2 import commands with local Docker execution',
        md([
          'On a Windows 11 workstation, you can export the container root filesystem and register it as a dedicated WSL2 distribution so an agent never touches your primary Ubuntu profile:',
          '',
          '```powershell',
          'docker create --name wslc-export hybridcloudworks/hcw-lab:latest',
          'docker export wslc-export -o wslc-rootfs.tar',
          'wsl --import hcw-agent-wslc "$env:LOCALAPPDATA\\hcw-agent-wslc" .\\wslc-rootfs.tar --version 2',
          '```',
          '',
          'Because `docker export` + `wsl --import` does not carry Docker’s runtime user or bind mounts, the image bakes `/etc/wsl.conf` with `automount` disabled and `default=nobody` so `/mnt/c` host files are not exposed automatically.',
        ])
      ),
      step(
        'Validate the Terraform harness offline',
        md([
          'Initialise and validate the Terraform configuration inside `~/wsl-containers-lab` with the network backend disabled:',
          '',
          '```bash',
          'cd ~/wsl-containers-lab',
          'terraform init -backend=false',
          'terraform fmt -check',
          'terraform validate',
          '```',
          '',
          'Send `main.tf` to the lab runner below to confirm the runner reaches the same offline validation result.',
        ]),
        {
          jobType: 'terraform-validate',
          hint: 'Paste ~/wsl-containers-lab/main.tf as the text payload: the runner initialises it from the offline provider mirror with no network access and runs terraform validate.',
        }
      ),
    ]),
    resources: Object.freeze([
      resource(
        'WSL2 enterprise configuration',
        'https://learn.microsoft.com/en-us/windows/wsl/enterprise'
      ),
      resource(
        'Import any Linux distribution to use with WSL',
        'https://learn.microsoft.com/en-us/windows/wsl/use-custom-distro'
      ),
      resource('Docker Sandboxes', routes.sandboxes('docker')),
    ]),
    validation: Object.freeze({
      jobType: 'terraform-validate',
      payloadEncoding: 'text',
      samplePayload: PROVIDERS_ONLY_SAMPLE,
    }),
    template: LAB_TEMPLATE,
    params: Object.freeze({ lab: 'wsl-containers-walkthrough' }),
    articleSlugs: Object.freeze([ARTICLE_ONE_CONTAINER, ARTICLE_AGENT_EXPLAINS]),
  }),
  Object.freeze({
    id: 'defender-wsl-plugin-walkthrough',
    workspaceName: 'lab-mde-wsl',
    title: 'Defender for Endpoint WSL2 Plug-in & Hunting Walkthrough',
    summary:
      'Supplementary Linux container simulation (no Windows 11 Azure VM): explore how Microsoft Defender for Endpoint monitors WSL2 Linux distributions (`<HostName>-wslc`), inspect simulated healthcheck and EDR telemetry, practise the three Advanced Hunting KQL queries, and validate the Azure policy baseline.',
    providers: Object.freeze(['azure']),
    technology: Object.freeze(['defender-for-endpoint', 'wsl2', 'kql', 'terraform']),
    tools: Object.freeze(['az', 'terraform']),
    difficulty: 'intermediate',
    estimatedMinutes: 30,
    status: 'available',
    objectives: Object.freeze([
      'Inspect simulated Microsoft Defender for Endpoint WSL2 plug-in health output (`healthcheck.exe` shim) and understand how to run the real tool on a Windows 11 host.',
      'Identify the `<HostName>-wslc` machine entry and `WSL2` tag in the Device Inventory and link it to its parent Windows host via `DeviceInfo.HostDeviceId`.',
      'Trigger the benign DIY Linux EDR simulation script (`diy-edr-test.sh --trigger-test-marker`), inspect the simulated process telemetry, and review how real detections are validated in the Microsoft Defender portal.',
      'Run the three Advanced Hunting KQL queries (`DeviceInfo`, `HostDeviceId` join, and `DeviceProcessEvents`) and validate the Terraform management root.',
    ]),
    prerequisites: Object.freeze([
      'Nothing to bring: the per-lab bootloader seeds ~/mde-wsl-lab with simulated healthcheck output, diy-edr-test.sh, hunting-queries.kql, and a Terraform root, and the page includes an interactive Defender Portal & KQL Simulator.',
      'A GitHub account in the HybridCloudWorks organization to open the workspace; or Docker on your own machine and the Run it locally line.',
    ]),
    steps: Object.freeze([
      step(
        'Inspect simulated WSL2 plug-in status and compare with Windows host healthcheck.exe',
        md([
          'On a real Windows 11 host onboarded to Microsoft Defender for Endpoint, the WSL2 plug-in (`Minimum build 2004 / KB5007253+` with WSL `2.0.14.0+`) runs a Windows-host health check tool. On an onboarded Windows 11 workstation, run:',
          '',
          '```powershell',
          '& "C:\\Program Files\\Microsoft Defender for Endpoint Plug-in for WSL\\tools\\healthcheck.exe"',
          '```',
          '',
          'Because this browser lab runs inside a Linux container rather than a Windows VM, the workspace provides simulated output so you can inspect the fields (`PluginStatus`, `SensorHealth`, `HostDeviceId`, `WslDeviceName`) before running the real check on a Windows host:',
          '',
          '```bash',
          'healthcheck.exe',
          '```',
          '',
          'Notice the `[SIMULATED]` banner in the Linux shim output and verify that `WslDeviceName` follows the `<HostName>-wslc` naming convention (`LAB-HOST-wslc`).',
        ])
      ),
      step(
        'Trigger the simulated DIY Linux EDR test script inside the container',
        md([
          'Run the benign DIY Linux EDR simulation script inside `~/mde-wsl-lab` (or click **Run DIY Linux EDR Test** in the interactive simulator on this page):',
          '',
          '```bash',
          '~/mde-wsl-lab/diy-edr-test.sh --trigger-test-marker',
          '```',
          '',
          'In this Linux container simulation, the script records a local simulated `DeviceProcessEvents` JSON event rather than submitting a live alert to Defender. On a real onboarded Windows 11 + WSL2 host, validate actual detections in the Microsoft Defender portal (`https://security.microsoft.com`) under **Incidents & alerts** and **Advanced hunting**.',
        ])
      ),
      step(
        'Inspect the three Advanced Hunting KQL queries',
        md([
          'Open `~/mde-wsl-lab/hunting-queries.kql` in the workspace or step through the **4. Advanced Hunting KQL** tab in the simulator above:',
          '',
          '```bash',
          'cat ~/mde-wsl-lab/hunting-queries.kql',
          '```',
          '',
          'The three queries cover: (1) listing all `WSL2`-tagged Linux instances in `DeviceInfo` with their `HostDeviceId` column, (2) joining WSL2 instances back to their parent Windows 11 host via `DeviceInfo.HostDeviceId`, and (3) filtering `DeviceProcessEvents` across WSL2 devices identified by `DeviceInfo.HostDeviceId`.',
        ])
      ),
      step(
        'Validate the Terraform security management root',
        md([
          'Initialise and validate the Terraform configuration in `~/mde-wsl-lab/main.tf` using the offline provider mirror:',
          '',
          '```bash',
          'cd ~/mde-wsl-lab',
          'terraform init -backend=false',
          'terraform fmt -check',
          'terraform validate',
          '```',
          '',
          'Submit `main.tf` to the lab runner to verify the configuration passes offline validation.',
        ]),
        {
          jobType: 'terraform-validate',
          hint: 'Send main.tf to the terraform-validate runner job to confirm the management configuration validates cleanly with no network access.',
        }
      ),
    ]),
    resources: Object.freeze([
      resource(
        'Defender for Endpoint plug-in for WSL',
        'https://learn.microsoft.com/en-us/defender-endpoint/defender-endpoint-windows-subsystem-linux'
      ),
      resource(
        'Advanced hunting DeviceInfo table',
        'https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-deviceinfo-table'
      ),
      resource(
        'Advanced hunting DeviceProcessEvents table',
        'https://learn.microsoft.com/en-us/defender-xdr/advanced-hunting-deviceprocessevents-table'
      ),
    ]),
    validation: Object.freeze({
      jobType: 'terraform-validate',
      payloadEncoding: 'text',
      samplePayload: LANDING_ZONE_SAMPLE,
    }),
    template: LAB_TEMPLATE,
    params: Object.freeze({ lab: 'defender-wsl-plugin-walkthrough' }),
    articleSlugs: Object.freeze([ARTICLE_LANDING_ZONE, ARTICLE_ONE_CONTAINER]),
  }),
  Object.freeze({
    id: 'aws-transit-gateway-walkthrough',
    workspaceName: 'lab-aws-tgw',
    title: 'AWS Multi-Account Transit Gateway Walkthrough',
    summary:
      'Inspect and validate an enterprise AWS multi-account architecture with AWS Organizations, Service Control Policies, and Transit Gateway routing in an ephemeral container sandbox.',
    providers: Object.freeze(['aws']),
    technology: Object.freeze(['aws', 'terraform', 'transit-gateway']),
    tools: Object.freeze(['terraform']),
    difficulty: 'intermediate',
    estimatedMinutes: 15,
    status: 'available',
    objectives: Object.freeze([
      'Inspect AWS Organizations organizational unit hierarchy and SCP policy definitions',
      'Trace Transit Gateway route table attachments across isolated and shared VPC spokes',
      'Execute terraform validate to check multi-account HCL syntax and provider constraints',
    ]),
    prerequisites: Object.freeze([
      'Basic understanding of AWS multi-account landing zones and CIDR networking',
      'A GitHub account to authenticate with the container workspace, or local Docker',
    ]),
    steps: Object.freeze([
      step(
        'Inspect AWS Organizations & SCP Guardrails',
        md([
          'Review the organizational structure under `organizations.tf` and `scp.tf`.',
          'The baseline provisions Security, Infrastructure, and Workloads OUs with SCP guardrails that disallow root access and restrict unapproved regions.',
          '',
          '```bash',
          'cat organizations.tf',
          'cat scp.tf',
          '```',
        ])
      ),
      step(
        'Review Transit Gateway Route Attachments',
        md([
          'Examine `transit-gateway.tf` and `spokes.tf` to see how Workload VPCs attach to the central Transit Gateway hub.',
          'Notice how East-West traffic is isolated via dedicated Route 53 Resolver and Transit Gateway route tables.',
          '',
          '```bash',
          'cat transit-gateway.tf',
          'cat spokes.tf',
          '```',
        ])
      ),
      step(
        'Validate the Multi-Account Terraform Configuration',
        md([
          'Initialize Terraform without a backend and run `terraform validate` to verify the multi-account HCL configuration.',
          '',
          '```bash',
          'terraform init -backend=false',
          'terraform validate',
          '```',
        ]),
        {
          jobType: 'terraform-validate',
          hint: 'The runner checks that all AWS provider blocks and module calls adhere to Terraform HCL constraints offline.',
        }
      ),
    ]),
    resources: Object.freeze([
      resource('AWS Architecture Designs', '/aws/architecture-designs'),
      resource('Landing Zone Builder (AWS Target)', '/tools/landing-zone?cloud=aws'),
      resource(
        'AWS Security Reference Architecture',
        'https://docs.aws.amazon.com/prescriptive-guidance/latest/security-reference-architecture/welcome.html'
      ),
    ]),
    validation: Object.freeze({
      jobType: 'terraform-validate',
      payloadEncoding: 'text',
      samplePayload: AWS_TRANSIT_GATEWAY_SAMPLE,
    }),
    template: LAB_TEMPLATE,
    params: Object.freeze({ lab: 'aws-transit-gateway-walkthrough' }),
    articleSlugs: Object.freeze([]),
  }),
  Object.freeze({
    id: 'gcp-shared-vpc-walkthrough',
    workspaceName: 'lab-gcp-vpc',
    title: 'Google Cloud Shared VPC & Org Policies Walkthrough',
    summary:
      'Explore and validate Google Cloud Foundation Fabric Resource Manager folders, Organization Policies, and Shared VPC Host networking in a browser container workspace.',
    providers: Object.freeze(['gcp']),
    technology: Object.freeze(['gcp', 'terraform', 'shared-vpc']),
    tools: Object.freeze(['terraform']),
    difficulty: 'intermediate',
    estimatedMinutes: 15,
    status: 'available',
    objectives: Object.freeze([
      'Review Resource Manager folder hierarchy and organization policy constraints',
      'Examine Shared VPC Host project, subnets, and Private Service Connect configuration',
      'Execute terraform validate to check Cloud Foundation Fabric module syntax',
    ]),
    prerequisites: Object.freeze([
      'Familiarity with Google Cloud project hierarchies and Shared VPC concepts',
      'A GitHub account to authenticate with the container workspace, or local Docker',
    ]),
    steps: Object.freeze([
      step(
        'Review Resource Manager Folders & Organization Policies',
        md([
          'Review `folders.tf` and `org-policies.tf`. The configuration defines Platform, Corp, and Online folder hierarchies along with organizational policy constraints that enforce shielded VMs and prevent external IP exposure.',
          '',
          '```bash',
          'cat folders.tf',
          'cat org-policies.tf',
          '```',
        ])
      ),
      step(
        'Inspect Shared VPC Host Network & Subnets',
        md([
          'Examine `shared-vpc.tf` and `projects.tf` to see how the Shared VPC Host project shares subnets and Cloud NAT gateways with attached service projects.',
          '',
          '```bash',
          'cat shared-vpc.tf',
          'cat projects.tf',
          '```',
        ])
      ),
      step(
        'Validate Cloud Foundation Fabric Terraform',
        md([
          'Run `terraform init -backend=false` and `terraform validate` inside the terminal to verify syntax across all Foundation Fabric resource definitions.',
          '',
          '```bash',
          'terraform init -backend=false',
          'terraform validate',
          '```',
        ]),
        {
          jobType: 'terraform-validate',
          hint: 'The runner checks that all Google Cloud provider blocks and folder module calls validate cleanly.',
        }
      ),
    ]),
    resources: Object.freeze([
      resource('Google Cloud Architecture Designs', '/gcp/architecture-designs'),
      resource('Landing Zone Builder (Google Cloud Target)', '/tools/landing-zone?cloud=gcp'),
      resource(
        'Google Cloud Security Foundations',
        'https://cloud.google.com/architecture/security-foundations'
      ),
    ]),
    validation: Object.freeze({
      jobType: 'terraform-validate',
      payloadEncoding: 'text',
      samplePayload: GCP_SHARED_VPC_SAMPLE,
    }),
    template: LAB_TEMPLATE,
    params: Object.freeze({ lab: 'gcp-shared-vpc-walkthrough' }),
    articleSlugs: Object.freeze([]),
  }),
  Object.freeze({
    id: 'vmware-hcx-migration-walkthrough',
    workspaceName: 'lab-vmw-hcx',
    title: 'VMware HCX Hybrid Interconnect & Migration Walkthrough',
    summary:
      'Inspect and validate VMware Cloud Foundation (VCF) and Azure VMware Solution (AVS) hybrid interconnect topology, L2 stretched network extensions, and HCX migration policies.',
    providers: Object.freeze(['vmware']),
    technology: Object.freeze(['vmware', 'terraform', 'hcx']),
    tools: Object.freeze(['terraform']),
    difficulty: 'intermediate',
    estimatedMinutes: 20,
    status: 'available',
    objectives: Object.freeze([
      'Inspect VMware vSphere datacenter hierarchy and Azure VMware Solution private cloud peering.',
      'Trace VMware HCX Interconnect (IX) and Network Extension (NE) stretched subnet appliances.',
      'Execute terraform validate to check hybrid vSphere and AVS infrastructure HCL syntax offline.',
    ]),
    prerequisites: Object.freeze([
      'Familiarity with VMware vSphere, NSX-T, and hybrid-cloud network extension.',
      'A GitHub account to authenticate with the container workspace, or local Docker.',
    ]),
    steps: Object.freeze([
      step(
        'Inspect vCenter & AVS Interconnect Topology',
        md([
          'Review `vsphere.tf` and `avs-interconnect.tf`. The configuration defines on-premises vSphere datacenter clusters, compute resource pools, and ExpressRoute / private cloud interconnect attachments.',
          '',
          '```bash',
          'cat vsphere.tf',
          'cat avs-interconnect.tf',
          '```',
        ])
      ),
      step(
        'Review HCX L2 Network Extension & Stretched VLANs',
        md([
          'Inspect `hcx-service-mesh.tf` and `network-extension.tf` to examine HCX interconnect service mesh appliances, WAN optimization profiles, and stretched L2 broadcast domains.',
          '',
          '```bash',
          'cat hcx-service-mesh.tf',
          'cat network-extension.tf',
          '```',
        ])
      ),
      step(
        'Validate Hybrid VMware Terraform Configuration',
        md([
          'Run `terraform init -backend=false` and `terraform validate` to verify the multi-provider vSphere and AzureRM hybrid landing zone HCL declarations offline.',
          '',
          '```bash',
          'terraform init -backend=false',
          'terraform validate',
          '```',
        ]),
        {
          jobType: 'terraform-validate',
          hint: 'The runner checks that all vSphere datacenter, cluster, and Azure VMware Solution peering blocks validate cleanly.',
        }
      ),
    ]),
    resources: Object.freeze([
      resource('VMware Architecture Designs', '/vmware/architecture-designs'),
      resource('VMware Learn Hub', '/vmware/education'),
      resource(
        'Azure VMware Solution Documentation',
        'https://learn.microsoft.com/en-us/azure/azure-vmware/'
      ),
    ]),
    validation: Object.freeze({
      jobType: 'terraform-validate',
      payloadEncoding: 'text',
      samplePayload: VMWARE_HCX_SAMPLE,
    }),
    template: LAB_TEMPLATE,
    params: Object.freeze({ lab: 'vmware-hcx-migration-walkthrough' }),
    articleSlugs: Object.freeze([]),
  }),
  Object.freeze({
    id: 'terraform-validate-walkthrough',
    workspaceName: 'lab-tfv',
    title: 'Terraform validate, step by step',
    summary:
      'Start from a small root that passes, see what terraform init -backend=false, terraform fmt -check and terraform validate each check, break it three different ways to learn which command catches which mistake, and find out why init works here with no registry at all.',
    providers: Object.freeze(['terraform']),
    technology: Object.freeze(['terraform', 'provider-mirror']),
    tools: Object.freeze(['terraform']),
    difficulty: 'intro',
    estimatedMinutes: 20,
    status: 'available',
    objectives: Object.freeze([
      'Tell apart what terraform init, terraform fmt and terraform validate each check, by making each one fail.',
      'Read a provider mirror configuration and explain why init needs no network in this image.',
      'Add a provider the mirror does not hold and see init refuse it, then reach the registry on purpose.',
      'Say what none of the three commands can know before a plan.',
    ]),
    prerequisites: Object.freeze([
      'Nothing to bring: the workspace opens on a two-provider root that already passes.',
      'A GitHub account in the HybridCloudWorks organization to open the workspace; or Docker on your own machine and the Run it locally line.',
    ]),
    steps: Object.freeze([
      step(
        'Read the root',
        md([
          'The folder holds one file, `main.tf`: two providers (`hashicorp/azurerm` and `hashicorp/random`), one `random_pet` resource and no backend. Read the comment at the top; it says what a passing init here proves.',
        ])
      ),
      step(
        'Initialise with no registry',
        md([
          '```bash',
          'terraform init -backend=false',
          '```',
          '',
          'It completes, and nothing was downloaded. The image sets `TF_CLI_CONFIG_FILE` to a configuration that installs providers from a filesystem mirror. Look at both:',
          '',
          '```bash',
          'cat "$TF_CLI_CONFIG_FILE"',
          'ls /opt/terraform/mirror/registry.terraform.io/hashicorp',
          '```',
          '',
          'Every provider listed there can be installed offline; that is how the lab runner validates with the network switched off.',
        ])
      ),
      step(
        'fmt, then validate',
        md([
          '```bash',
          'terraform fmt -check -diff',
          'terraform validate',
          '```',
          '',
          'Both pass. Now indent the `length` line in `main.tf` by one extra space and run both again: `fmt -check` reports the file and exits non-zero, `validate` still passes. Formatting is not correctness. Run `terraform fmt` with no flags to fix it.',
        ])
      ),
      step(
        'Break a reference',
        md([
          'Add an output that points at a resource that does not exist:',
          '',
          '```hcl',
          'output "pet" {',
          '  value = random_pet.smokey.id',
          '}',
          '```',
          '',
          '`terraform fmt -check` is happy; `terraform validate` is not, and it names `main.tf`, the line and the undeclared resource. Change `smokey` to `smoke` and validate again.',
        ])
      ),
      step(
        'Ask for a provider the mirror lacks',
        md([
          'Add `aws = { source = "hashicorp/aws", version = "~> 6.0" }` to `required_providers` and run `terraform init -backend=false`. It fails before validate can run: the mirror has no `hashicorp/aws`, and the configuration allows no other source. This is the runner’s answer too, by design. In this workspace you may reach the registry for one command:',
          '',
          '```bash',
          'TF_CLI_CONFIG_FILE=/dev/null terraform init -backend=false',
          '```',
          '',
          'Then remove the `aws` block again, delete `.terraform.lock.hcl`, and re-run the offline init.',
        ])
      ),
      step(
        'What none of the three can tell you',
        md([
          'A root that inits, formats and validates can still fail to plan: `azurerm` needs credentials to plan anything, a name may be taken, a quota may be full. Those are plan-time and apply-time facts, and this lab stops before them on purpose. To see the runner reach the same verdict on your `main.tf`, send it as a `terraform-validate` job.',
        ]),
        {
          jobType: 'terraform-validate',
          hint: 'Paste main.tf as the text payload: the runner inits it with no network from the same mirror and prints what terraform validate said.',
        }
      ),
    ]),
    resources: Object.freeze([
      resource(
        'Provider installation and mirrors',
        'https://developer.hashicorp.com/terraform/cli/config/config-file#provider-installation'
      ),
      resource(
        'terraform validate',
        'https://developer.hashicorp.com/terraform/cli/commands/validate'
      ),
      resource('terraform fmt', 'https://developer.hashicorp.com/terraform/cli/commands/fmt'),
      resource(
        'The hcw-lab image',
        'https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/lab-image'
      ),
    ]),
    validation: Object.freeze({
      jobType: 'terraform-validate',
      payloadEncoding: 'text',
      samplePayload: PROVIDERS_ONLY_SAMPLE,
    }),
    template: LAB_TEMPLATE,
    params: Object.freeze({ lab: 'terraform-validate-walkthrough' }),
    articleSlugs: Object.freeze([ARTICLE_ONE_CONTAINER]),
  }),
  Object.freeze({
    id: 'ansible-syntax-check-walkthrough',
    workspaceName: 'lab-asc',
    title: 'Ansible syntax check, step by step',
    summary:
      'Run ansible-playbook --syntax-check over the playbook that configures the Hybrid Lab host itself, see it fail until the collections it needs are installed, break a play and read what the check reports, and learn what a syntax check is not — with no host in reach and nothing executed.',
    providers: Object.freeze(['ansible']),
    technology: Object.freeze(['ansible', 'ansible-core', 'collections']),
    tools: Object.freeze(['ansible']),
    difficulty: 'intro',
    estimatedMinutes: 20,
    status: 'available',
    objectives: Object.freeze([
      'Read a real playbook layout: ansible.cfg, site.yml, roles, requirements.yml and an inventory.',
      'See why a syntax check fails on a module from a collection that is not installed, and install the pinned collections.',
      'Break a play and a task, and read exactly what --syntax-check reports for each.',
      'Say what a syntax check does not do, and what would be needed for --check mode or a lint.',
    ]),
    prerequisites: Object.freeze([
      'Nothing to bring: the workspace opens on the lab host’s own Ansible directory.',
      'A GitHub account in the HybridCloudWorks organization to open the workspace; or Docker on your own machine and the Run it locally line.',
    ]),
    steps: Object.freeze([
      step(
        'Read the layout',
        md([
          'The folder is the configuration management for the Hybrid Lab host. `ansible.cfg` points at `inventory/localhost.yml` and `roles/`; `site.yml` runs the roles in order; `requirements.yml` pins the collections they use; each role’s `meta/argument_specs.yml` is its variable contract. Read `site.yml` top to bottom before running anything.',
        ])
      ),
      step(
        'Run the syntax check, and watch it fail',
        md([
          '```bash',
          'ansible-playbook --syntax-check site.yml',
          '```',
          '',
          'The image carries `ansible-core` and no collections, so the first role that names a module outside `ansible.builtin` stops the check with "couldn’t resolve module/action". A syntax check resolves every module it meets; a missing collection is a syntax error to it.',
        ])
      ),
      step(
        'Install the pinned collections',
        md([
          '```bash',
          'ansible-galaxy collection install -r requirements.yml',
          'ansible-playbook --syntax-check site.yml',
          '```',
          '',
          'The versions are exact, so you install the same code the host runs. The check now ends with `playbook: site.yml` and exit code 0.',
        ])
      ),
      step(
        'Break a play',
        md([
          'In `site.yml`, rename `pre_tasks:` to `pre_taskz:` and run the check again. It reports that `pre_taskz` is not a valid attribute for a Play, with the file and line. Then open any `roles/*/tasks/main.yml`, misspell a module name (`ansible.builtin.fil`), and see the same kind of message name the task instead. Put both back:',
          '',
          '```bash',
          'git checkout -- .',
          'ansible-playbook --syntax-check site.yml',
          '```',
        ])
      ),
      step(
        'What a syntax check is not',
        md([
          'It parses and resolves; it does not connect, gather facts, evaluate conditions or run a single module. `--check` mode would need a host to talk to, and a lint (ansible-lint) is a separate tool this image does not carry — run it on your own machine if you want style rules. To see the runner apply the same check to a playbook of your own, send one that uses `ansible.builtin` modules only, since the runner installs no collections.',
        ]),
        {
          jobType: 'ansible-check',
          hint: 'Paste one playbook as the text payload, ansible.builtin modules only: the runner has ansible-core and no collections, so anything else fails to resolve, exactly as step 2 did here.',
        }
      ),
    ]),
    resources: Object.freeze([
      resource(
        'ansible-playbook',
        'https://docs.ansible.com/ansible/latest/cli/ansible-playbook.html'
      ),
      resource(
        'Installing collections',
        'https://docs.ansible.com/ansible/latest/collections_guide/collections_installing.html'
      ),
      resource(
        'Role argument specs',
        'https://docs.ansible.com/ansible/latest/playbook_guide/playbooks_reuse_roles.html#role-argument-validation'
      ),
      resource(
        'The lab host playbook',
        'https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/lab-host'
      ),
    ]),
    validation: Object.freeze({
      jobType: 'ansible-check',
      payloadEncoding: 'text',
      samplePayload: ANSIBLE_SAMPLE,
    }),
    template: LAB_TEMPLATE,
    params: Object.freeze({ lab: 'ansible-syntax-check-walkthrough' }),
    articleSlugs: Object.freeze([]),
  }),
  Object.freeze({
    id: 'docker-sandbox-agent-walkthrough',
    workspaceName: 'lab-dck-sbx',
    title: 'Docker Sandboxes & Agent Containment Walkthrough',
    summary:
      'Explore and validate rootless container execution, unprivileged user namespaces, read-only rootfs mounts, and network-isolated local AI agent sandboxes.',
    providers: Object.freeze(['docker']),
    technology: Object.freeze(['docker', 'sandboxes', 'containment']),
    tools: Object.freeze(['docker']),
    difficulty: 'intermediate',
    estimatedMinutes: 15,
    status: 'available',
    objectives: Object.freeze([
      'Inspect rootless daemon configuration, unprivileged subuid mappings, and security profiles.',
      'Verify network isolation (--network none) and read-only volume boundaries for containment.',
      'Execute terraform validate to check declarative Docker container sandbox configurations.',
    ]),
    prerequisites: Object.freeze([
      'Basic understanding of Docker containers and Linux security containment.',
      'A GitHub account to authenticate with the container workspace, or local Docker.',
    ]),
    steps: Object.freeze([
      step(
        'Inspect Rootless Daemon & User Namespaces',
        md([
          'Inspect the rootless Docker daemon socket, subuid/subgid allocations, and unprivileged user mappings in the container sandbox environment.',
          '',
          '```bash',
          'docker info',
          'id -u',
          'cat /etc/subuid',
          '```',
        ])
      ),
      step(
        'Verify Network Isolation & Read-Only Rootfs',
        md([
          'Review the container containment execution profile: verify that the workspace runs with `--network none`, a read-only root filesystem, and strict memory/CPU bounds.',
          '',
          '```bash',
          'docker run --rm --network none alpine ip addr',
          '```',
        ])
      ),
      step(
        'Validate Declarative Docker Sandbox Configuration',
        md([
          'Run `terraform init -backend=false` and `terraform validate` to verify the declarative Docker sandbox infrastructure and container resource specifications offline.',
          '',
          '```bash',
          'terraform init -backend=false',
          'terraform validate',
          '```',
        ]),
        {
          jobType: 'terraform-validate',
          hint: 'The runner checks that all Docker provider definitions, image tags, and sandbox container resources validate cleanly.',
        }
      ),
    ]),
    resources: Object.freeze([
      resource('Docker Sandboxes', '/docker/sandboxes'),
      resource('Docker Learn Hub', '/docker/education'),
      resource('Docker Security Best Practices', 'https://docs.docker.com/engine/security/'),
    ]),
    validation: Object.freeze({
      jobType: 'terraform-validate',
      payloadEncoding: 'text',
      samplePayload: DOCKER_SANDBOX_SAMPLE,
    }),
    template: LAB_TEMPLATE,
    params: Object.freeze({ lab: 'docker-sandbox-agent-walkthrough' }),
    articleSlugs: Object.freeze([]),
  }),
]);

/** The labs the public pages list: `available` ones, in catalogue order. */
export const availableLabs = Object.freeze(labs.filter((lab) => lab.status === 'available'));

/**
 * What a lab's pane loads: the lab launcher, told which lab. The launcher
 * finds the learner's workspace for it (`workspaceName`), has Coder create
 * or start it in Coder's own page when it must, and replaces itself with
 * code-server once code-server is healthy, so the learner lands in the lab
 * folder inside the pane (#659, #751). The template it creates from is
 * `hcw-lab` and its one parameter is `lab`, whose options are exactly these
 * ids (lab-host/coder/templates/hcw-lab/main.tf).
 */
export function labLauncherUrl(lab, origin = CODER_ORIGIN) {
  return `${origin}${LAB_LAUNCHER_PATH}?lab=${encodeURIComponent(lab.id)}`;
}

/**
 * Where the pane page's "Sign in with GitHub" opens, in a tab of its own
 * (#751; the whole flow is in LabPanePage.jsx). `redirect` is where Coder
 * sends the tab once signed in. Any path on Coder lands the tab on
 * `/education/labs`, because #750 redirects every top-level visit there
 * except this path, so `/`, Coder's own default, is as good as any.
 */
export function coderSignInUrl(origin = CODER_ORIGIN) {
  return `${origin}${CODER_GITHUB_SIGN_IN_PATH}?redirect=${encodeURIComponent('/')}`;
}

/** The provider a lab's canonical pages live under: the first it lists. */
export function primaryProvider(lab) {
  return lab.providers[0];
}

/**
 * The labs list for a provider, `/<provider>/education/labs`; with no
 * provider, the cross-provider index `/education/labs`.
 */
export function labsPath(provider = null) {
  return provider ? routes.labs(provider) : staticRoutes.labs;
}

/**
 * The site page that holds one lab's pane (#751): under a provider,
 * `/<provider>/education/labs/<id>`; with no provider, the index's
 * `/education/labs/<id>`, kept for links written before ADR 0033.
 */
export function labPanePath(provider, labId) {
  if (!provider) return `${staticRoutes.labs}/${encodeURIComponent(labId)}`;
  return routes.labPane(provider, labId);
}

/** The catalogue row with this id, or null for an id the catalogue does not have. */
export function labById(labId) {
  return labs.find((lab) => lab.id === labId) ?? null;
}

/** The available labs listed under a provider, in catalogue order. */
export function labsForProvider(provider) {
  return availableLabs.filter((lab) => lab.providers.includes(provider));
}

/**
 * The available labs grouped for the cross-provider index, in LAB_PROVIDERS
 * order: each lab once, under its home provider, so a lab listed under two
 * hubs (the landing zone, Azure and Terraform) is not printed twice on one
 * page; its card's provider chips name the other hub. A provider with no
 * lab of its own has no group.
 */
export function labsByProvider() {
  return LAB_PROVIDERS.map((provider) => ({
    provider,
    labs: availableLabs.filter((lab) => primaryProvider(lab) === provider),
  })).filter((group) => group.labs.length > 0);
}

/** The providers whose list has at least one available lab, in LAB_PROVIDERS order. */
export function providersWithLabs() {
  return LAB_PROVIDERS.filter((provider) => labsForProvider(provider).length > 0);
}

/** One article's page on the site: `/<provider>/blog/<slug>`. */
export function articlePath(entry) {
  return `/${entry.provider}/blog/${encodeURIComponent(entry.slug)}`;
}

/** Every article any available lab points at, once each, in catalogue order. */
export function allLabArticles() {
  const seen = new Set();
  return availableLabs
    .flatMap((lab) => lab.articleSlugs)
    .filter((entry) => {
      const key = `${entry.provider}/${entry.slug}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Shared Mini Landing Page framing (#1084) for the WSL2 Container (#1082)
 * and Defender for Endpoint WSL2 Plug-in (#1083) walkthrough labs.
 * Kept separate from the `labs` rows so `LAB_FIELDS` remains exact.
 */
export const LAB_LANDING_FRAMES = Object.freeze({
  'wsl-containers-walkthrough': Object.freeze({
    promise:
      'Run coding agents inside a rootless Ubuntu 24.04 container filesystem that mirrors a dedicated WSL2 distribution—mounting only the active project directory while keeping host credentials out of reach.',
    topology: Object.freeze({
      caption: 'WSL2 & OCI Container Boundary — Rootless Agent Sandbox',
      surrounding: Object.freeze([
        'Ubuntu 24.04 RootFS',
        'Offline Terraform Mirror',
        'Non-root UID 1000',
      ]),
      stages: Object.freeze([
        Object.freeze({
          title: 'OCI Image RootFS',
          subtitle: 'hybridcloudworks/hcw-lab:latest',
          boundary: 'Image Layer',
          guardrail: 'Pinned Terraform + Azure CLI',
        }),
        Object.freeze({
          title: 'WSL2 / Container Import',
          subtitle: 'wsl --import or container runtime',
          boundary: 'Linux Kernel',
          guardrail: 'Isolated from default profile',
        }),
        Object.freeze({
          title: 'Single-Folder Mount',
          subtitle: '~/wsl-containers-lab -> /workspace',
          boundary: 'Mount Boundary',
          guardrail: 'No host ~/.ssh or ~/.azure',
        }),
        Object.freeze({
          title: 'Boundary Verification',
          subtitle: 'verify-sandbox.sh check',
          boundary: 'Userland Check',
          guardrail: 'Non-root user confirmed',
        }),
        Object.freeze({
          title: 'Offline Terraform Check',
          subtitle: 'terraform init -backend=false && validate',
          boundary: 'Runner Parity',
          guardrail: 'Zero network calls required',
        }),
      ]),
    }),
    howItWorks: Object.freeze([
      'The per-lab bootloader seeds ~/wsl-containers-lab with Dockerfile.agentic-wslc, verify-sandbox.sh, and a Terraform root.',
      'Run verify-sandbox.sh in bash to confirm the non-root user identity, isolated mount point, and baked-in provider mirror.',
      'Compare the Windows 11 wsl --import workflow with the running Linux container and validate main.tf offline.',
    ]),
    keyServices: Object.freeze([
      Object.freeze({
        name: 'WSL2 Custom Distribution',
        role: 'Imports a clean container rootfs on Windows 11 via wsl --import',
      }),
      Object.freeze({
        name: 'hybridcloudworks/hcw-lab',
        role: 'Pre-built Linux container image with Terraform and Azure CLI',
      }),
      Object.freeze({
        name: 'Filesystem Provider Mirror',
        role: 'Allows terraform init -backend=false and validate with no network',
      }),
    ]),
    practices: Object.freeze([
      'Mount only the target project directory (/workspace) instead of sharing your entire home directory with an agent.',
      'Run coding agents as a non-root user inside a dedicated distribution or container so host profiles stay untouched.',
      'Validate generated Terraform offline before introducing cloud credentials for a plan.',
    ]),
    outcome:
      'A repeatable Linux sandbox pattern that works identically inside a browser container workspace, local Docker, or an imported WSL2 distribution on Windows 11.',
  }),
  'defender-wsl-plugin-walkthrough': Object.freeze({
    promise:
      'Inspect how the Microsoft Defender for Endpoint WSL2 plug-in extends kernel sensor visibility into every running WSL2 distribution, tags the machine as <HostName>-wslc, and surfaces process events in Advanced Hunting.',
    topology: Object.freeze({
      caption: 'Defender for Endpoint WSL2 Plug-in — Host & Linux Sensor Telemetry Flow',
      surrounding: Object.freeze([
        'Windows 11 Build 2004+ (KB5007253)',
        'WSL 2.0.14.0+',
        'Defender Portal Assets & Hunting',
      ]),
      stages: Object.freeze([
        Object.freeze({
          title: 'Windows 11 Host',
          subtitle: 'LAB-HOST (Onboarded)',
          boundary: 'Host OS',
          guardrail: 'HostDeviceId anchor',
        }),
        Object.freeze({
          title: 'MDE WSL2 Plug-in',
          subtitle: 'healthcheck.exe (Healthy)',
          boundary: 'Plug-in Bridge',
          guardrail: 'PluginVersion 1.0.2604.1',
        }),
        Object.freeze({
          title: 'WSL2 Linux Instance',
          subtitle: 'LAB-HOST-wslc (WSL2 Tag)',
          boundary: 'WSL2 Kernel',
          guardrail: 'Attaches to active distros',
        }),
        Object.freeze({
          title: 'DIY Linux EDR Marker',
          subtitle: 'diy-edr-test.sh --trigger-test-marker',
          boundary: 'Process Sensor',
          guardrail: 'Benign test alert only',
        }),
        Object.freeze({
          title: 'Advanced Hunting KQL',
          subtitle: 'DeviceInfo & DeviceProcessEvents',
          boundary: 'Defender XDR',
          guardrail: 'HostDeviceId correlation',
        }),
      ]),
    }),
    howItWorks: Object.freeze([
      'Verify the plug-in status on the Windows 11 host with healthcheck.exe and inspect the seeded output in ~/mde-wsl-lab/mock-healthcheck.txt.',
      'Confirm both LAB-HOST and the WSL2-tagged LAB-HOST-wslc entry appear in the Device Inventory linked by HostDeviceId.',
      'Run diy-edr-test.sh --trigger-test-marker and query DeviceInfo and DeviceProcessEvents with the three KQL hunting queries.',
    ]),
    keyServices: Object.freeze([
      Object.freeze({
        name: 'Defender for Endpoint Plug-in for WSL',
        role: 'Streams process and network telemetry from the shared WSL2 Linux kernel',
      }),
      Object.freeze({
        name: 'Defender Device Inventory',
        role: 'Lists each WSL2 machine as <HostName>-wslc with the WSL2 tag',
      }),
      Object.freeze({
        name: 'Advanced Hunting (KQL)',
        role: 'Joins WSL2 DeviceProcessEvents back to the parent Windows 11 host via HostDeviceId',
      }),
    ]),
    practices: Object.freeze([
      'Ensure WSL 2.0.14.0 or newer is installed via wsl.exe --update so the plug-in can attach to the virtual machine kernel.',
      'Correlate Linux process telemetry to the physical workstation using AdditionalFields.HostDeviceId in KQL hunting queries.',
      'Use a benign marker script (diy-edr-test.sh) to verify sensor health and alert routing without introducing malicious binaries.',
    ]),
    outcome:
      'End-to-end verification of Defender for Endpoint WSL2 sensor health, <HostName>-wslc inventory correlation, and KQL process hunting—all inside a safe Linux container and browser simulator.',
  }),
});

export default labs;

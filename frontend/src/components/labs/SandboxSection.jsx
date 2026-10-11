/**
 * "Run an agent against your landing zone" (#676, Phase 3 of #658): the
 * Docker Sandboxes recipe as a page section. Three steps, one command per
 * shell, the first prompt to paste, the cost line, and a link to the recipe
 * directory. Nothing here talks to this site — a sandbox runs on the
 * learner's machine (or Docker's cloud) and the section is editorial.
 *
 * It was on `/education/labs` until #774 moved it to the Docker hub's own
 * page, `/docker/sandboxes` (pages/docker/SandboxesPage.jsx); the labs page
 * keeps a one-line pointer in the old slot. The file stays beside
 * `CommandLine`, the lab cards' command block, which it shares.
 *
 * EVERY FACT BELOW WAS READ FROM THE DOCKER DOCUMENTATION ON 2026-09-25, and
 * read again on 2026-09-29 when the section moved (`sbx run` now documents
 * that it creates a missing sandbox and that `--name` reattaches). The issue
 * carries `live-check` because the `sbx` surface moves; re-verify against
 * these pages, and move CHECKED_ON in SandboxesPage.jsx, before changing a
 * word of the commands:
 *   https://docs.docker.com/ai/sandboxes/                  — `sbx` CLI; local sandboxes free,
 *                                                            cloud pay-as-you-go
 *   https://docs.docker.com/ai/sandboxes/agents/claude-code/ — `sbx run claude <dir>`; base image
 *                                                            docker/sandbox-templates:claude-code
 *   https://docs.docker.com/reference/cli/sbx/create/      — `sbx create [flags] AGENT [PATH...]`,
 *                                                            `-t/--template` is the container image
 *   https://docs.docker.com/ai/sandboxes/customize/kits-v2/ — custom template: FROM the agent
 *                                                            image, run with `--template`
 *   https://docs.docker.com/ai/sandboxes/cloud/            — cloud needs a Docker Agentic Platform
 *                                                            subscription, cannot mount a host
 *                                                            workspace, expires after one hour
 *
 * THE TWO COMMANDS ARE THE SAME TEXT. `sbx run` takes the same arguments at
 * either prompt and `.` is the current directory in both, so unlike the
 * "Run it locally" lines on the cards there is no quoting to get wrong. Both
 * are still printed, each under its shell, because the site's rule is that a
 * command says which prompt it is for (.claude/CLAUDE.md), and a learner who
 * has just pasted a PowerShell-only line elsewhere on the page should not
 * have to work out whether this one is different.
 */
import React from 'react';
import { Link } from 'react-router';
import { safeUrl } from '@/lib/safeUrl';
import { staticRoutes } from '@/lib/routeFactory';
import CommandLine from './CommandLine';

const MUTED = 'text-slate-600 dark:text-slate-400';

/** The image tag the recipe's README builds and loads. */
export const TEMPLATE_TAG = 'hcw-lz-sandbox:v1';

/** The sandbox name, so `sbx run --name hcw-lz` reattaches to the same one. */
export const SANDBOX_NAME = 'hcw-lz';

/**
 * Creates the sandbox from the unzipped folder and opens Claude Code in it.
 * `sbx run` creates when the name is new and reattaches when it exists, so
 * the same line is the second visit too.
 */
export const SANDBOX_COMMANDS = Object.freeze([
  Object.freeze({
    shell: 'PowerShell',
    command: `sbx run --name ${SANDBOX_NAME} --template ${TEMPLATE_TAG} claude .`,
  }),
  Object.freeze({
    shell: 'bash',
    command: `sbx run --name ${SANDBOX_NAME} --template ${TEMPLATE_TAG} claude .`,
  }),
]);

/** The first thing to say to the agent, as one sentence. */
export const FIRST_PROMPT =
  'Explain what this landing zone deploys, then run terraform init -backend=false, terraform fmt -check and terraform validate and tell me what each printed.';

/** The recipe directory on GitHub: Dockerfile, AGENTS.md and the README with every command. */
export const RECIPE_URL =
  'https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/lab-image/sandbox-template';

export const COST_SENTENCE =
  'Local sandboxes are free. Cloud sandboxes (sbx --cloud) bill your own Docker subscription, cannot mount this folder, and expire after one hour by default.';

export default function SandboxSection() {
  const recipeHref = safeUrl(RECIPE_URL);
  return (
    <div className="flex flex-col gap-4" data-testid="sandbox-section">
      <p className={`text-sm ${MUTED} max-w-3xl`}>
        Docker Sandboxes run a coding agent in a microVM on your own machine, with the folder you
        name mounted inside and nothing else. The recipe linked below builds a template with Claude
        Code, terraform and the Azure CLI already installed, and an AGENTS.md that tells the agent
        the folder is a landing zone generated for learning: validate and explain it, never plan or
        apply it. Build and load the template once from the recipe README, store your Anthropic key
        with <code className="font-mono text-xs">sbx secret set anthropic</code>, then:
      </p>

      <ol className="list-decimal pl-5 flex flex-col gap-2 text-sm text-slate-700 dark:text-slate-300 max-w-3xl">
        <li data-testid="sandbox-step">
          Build a landing zone in the{' '}
          <Link to={staticRoutes.landingZone} className="underline underline-offset-4">
            Landing Zone Builder
          </Link>{' '}
          and download the zip.
        </li>
        <li data-testid="sandbox-step">
          Unzip it and change into the folder it made, so the Terraform files are in the current
          directory.
        </li>
        <li data-testid="sandbox-step">
          Create the sandbox from that folder and open the agent in it. Pick the line for the shell
          you are in; the folder is mounted at the same path inside the sandbox.
        </li>
      </ol>

      <div className="flex flex-col gap-3 max-w-3xl">
        {SANDBOX_COMMANDS.map((entry) => (
          <CommandLine key={entry.shell} shell={entry.shell} command={entry.command} />
        ))}
      </div>

      <p className="text-sm text-slate-700 dark:text-slate-300 max-w-3xl">
        When Claude Code opens, paste this first:{' '}
        <q className="italic" data-testid="sandbox-first-prompt">
          {FIRST_PROMPT}
        </q>
      </p>

      <p className={`text-sm ${MUTED} max-w-3xl`} data-testid="sandbox-cost">
        {COST_SENTENCE}
      </p>

      {recipeHref ? (
        <p className="text-sm max-w-3xl">
          <a
            href={recipeHref}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="sandbox-recipe-link"
            className="font-semibold underline underline-offset-4"
          >
            The recipe on GitHub: lab-image/sandbox-template
          </a>
          <span className={`text-xs ${MUTED}`}>
            {' '}
            (Dockerfile, AGENTS.md, and the README with the build, load and cloud commands; opens in
            a new tab)
          </span>
        </p>
      ) : null}
    </div>
  );
}

/** Published Docker Hub lab image used as the template for `--cloud` sandboxes (#1080). */
export const CLOUD_TEMPLATE_IMAGE = 'hybridcloudworks/hcw-lab:latest';

/**
 * Seven-step recipe for running a Docker cloud sandbox (`sbx run --cloud`)
 * against the published `hybridcloudworks/hcw-lab:latest` image (#1080).
 */
export const CLOUD_SANDBOX_STEPS = Object.freeze([
  Object.freeze({
    id: 'login',
    title: '1. Sign in to Docker from the sbx CLI',
    body: 'Authenticate the sbx command line with your Docker account so it can provision a remote cloud microVM.',
    commands: Object.freeze([
      Object.freeze({ shell: 'PowerShell', command: 'sbx login' }),
      Object.freeze({ shell: 'bash', command: 'sbx login' }),
    ]),
  }),
  Object.freeze({
    id: 'secret',
    title: '2. Store your model provider key globally',
    body: 'Pass -g (--global) so your Anthropic key is available to cloud sandboxes without writing it into an image or workspace file.',
    commands: Object.freeze([
      Object.freeze({ shell: 'PowerShell', command: 'sbx secret set -g anthropic' }),
      Object.freeze({ shell: 'bash', command: 'sbx secret set -g anthropic' }),
    ]),
  }),
  Object.freeze({
    id: 'run-cloud',
    title: '3. Launch the cloud sandbox from the published lab image',
    body: 'Pass --cloud to run inside Docker’s remote microVM environment using the published hybridcloudworks/hcw-lab:latest template image.',
    commands: Object.freeze([
      Object.freeze({
        shell: 'PowerShell',
        command: `sbx run --cloud claude --name ${SANDBOX_NAME} -t ${CLOUD_TEMPLATE_IMAGE}`,
      }),
      Object.freeze({
        shell: 'bash',
        command: `sbx run --cloud claude --name ${SANDBOX_NAME} -t ${CLOUD_TEMPLATE_IMAGE}`,
      }),
    ]),
  }),
  Object.freeze({
    id: 'clone-validate',
    title: '4. Clone the repository and validate the Terraform configuration inside the sandbox',
    body: 'Because a cloud sandbox does not mount a local host folder, clone the repository inside the remote Linux environment and run offline Terraform validation.',
    commands: Object.freeze([
      Object.freeze({
        shell: 'bash',
        command:
          'git clone https://github.com/saulpatinojr/HCW-HybridCloudWorks.git && cd HCW-HybridCloudWorks/lab-image/smoke/providers-only && terraform init -backend=false && terraform validate',
      }),
    ]),
  }),
  Object.freeze({
    id: 'exec-ports',
    title: '5. Run one-off commands and inspect forwarded ports from your workstation',
    body: 'Use sbx exec to run non-interactive verification checks inside the running cloud sandbox and sbx ports to inspect exposed ports.',
    commands: Object.freeze([
      Object.freeze({
        shell: 'PowerShell',
        command: `sbx exec ${SANDBOX_NAME} -- terraform -version && sbx ports ${SANDBOX_NAME}`,
      }),
      Object.freeze({
        shell: 'bash',
        command: `sbx exec ${SANDBOX_NAME} -- terraform -version && sbx ports ${SANDBOX_NAME}`,
      }),
    ]),
  }),
  Object.freeze({
    id: 'expiry-rm',
    title: '6. Remove the sandbox when finished (one-hour default idle expiry)',
    body: 'Cloud sandboxes automatically pause or expire after one hour of inactivity by default. Remove the named sandbox explicitly when your session is complete.',
    commands: Object.freeze([
      Object.freeze({ shell: 'PowerShell', command: `sbx rm ${SANDBOX_NAME}` }),
      Object.freeze({ shell: 'bash', command: `sbx rm ${SANDBOX_NAME}` }),
    ]),
  }),
  Object.freeze({
    id: 'cost-subscription',
    title: '7. Subscription and billing boundary',
    body: 'Local sandboxes (sbx run without --cloud) are free on your workstation. Cloud sandboxes (sbx run --cloud) require a Docker Agentic Platform subscription and bill your own Docker account directly on a pay-as-you-go basis.',
    commands: Object.freeze([]),
  }),
]);

export const SANDBOX_LANDING_FRAME = Object.freeze({
  promise:
    'Run a coding agent inside an isolated Docker microVM—either free on your workstation with a mounted landing-zone folder or remotely with sbx run --cloud and the published hybridcloudworks/hcw-lab:latest image—so it can inspect and validate Terraform without touching host credentials.',
  topology: Object.freeze({
    caption: 'Docker Sandbox Agentic Flow — Workstation & Cloud MicroVM Isolation',
    surrounding: Object.freeze([
      'sbx secret store',
      'hybridcloudworks/hcw-lab:latest',
      'AGENTS.md guardrails',
    ]),
    stages: Object.freeze([
      Object.freeze({
        id: 'workstation',
        title: 'Workstation CLI (sbx)',
        subtitle: 'sbx login & sbx secret set',
        boundary: 'Host CLI',
        guardrail: 'Key stored out-of-band',
      }),
      Object.freeze({
        id: 'local-microvm',
        title: 'Local MicroVM Sandbox',
        subtitle: 'sbx run --name hcw-lz',
        boundary: 'Local Hypervisor',
        guardrail: 'Single folder mounted',
      }),
      Object.freeze({
        id: 'cloud-microvm',
        title: 'Cloud MicroVM (--cloud)',
        subtitle: 'sbx run --cloud claude',
        boundary: 'Docker Cloud',
        guardrail: 'No host mount; 1h expiry',
      }),
      Object.freeze({
        id: 'template-image',
        title: 'Lab Template Image',
        subtitle: 'hybridcloudworks/hcw-lab:latest',
        boundary: 'Container Layer',
        guardrail: 'Pinned Terraform + Azure CLI',
      }),
      Object.freeze({
        id: 'validate',
        title: 'Offline Terraform Check',
        subtitle: 'terraform init -backend=false && validate',
        boundary: 'AGENTS.md Rule',
        guardrail: 'Validate only; never apply',
      }),
    ]),
  }),
  howItWorks: Object.freeze([
    'Install Docker Desktop (with the sbx CLI) and store your model key via sbx secret set anthropic.',
    'For local runs, unzip a Landing Zone Builder bundle and run sbx run --name hcw-lz --template hcw-lz-sandbox:v1 claude . so only that directory is mounted inside the microVM.',
    'For cloud runs, authenticate with sbx login and run sbx run --cloud claude --name hcw-lz -t hybridcloudworks/hcw-lab:latest, then clone and validate inside the remote environment.',
  ]),
  keyServices: Object.freeze([
    Object.freeze({
      name: 'Docker Sandboxes (sbx)',
      role: 'MicroVM isolation for coding agents locally or in Docker Cloud',
    }),
    Object.freeze({
      name: 'hybridcloudworks/hcw-lab:latest',
      role: 'Published container image bundling Terraform, Ansible, and cloud CLIs',
    }),
    Object.freeze({
      name: 'AGENTS.md Guardrails',
      role: 'Instructs the agent to explain, format-check, and validate without planning or applying',
    }),
  ]),
  practices: Object.freeze([
    'Store model provider keys with sbx secret set (-g for cloud) rather than passing environment variables on the command line or committing .env files.',
    'Keep validation offline with terraform init -backend=false and terraform validate so no cloud credentials enter the sandbox.',
    'Remove cloud sandboxes with sbx rm hcw-lz as soon as you finish to avoid idle consumption prior to the one-hour expiry.',
  ]),
  outcome:
    'A reproducible local or cloud microVM workflow that lets an agent explain and validate Terraform landing zones with zero access to your host filesystem or cloud subscriptions.',
});

export function CloudSandboxSection() {
  return (
    <div className="flex flex-col gap-5" data-testid="cloud-sandbox-section">
      <p className={`text-sm ${MUTED} max-w-3xl`}>
        When you want to run the same workflow without local microVM virtualization, pass{' '}
        <code className="font-mono text-xs">--cloud</code> to run inside Docker’s remote Agentic
        Platform using the published <code className="font-mono text-xs">{CLOUD_TEMPLATE_IMAGE}</code>{' '}
        image. Because cloud sandboxes cannot mount a folder from your workstation, you clone the
        repository inside the remote sandbox and validate there.
      </p>

      <ol className="flex flex-col gap-5 max-w-3xl">
        {CLOUD_SANDBOX_STEPS.map((step) => (
          <li
            key={step.id}
            data-testid="cloud-sandbox-step"
            className="rounded-xl border border-slate-800/80 bg-slate-900/40 p-4 space-y-3"
          >
            <h3 className="text-sm font-semibold text-slate-900 dark:text-white">{step.title}</h3>
            <p className={`text-sm ${MUTED}`}>{step.body}</p>
            {step.commands.length > 0 && (
              <div className="flex flex-col gap-2">
                {step.commands.map((entry) => (
                  <CommandLine
                    key={`${step.id}-${entry.shell}`}
                    shell={entry.shell}
                    command={entry.command}
                  />
                ))}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}


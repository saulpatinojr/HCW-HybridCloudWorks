/**
 * `/docker/sandboxes` (#774): the Docker hub's third focus area, running a
 * coding agent in a Docker sandbox. The recipe itself is `SandboxSection`,
 * moved here unchanged from `/education/labs` (#676), where the section's
 * old anchor now holds a one-line pointer to this page so old links still
 * land somewhere that says where the recipe went.
 *
 * LIVE-CHECK. The `sbx` command line changes often (#774 keeps the label), so
 * the page says when its commands were last read against Docker's
 * documentation. On 2026-09-29 these still held, read from:
 *   https://docs.docker.com/ai/sandboxes/                  — microVM isolation; the sbx CLI
 *                                                            and local sandboxes are free,
 *                                                            including for commercial work
 *   https://docs.docker.com/reference/cli/sbx/run/         — `sbx run [flags] [AGENT] [PATH...]`
 *                                                            creates the sandbox when it does
 *                                                            not exist; `--name` reattaches;
 *                                                            `-t/--template` is the image
 *   https://docs.docker.com/ai/sandboxes/agents/claude-code/ — `sbx secret set anthropic`
 *   https://docs.docker.com/ai/sandboxes/cloud/            — `--cloud`, a Docker Agentic
 *                                                            Platform subscription, no host
 *                                                            workspace, one-hour default expiry
 * Re-read them, and move CHECKED_ON, before changing a word of the commands.
 *
 * A static route like `/docker/tools`, declared in App.jsx and listed in
 * STANDALONE_ROUTES in scripts/prerender-entry.jsx, so it pre-renders. Nothing
 * here reads the API: the section is editorial, and a sandbox runs on the
 * visitor's machine.
 */
import React from 'react';
import { Helmet } from 'react-helmet-async';
import SectionHeading from '@/components/education/SectionHeading';
import SandboxSection, {
  CloudSandboxSection,
  SANDBOX_LANDING_FRAME,
} from '@/components/labs/SandboxSection';
import Eyebrow from '@/components/shared/Eyebrow';
import MiniLandingFrame from '@/components/shared/MiniLandingFrame';
import { routes, staticRoutes } from '@/lib/routeFactory';
import { PlaceholderLink } from './DockerPlaceholderPage';

export const PAGE_TITLE = 'Run an agent in a sandbox';

/** The page's path, which the landing page, the tools page and the labs pointer link to. */
export const SANDBOXES_PATH = routes.sandboxes('docker');

const CANONICAL = `https://hybridcloudworks.com${SANDBOXES_PATH}`;

/**
 * The id the recipe's heading carries: the same one it had on the labs page,
 * so a `#agent-heading` link copied from there still means this section.
 */
export const RECIPE_HEADING_ID = 'agent-heading';

/** Heading id for the Docker cloud sandbox (--cloud) walkthrough (#1080). */
export const CLOUD_RECIPE_HEADING_ID = 'cloud-sandbox-heading';

/** When the commands on this page were last read against Docker's documentation. */
export const CHECKED_ON = Object.freeze({ iso: '2026-10-11', label: '11 October 2026' });

/** Docker's own overview of Docker Sandboxes. */
export const SANDBOXES_DOCS_URL = 'https://docs.docker.com/ai/sandboxes/';

const DESCRIPTION =
  'Run a coding agent in a Docker sandbox, an isolated microVM on your own machine that sees only the folder you give it, and point it at a landing zone from the Landing Zone Builder to validate and explain the Terraform.';

export default function DockerSandboxesPage() {
  const scrollToSection = (paneKey) => {
    const targetId = paneKey === 'how' ? CLOUD_RECIPE_HEADING_ID : RECIPE_HEADING_ID;
    const el = typeof document !== 'undefined' ? document.getElementById(targetId) : null;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <>
      <Helmet>
        <title>{`${PAGE_TITLE} | Hybrid Cloud Works`}</title>
        <meta name="description" content={DESCRIPTION} />
        <link rel="canonical" href={CANONICAL} />
      </Helmet>

      <main
        data-page="docker-sandboxes"
        className="relative z-10 mx-auto flex w-full max-w-[1100px] flex-col gap-10 px-4 py-12 text-foreground md:px-8"
      >
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute inset-x-0 top-0 h-[40vh] ambient-glow" />
        </div>

        <div className="relative flex flex-col gap-5">
          <Eyebrow>Docker · Sandboxes</Eyebrow>
          <p className="max-w-2xl text-base leading-relaxed text-slate-700 dark:text-(--subtitle-gray) sm:text-lg">
            A coding agent that runs commands needs somewhere safe to run them. Docker Sandboxes
            give it an isolated microVM on your own machine, and the sbx command line and local
            sandboxes are free to use, including for commercial work. This is the recipe for
            pointing one at a landing zone you build on this site.
          </p>
          <MiniLandingFrame
            provider="Docker"
            category="Agentic Sandboxes"
            difficulty="Intermediate"
            title={PAGE_TITLE}
            promise={SANDBOX_LANDING_FRAME.promise}
            topology={SANDBOX_LANDING_FRAME.topology}
            howItWorks={SANDBOX_LANDING_FRAME.howItWorks}
            keyServices={SANDBOX_LANDING_FRAME.keyServices}
            practices={SANDBOX_LANDING_FRAME.practices}
            outcome={SANDBOX_LANDING_FRAME.outcome}
            onSelectPane={scrollToSection}
          />
        </div>

        <section aria-labelledby={RECIPE_HEADING_ID} className="relative">
          <SectionHeading id={RECIPE_HEADING_ID} className="mb-3">
            Run an agent against your landing zone
          </SectionHeading>
          <SandboxSection />
        </section>

        <section aria-labelledby={CLOUD_RECIPE_HEADING_ID} className="relative">
          <SectionHeading id={CLOUD_RECIPE_HEADING_ID} className="mb-3">
            Run it in a Docker cloud sandbox (--cloud)
          </SectionHeading>
          <CloudSandboxSection />
        </section>

        <p
          className="relative max-w-3xl text-sm text-slate-600 dark:text-slate-400"
          data-testid="sandboxes-checked"
        >
          The sbx command line changes often, so these commands are checked against Docker’s
          documentation. They were last checked on{' '}
          <time dateTime={CHECKED_ON.iso}>{CHECKED_ON.label}</time>.
        </p>

        <nav aria-label="More on Docker" className="relative flex flex-wrap gap-3">
          <PlaceholderLink
            link={{
              label: 'Docker Sandboxes documentation',
              href: SANDBOXES_DOCS_URL,
              external: true,
            }}
          />
          <PlaceholderLink link={{ label: 'See the browser labs', to: staticRoutes.labs }} />
          <PlaceholderLink
            link={{ label: 'Back to the Docker hub', to: routes.landing('docker') }}
          />
        </nav>
      </main>
    </>
  );
}


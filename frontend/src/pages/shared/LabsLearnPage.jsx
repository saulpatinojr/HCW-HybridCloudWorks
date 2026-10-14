/**
 * The labs list (#681, Coder Phase 3 of #659; per provider since ADR 0033
 * §3): one page, two addresses.
 *
 *   /education/labs                   the cross-provider index, every
 *                                     available lab grouped by provider hub
 *   /:provider/education/labs         one hub's labs, under its Learn section
 *
 * The provider comes from the route (`useParams`): the index has none. A
 * provider with no labs yet gets an honest empty section that says so and
 * points at the index, never a blank grid.
 *
 * WHAT IS ON IT AND WHERE IT COMES FROM.
 *   - The lab cards are derived from `@/data/labs/catalogue` and nothing else;
 *     `catalogue.test.js` checks the data, this page only renders it.
 *   - "How labs work" defines Lab, Desktop and Agent in a learner's words
 *     (components/labs/HowLabsWork.jsx).
 *   - The one-word workspace state beside the heading, and "Coder status"
 *     on the index, are `GET public/labs/coder-status` (#680); "The Hybrid
 *     Lab right now" on the index is `GET public/labs/estate` (#664). All
 *     through `usePublicData`, all answering `{ configured: false }` honestly
 *     until the host and Coder exist.
 *   - "Run an agent against your landing zone" was `SandboxSection` (#676)
 *     until it moved to the Docker hub, `/docker/sandboxes` (#774). The slot
 *     stays, with its `agent-heading` id, and holds one line pointing there,
 *     so a link to `/education/labs#agent-heading` still lands on a heading
 *     that says where the recipe went.
 *   - "Articles for these labs" lists the published articles the labs on
 *     the page point at (`articleSlugs`), and renders nothing when none do.
 *   - Beside the intro on the index, `CoderCredit` says the labs are provided
 *     using Coder and links Coder's name to its site (owner request
 *     2026-09-28). The intro names Azure Arc only as what the estate card
 *     reports, and does not say the host is onboarded (#663).
 *
 * EACH CARD OPENS ITS LAB'S PAGE under the provider showing it, or under the
 * lab's home provider from the index (LabPanePage.jsx, #751). The index is
 * also where GitHub sign-in ends: the lab host sends every top-level visit
 * here (#750), including the tab a pane's sign-in opened, and
 * `useLabSignInReturn` sends that tab on to the pane it came from. It runs in
 * an effect and only for a page entered from outside the site, so the
 * pre-rendered HTML and hydration are unaffected.
 *
 * ROUTING. `/education/labs` is a static path declared beside `/education` in
 * App.jsx, so it outranks `/:provider/education` the same way — a static
 * first segment beats a parameter in React Router's ranking. The provider
 * form is a child of `/:provider`, declared before `education/:certSlug` so
 * `labs` is never read as a certification slug (ADR 0033 §6 item 6). Both
 * are in scripts/prerender-entry.jsx, and `routes-are-complete.test.js`
 * fails if either is declared in one place and not the other.
 *
 * PRE-RENDER. The catalogue is static, so the card grid, the concepts panel
 * and the article list are in the built HTML; the status reads pre-render
 * their loading state, which is also what the browser shows until the API
 * answers. Nothing on the page reads the clock until data has arrived, so
 * hydration matches.
 */
import React from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useParams } from 'react-router';
import SectionHeading from '@/components/education/SectionHeading';
import CoderCredit from '@/components/labs/CoderCredit';
import CoderStatusCard from '@/components/labs/CoderStatusCard';
import HowLabsWork from '@/components/labs/HowLabsWork';
import LabArticles from '@/components/labs/LabArticles';
import LabCard from '@/components/labs/LabCard';
import LabPreflightCard from '@/components/labs/LabPreflightCard';
import LabsEstateCard from '@/components/labs/LabsEstateCard';
import LabsSlot from '@/components/labs/LabsSlot';
import WorkspaceStatusBadge from '@/components/labs/WorkspaceStatusBadge';
import { useLabSignInReturn } from '@/components/labs/labSignIn';
import { providerName } from '@/components/labs/labsWords';
import {
  allLabArticles,
  labsByProvider,
  labsForProvider,
  labsPath,
  providersWithLabs,
} from '@/data/labs/catalogue';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchCoderStatus, fetchLabsEstate } from '@/lib/publicApi';
import { routes, staticRoutes } from '@/lib/routeFactory';

export const PAGE_TITLE = 'Browser labs';
const SITE_ORIGIN = 'https://hybridcloudworks.com';

/** `usePublicData` keys; also what a pre-render seed would be keyed on. */
export const ESTATE_KEY = 'labs:estate';
export const CODER_STATUS_KEY = 'labs:coder-status';

/**
 * `usePublicData` starts with `data: null` and `loading: true`, and the cards
 * need to tell "nothing yet" from "the route answered 404" (also null). While
 * loading with no data the value is undefined; once the fetch settles, null
 * means what the fetcher meant by it.
 */
function settle({ data, loading }) {
  return loading && data === null ? undefined : data;
}

/** The articles the labs on this page point at, once each. */
function articlesFor(labs) {
  const seen = new Set();
  return labs
    .flatMap((lab) => lab.articleSlugs)
    .filter((entry) => {
      const key = `${entry.provider}/${entry.slug}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const MUTED = 'text-slate-600 dark:text-slate-400';
const LINK =
  'font-semibold text-slate-900 dark:text-slate-100 underline underline-offset-4 hover:text-primary';

export default function LabsLearnPage() {
  const { provider = null } = useParams();
  // The estate card is the index's; a falsy key disables the read on a
  // provider's list, where the card is not rendered.
  const estateQuery = usePublicData(() => fetchLabsEstate(), provider ? '' : ESTATE_KEY);
  const coderQuery = usePublicData(() => fetchCoderStatus(), CODER_STATUS_KEY);
  useLabSignInReturn();

  const labs = provider ? labsForProvider(provider) : null;
  const heading = provider ? `${providerName(provider)} labs` : PAGE_TITLE;
  const canonical = `${SITE_ORIGIN}${labsPath(provider)}`;
  const coderStatus = {
    status: settle(coderQuery),
    loading: coderQuery.loading,
    error: coderQuery.error,
  };
  const articles = provider ? articlesFor(labs) : allLabArticles();

  return (
    <>
      <Helmet>
        <title>{`${heading} — Coder, Docker and the Hybrid Lab | Hybrid Cloud Works`}</title>
        <meta
          name="description"
          content={
            provider
              ? `Hands-on ${providerName(provider)} labs you run in the browser or on your own machine with one docker run line, each with objectives, steps and a check the lab runner can perform.`
              : 'Hands-on labs you run in the browser through Coder or on your own machine with one docker run line: validate a Landing Zone Builder download, walk through terraform validate, and check an Ansible playbook — with the live state of the hybrid lab host beside them.'
          }
        />
        <link rel="canonical" href={canonical} />
      </Helmet>

      <div className="relative z-10 max-w-300 mx-auto w-full px-4 md:px-8 py-12 flex flex-col gap-12">
        <header>
          <p className="flex flex-wrap gap-x-1.5 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">
            <Link to={staticRoutes.education} className="underline-offset-4 hover:underline">
              Learn any cloud
            </Link>
            {provider ? (
              <>
                <span aria-hidden="true">/</span>
                <Link
                  to={routes.education(provider)}
                  className="underline-offset-4 hover:underline"
                >
                  {providerName(provider)} Learn
                </Link>
              </>
            ) : null}
            <span aria-hidden="true">/</span>
            <span>Labs</span>
          </p>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <h1 className="display-heading text-3xl sm:text-4xl text-slate-950 dark:text-white">
              {heading}
            </h1>
            <WorkspaceStatusBadge {...coderStatus} />
          </div>
          {/* The intro keeps its width (max-w-3xl, 48rem) at every size. From
              xl the credit takes the column beside it, top-aligned; below xl
              it stacks under the intro at full width. */}
          <div className="flex flex-col gap-6 xl:grid xl:grid-cols-[48rem_minmax(0,1fr)] xl:items-start xl:gap-10">
            <div>
              <p className={`${MUTED} max-w-3xl`}>
                Each lab below opens in VS Code in your browser with az, terraform, kubectl, helm
                and ansible already installed, or runs on your own machine from the same container
                image. Nothing here installs anything on your computer beyond Docker, and nothing
                you do in a lab reaches anything else: the workspaces run on the Hybrid Lab host, a
                single server whose Azure Arc status is on the live card further down this page.
              </p>
              <p className={`${MUTED} max-w-3xl mt-3`}>
                <strong className="text-slate-900 dark:text-slate-100">Open lab</strong> opens the
                lab&apos;s own page: its objectives and steps, and the workspace in a pane. The
                first time, you sign in with GitHub in a new tab that brings you back, approve the
                workspace, and land in the lab folder. Workspaces stop after an hour of inactivity
                and are limited to one CPU and two gigabytes of memory, so treat them as scratch
                space and keep anything you want in your own repository.
              </p>
            </div>
            {provider ? null : <CoderCredit />}
          </div>
        </header>

        <HowLabsWork />

        <LabPreflightCard />

        {provider ? <ProviderLabs provider={provider} labs={labs} /> : <IndexLabs />}

        {provider ? null : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <LabsEstateCard
              estate={settle(estateQuery)}
              loading={estateQuery.loading}
              error={estateQuery.error}
            />
            <CoderStatusCard {...coderStatus} />
          </div>
        )}

        <LabsSlot id="agent" title="Run an agent against your landing zone">
          <p className={`text-sm ${MUTED} max-w-3xl`}>
            The Docker Sandboxes recipe has its own page in the Docker hub now:{' '}
            <Link to={routes.sandboxes('docker')} className={LINK}>
              Run an agent in a sandbox
            </Link>
            .
          </p>
        </LabsSlot>
        <LabsSlot id="articles" title="Articles for these labs">
          {articles.length > 0 ? <LabArticles articles={articles} /> : null}
        </LabsSlot>
      </div>
    </>
  );
}

/** ", " between items, " and " before the last: "Azure, Terraform and Ansible". */
function separator(index, count) {
  if (index >= count - 1) return '';
  return index === count - 2 ? ' and ' : ', ';
}

/** One provider's labs, or the honest empty section when it has none yet. */
function ProviderLabs({ provider, labs }) {
  if (labs.length === 0) {
    return (
      <section aria-labelledby="labs-heading" data-testid="labs-empty">
        <SectionHeading id="labs-heading">Pick a lab</SectionHeading>
        <div className="glass rounded-xl p-6 flex flex-col gap-3 max-w-2xl">
          <p className="font-semibold text-slate-900 dark:text-slate-100">
            There is no {providerName(provider)} lab yet.
          </p>
          <p className={`text-sm ${MUTED}`}>
            Labs exist today for{' '}
            {providersWithLabs().map((other, index, all) => (
              <React.Fragment key={other}>
                <Link to={labsPath(other)} className={LINK}>
                  {providerName(other)}
                </Link>
                {separator(index, all.length)}
              </React.Fragment>
            ))}
            . The{' '}
            <Link to={staticRoutes.labs} className={LINK}>
              full list
            </Link>{' '}
            groups them by provider.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section aria-labelledby="labs-heading">
      <SectionHeading id="labs-heading">Pick a lab</SectionHeading>
      <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 list-none p-0">
        {labs.map((lab) => (
          <LabCard key={lab.id} lab={lab} provider={provider} />
        ))}
      </ul>
    </section>
  );
}

/** Every available lab, grouped by the provider hub that lists it. */
function IndexLabs() {
  return (
    <section aria-labelledby="labs-heading" className="flex flex-col gap-8">
      <SectionHeading id="labs-heading" className="mb-0">
        Pick a lab
      </SectionHeading>
      {labsByProvider().map((group) => (
        <div
          key={group.provider}
          aria-labelledby={`labs-${group.provider}-heading`}
          data-testid={`labs-group-${group.provider}`}
          role="group"
          className="flex flex-col gap-3"
        >
          <h3
            id={`labs-${group.provider}-heading`}
            className="text-lg font-bold text-slate-950 dark:text-white flex flex-wrap items-baseline gap-x-3"
          >
            {providerName(group.provider)}
            <Link to={labsPath(group.provider)} className={`text-sm ${LINK}`}>
              All {providerName(group.provider)} labs
            </Link>
          </h3>
          <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 list-none p-0">
            {group.labs.map((lab) => (
              <LabCard key={lab.id} lab={lab} provider={group.provider} headingLevel="h4" />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

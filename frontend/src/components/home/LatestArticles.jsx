import React from 'react';
import { Link } from 'react-router';
import { PROVIDER_GUIDE } from './providerGuide';

/**
 * The home page's latest published articles (2026-09-29). This replaced ten
 * hard-coded sample headlines, stamped "2 HRS AGO" and "3 DAYS AGO" whatever
 * the day, that no page on the site carried.
 *
 * The items are the published content the blog pages read. HomePage fetches
 * them once, because the article count in its hero comes from the same
 * response, and hands the result down; `toLatestItems` in homeContent.js
 * shapes each one. Nothing is pre-rendered into this list: the build has no
 * fresher copy of the site's articles than the browser does, and a list
 * frozen at build time would go on calling itself the latest.
 *
 * Every class below is written out whole, because Tailwind only generates
 * the classes it finds as literal strings in the source.
 */

const PROVIDER_THEMES = {
  azure: { bg: 'hsl(var(--azure-blue) / 0.16)', border: 'border-l-azure' },
  aws: { bg: 'hsl(var(--aws-orange) / 0.16)', border: 'border-l-aws' },
  gcp: { bg: 'hsl(var(--gcp-red) / 0.16)', border: 'border-l-gcp' },
  finops: { bg: 'hsl(var(--finops-green) / 0.12)', border: 'border-l-finops' },
  terraform: { bg: 'hsl(var(--terraform-purple) / 0.12)', border: 'border-l-terraform' },
  github: { bg: 'hsl(var(--github-gray) / 0.08)', border: 'border-l-github' },
  vmware: { bg: 'hsl(var(--vmware-blue) / 0.12)', border: 'border-l-vmware' },
  ansible: { bg: 'hsl(var(--ansible-red) / 0.10)', border: 'border-l-ansible' },
  docker: { bg: 'hsl(var(--docker-blue) / 0.12)', border: 'border-l-docker' },
};

/** For a document whose provider the site does not have a hub for. */
const NEUTRAL_THEME = { bg: 'hsl(var(--muted) / 0.6)', border: 'border-l-slate-400' };

const PROVIDER_IMAGES = {
  azure: '/icons/providers/azure_bg.jpg',
  aws: '/icons/providers/aws_bg.jpg',
  gcp: '/icons/providers/gcp_bg.jpg',
  finops: '/icons/providers/finops_bg.png',
  terraform: '/icons/providers/terraform_bg.png',
  github: '/icons/providers/github_bg.png',
  vmware: '/icons/providers/vmware_bg.png',
  ansible: '/icons/providers/ansible_bg.png',
};

const NEUTRAL_IMAGE = '/icons/providers/cloud_agnostic.jpg';

const PROVIDER_LABELS = Object.fromEntries(
  PROVIDER_GUIDE.map((entry) => [entry.provider, entry.label])
);

function LatestCard({ item }) {
  const theme = PROVIDER_THEMES[item.provider] || NEUTRAL_THEME;
  const providerLabel = PROVIDER_LABELS[item.provider];
  return (
    <li>
      <Link
        to={item.path}
        className={`dashboard-card rounded-md p-4 flex flex-col sm:flex-row gap-4 border-l-4 ${theme.border} transition-all group relative overflow-hidden mr-[5%] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500`}
        style={{ backgroundColor: theme.bg }}
      >
        <div className="w-full sm:w-48 h-28 bg-white/50 dark:bg-slate-800/50 rounded shrink-0 overflow-hidden relative border border-slate-200/50 dark:border-slate-700/50">
          <img
            src={PROVIDER_IMAGES[item.provider] || NEUTRAL_IMAGE}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 w-full h-full object-cover opacity-80 group-hover:scale-105 transition-transform duration-500"
          />
        </div>
        <div className="flex flex-col justify-between flex-1 py-1 min-w-0">
          <div>
            <div className="mb-1.5 text-[10px] font-mono text-slate-700 dark:text-white uppercase font-bold">
              {providerLabel ? `${providerLabel} :: ${item.typeLabel}` : item.typeLabel}
            </div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white leading-tight mb-2 group-hover:translate-x-1 transition-transform">
              {item.title}
            </h3>
            {item.summary && (
              <p className="text-sm text-slate-800 dark:text-slate-300 line-clamp-2 leading-relaxed">
                {item.summary}
              </p>
            )}
          </div>
          {item.publishedLabel && (
            <div className="flex items-center gap-4 mt-3 pt-3 border-t border-slate-900/10">
              <span className="text-xs text-slate-600 dark:text-white font-mono flex items-center gap-1 font-bold">
                <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
                  calendar_today
                </span>{' '}
                <time dateTime={item.publishedIso}>{item.publishedLabel}</time>
              </span>
            </div>
          )}
        </div>
      </Link>
    </li>
  );
}

/**
 * @param {object} props
 * @param {ReturnType<import('./homeContent').toLatestItems>} props.items
 * @param {boolean} props.loading
 * @param {Error|null} props.error
 */
export default function LatestArticles({ items, loading, error }) {
  let body;
  if (loading && items.length === 0) {
    body = (
      <p role="status" className="text-sm text-muted-foreground px-1">
        Loading the latest articles…
      </p>
    );
  } else if (error && items.length === 0) {
    body = (
      <p role="status" className="text-sm text-muted-foreground px-1">
        The latest articles could not be loaded just now. Please try again in a moment.
      </p>
    );
  } else if (items.length === 0) {
    body = (
      <p role="status" className="text-sm text-muted-foreground px-1">
        Nothing has been published yet. New articles will appear here as they go live.
      </p>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-3" data-testid="latest-articles">
        {items.map((item) => (
          <LatestCard key={item.path} item={item} />
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby="latest-articles-heading" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 glass-panel rounded-lg border border-slate-200/60 dark:border-slate-800/80">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-primary text-xl" aria-hidden="true">
            auto_stories
          </span>
          <div>
            <h2
              id="latest-articles-heading"
              className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2"
            >
              Original Engineering Deep-Dives
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Long-form architectural analysis and production implementation guides
            </p>
          </div>
        </div>
        <span className="text-[11px] font-mono font-medium px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20">
          Peer-Reviewed Editorial
        </span>
      </div>
      {body}
    </section>
  );
}

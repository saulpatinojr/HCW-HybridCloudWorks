/**
 * The card grids the provider landing pages share (AWS, Azure, Google Cloud,
 * FinOps, VMware, Ansible, Terraform, GitHub). Each landing page used to carry
 * its own copy of these, the same markup eight times over; each page now
 * keeps only its own words (the card lists) and passes them in here.
 */
import React from 'react';
import { Link } from 'react-router';
import { routes } from '@/lib/routeFactory';
import useAudioEpisodes from '@/hooks/useAudioEpisodes';
import HeroImageCarousel from '@/components/landing/HeroImageCarousel';

const SKILL_CHIP =
  'text-[10px] bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 px-1.5 py-0.5 rounded';

/** The round icon chip at the start of a card. */
function IconChip({ icon }) {
  return (
    <div className="size-10 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
      <span className="material-symbols-outlined text-primary text-base" aria-hidden="true">
        {icon}
      </span>
    </div>
  );
}

/**
 * Two wide cards with a coloured top strip: reference designs, module or
 * code collections. A card's own `to` wins; otherwise every card opens `to`.
 */
export function FeatureCardGrid({ cards, to }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {cards.map((card) => (
        <Link
          key={card.title}
          to={card.to ?? to}
          className="glass glass-hover rounded-xl overflow-hidden flex flex-col"
        >
          <div className="h-2 w-full bg-primary/60" aria-hidden="true" />
          <div className="p-5 flex flex-col gap-2 flex-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] bg-primary/15 text-primary px-2 py-0.5 rounded font-bold uppercase tracking-wide">
                {card.label}
              </span>
              <span className="text-[10px] text-slate-500">{card.meta}</span>
            </div>
            <h3 className="font-bold text-foreground">{card.title}</h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              {card.text}
            </p>
            <div className="flex gap-1 flex-wrap mt-auto pt-2">
              {card.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

function FrameworkCardBody({ abbr, name, description }) {
  return (
    <>
      <div className="flex items-center gap-3">
        <IconChip icon="account_tree" />
        <div>
          <div className="text-[10px] font-black text-primary/80 tracking-widest uppercase">
            {abbr}
          </div>
          <h3 className="text-sm font-bold text-foreground leading-snug">{name}</h3>
        </div>
      </div>
      <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">{description}</p>
    </>
  );
}

/**
 * Three framework cards. A card with a `to` is a link (the GitHub practices);
 * one without is a plain card.
 */
export function FrameworkCardGrid({ frameworks }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {frameworks.map((framework) =>
        framework.to ? (
          <Link
            key={framework.abbr}
            to={framework.to}
            className="glass glass-hover rounded-xl p-5 flex flex-col gap-3"
          >
            <FrameworkCardBody {...framework} />
          </Link>
        ) : (
          <div key={framework.abbr} className="glass rounded-xl p-5 flex flex-col gap-3">
            <FrameworkCardBody {...framework} />
          </div>
        )
      )}
    </div>
  );
}

/** The latest three episodes for a provider, each opening its audio page. */
export function EpisodeList({ provider }) {
  // Both audio sources, newest first (#349); the card shows the latest three.
  const { episodes } = useAudioEpisodes(provider);
  if (!episodes || episodes.length === 0) {
    return <p className="text-sm text-slate-500 py-2">No episodes available yet.</p>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {episodes.slice(0, 3).map((ep, i) => {
        const mins = ep.durationSeconds ? Math.floor(ep.durationSeconds / 60) : null;
        return (
          <Link
            key={ep.id}
            to={routes.audio(provider)}
            className="glass glass-hover rounded-xl flex items-start gap-3 p-4"
          >
            <div className="size-9 shrink-0 rounded-full bg-primary/10 flex items-center justify-center text-primary">
              <span className="material-symbols-outlined text-base" aria-hidden="true">
                play_circle
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[10px] bg-primary/15 text-primary px-1.5 py-0.5 rounded font-bold">
                  EP {i + 1}
                </span>
                {mins ? <span className="text-[10px] text-slate-500">{mins} min</span> : null}
              </div>
              <h3 className="text-sm font-semibold text-foreground leading-snug line-clamp-2">
                {ep.title}
              </h3>
              {ep.publishedAtString && (
                <p className="text-[10px] text-slate-500 mt-0.5">{ep.publishedAtString}</p>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

const CERT_COLUMNS = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3' };

/**
 * Certification or learning tracks. `linkFor(cert)` says where a card opens;
 * `columns` is 2 or 3 on a wide screen. A track marked `isBeta` shows a badge.
 */
export function CertTrackGrid({ certs, linkFor, columns = 2 }) {
  return (
    <div className={`grid grid-cols-1 ${CERT_COLUMNS[columns]} gap-3`}>
      {certs.map((cert) => (
        <Link
          key={cert.code}
          to={linkFor(cert)}
          className="glass glass-hover rounded-xl flex items-start gap-3 p-4"
        >
          <IconChip icon="workspace_premium" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              <span className="text-[10px] font-black text-primary">{cert.code}</span>
              {cert.isBeta && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 bg-amber-500/20 text-amber-600 dark:text-amber-400 rounded">
                  BETA
                </span>
              )}
              <span className="text-[10px] text-slate-500">
                {cert.difficulty} · {cert.duration}
              </span>
            </div>
            <h3 className="text-sm font-bold text-foreground leading-snug">{cert.title}</h3>
            <div className="flex gap-1 flex-wrap mt-1">
              {cert.skills.map((s) => (
                <span key={s} className={SKILL_CHIP}>
                  {s}
                </span>
              ))}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

/** A two-column list of shortcut links, each with an icon and a short line. */
export function QuickLinkGrid({ links }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {links.map(({ icon, title, desc, to }) => (
        <Link
          key={title}
          to={to}
          className="glass glass-hover rounded-xl flex items-center gap-3 p-4 group/item"
        >
          <div className="size-9 shrink-0 rounded-full bg-primary/10 flex items-center justify-center text-primary">
            <span className="material-symbols-outlined text-base" aria-hidden="true">
              {icon}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-foreground leading-snug">{title}</h3>
            <p className="text-[11px] text-slate-500 leading-snug">{desc}</p>
          </div>
          <span
            className="material-symbols-outlined text-slate-400 group-hover/item:text-primary transition-colors text-base shrink-0"
            aria-hidden="true"
          >
            chevron_right
          </span>
        </Link>
      ))}
    </div>
  );
}

/*
 * Section builders: the sections several landing pages share, ready to put in
 * ProviderLandingTemplate's `sections` list. Each returns the same object a
 * page would otherwise write out by hand.
 */

/**
 * The hero of a cloud provider's landing page: "Architecture intelligence
 * for <name>", a rotating image carousel, and a button to the provider's
 * designs. `stats` are the figures under the button.
 */
export function architectureHero(provider, { eyebrow, name, description, images, alt, stats }) {
  return {
    eyebrow,
    title: (
      <>
        Architecture intelligence for <span className="display-accent">{name}</span>
      </>
    ),
    description,
    media: <HeroImageCarousel images={images} intervalMs={3000} fadeMs={800} alt={alt} />,
    cta: { label: 'Explore Architectures', to: routes.architectureDesigns(provider) },
    stats,
  };
}

/** "Reference designs": the design cards, all opening the provider's designs page. */
export function designsSection(provider, title, cards, actionLabel = 'All designs') {
  const to = routes.architectureDesigns(provider);
  return {
    eyebrow: 'REFERENCE DESIGNS',
    title,
    action: { label: actionLabel, to },
    content: <FeatureCardGrid cards={cards} to={to} />,
  };
}

/** "Guidance": the framework cards. */
export function frameworksSection(provider, frameworks) {
  return {
    eyebrow: 'GUIDANCE',
    title: 'Frameworks',
    action: { label: 'All frameworks', to: routes.frameworks(provider) },
    content: <FrameworkCardGrid frameworks={frameworks} />,
  };
}

/** "On air": the latest episodes. */
export function episodesSection(provider, title) {
  return {
    eyebrow: 'ON AIR',
    title,
    action: { label: 'All episodes', to: routes.audio(provider) },
    content: <EpisodeList provider={provider} />,
  };
}

/** "Learning center": the certification tracks. */
export function certTracksSection(provider, gridProps) {
  return {
    eyebrow: 'LEARNING CENTER',
    title: 'Certification Tracks',
    action: { label: 'All certifications', to: routes.education(provider) },
    content: <CertTrackGrid {...gridProps} />,
  };
}

/** "Quick reference": the most-used links. */
export function quickLinksSection(links) {
  return {
    eyebrow: 'QUICK REFERENCE',
    title: 'Most-Used Resources',
    content: <QuickLinkGrid links={links} />,
  };
}

/** "Learning center" on the tooling pages: every track opens the provider's learning hub. */
export function learningTracksSection(provider, certs) {
  return {
    eyebrow: 'LEARNING CENTER',
    title: 'Certification & Learning Tracks',
    action: { label: 'Learning hub', to: routes.education(provider) },
    content: <CertTrackGrid certs={certs} linkFor={() => routes.education(provider)} columns={3} />,
  };
}

export { SKILL_CHIP, IconChip };

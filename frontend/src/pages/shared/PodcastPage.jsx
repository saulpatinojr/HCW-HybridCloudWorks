import React, { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { useLocation } from 'react-router';
import EpisodePlayer from '@/components/podcast/EpisodePlayer';
import useAudioEpisodes from '@/hooks/useAudioEpisodes';
import { useProvider, useProviderConfig } from '@/context/ProviderContext';
import { formatSeconds, SOURCE, SOURCE_LABELS, stripHtml } from '@/lib/audioEpisodes';
import { safeUrl } from '@/lib/safeUrl';

const PLATFORM_LOGOS = {
  spotify: '/icons/logos/spotify.png',
  apple: '/icons/logos/apple-podcast.png',
  amazon: '/icons/logos/AmazonMusic.png',
  youtube: '/icons/logos/youtube.svg',
  rss: '/icons/logos/rss.svg',
};

const PROVIDER_META = {
  // aws, azure and gcp each had a copy of this page with these classes
  // inlined; #349 folded them here so there is one player and one list.
  aws: {
    name: 'AWS',
    ogName: 'AWS',
    gradient: 'from-aws-primary via-slate-900 to-aws-primary dark:via-white',
    accent: 'text-amber-400',
    border: 'border-amber-500/30',
    badge: 'bg-amber-500/20 border-amber-500/30 text-amber-400',
    glow: 'bg-amber-500/5',
    selectedBg: 'bg-amber-500/10 border-amber-500/40',
    hoverBorder: 'hover:border-amber-500/20',
    playBtn:
      'from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-700 shadow-amber-500/25',
    subscribeBg: 'from-amber-500/20 to-orange-900/20',
    subscribeBorder: 'border-amber-500/30',
    subscribeIcon: 'text-amber-400',
    subscribeHover: 'hover:bg-amber-500/20 hover:border-amber-500/40',
    progressBar: 'from-amber-500 to-orange-400',
    placeholder: 'from-amber-600/30 to-orange-900/40 border-amber-500/20',
    placeholderIcon: 'text-amber-400/60',
    sectionIcon: 'text-amber-400',
  },
  azure: {
    name: 'Azure',
    ogName: 'Azure',
    gradient: 'from-azure-primary via-slate-900 to-azure-primary dark:via-white',
    accent: 'text-primary',
    border: 'border-primary/30',
    badge: 'bg-primary/20 border-primary/30 text-primary',
    glow: 'bg-primary/5',
    selectedBg: 'bg-primary/10 border-primary/40',
    hoverBorder: 'hover:border-primary/20',
    playBtn: 'from-primary to-blue-700 hover:from-blue-500 hover:to-blue-800 shadow-primary/25',
    subscribeBg: 'from-primary/20 to-blue-900/20',
    subscribeBorder: 'border-primary/30',
    subscribeIcon: 'text-primary',
    subscribeHover: 'hover:bg-primary/20 hover:border-primary/40',
    progressBar: 'from-primary to-blue-400',
    placeholder: 'from-blue-600/30 to-blue-900/40 border-blue-500/20',
    placeholderIcon: 'text-blue-400/60',
    sectionIcon: 'text-primary',
  },
  gcp: {
    name: 'Google Cloud',
    ogName: 'Google Cloud',
    gradient: 'from-gcp-primary via-slate-900 to-gcp-primary dark:via-white',
    accent: 'text-red-400',
    border: 'border-red-500/30',
    badge: 'bg-red-500/20 border-red-500/30 text-red-400',
    glow: 'bg-red-500/5',
    selectedBg: 'bg-red-500/10 border-red-500/40',
    hoverBorder: 'hover:border-red-500/20',
    playBtn: 'from-red-500 to-blue-600 hover:from-red-400 hover:to-blue-700 shadow-red-500/25',
    subscribeBg: 'from-red-500/20 to-blue-900/20',
    subscribeBorder: 'border-red-500/30',
    subscribeIcon: 'text-red-400',
    subscribeHover: 'hover:bg-red-500/20 hover:border-red-500/40',
    progressBar: 'from-red-500 to-blue-400',
    placeholder: 'from-red-600/30 to-blue-900/40 border-red-500/20',
    placeholderIcon: 'text-red-400/60',
    sectionIcon: 'text-red-400',
  },
  github: {
    name: 'GitHub',
    gradient:
      'from-slate-700 via-slate-900 to-slate-700 dark:from-slate-400 dark:via-white dark:to-slate-300',
    accent: 'text-slate-400',
    border: 'border-slate-500/30',
    badge: 'bg-slate-500/20 border-slate-500/30 text-slate-400',
    glow: 'bg-slate-500/5',
    selectedBg: 'bg-slate-500/10 border-slate-500/40',
    hoverBorder: 'hover:border-slate-500/20',
    playBtn:
      'from-slate-500 to-slate-700 hover:from-slate-400 hover:to-slate-800 shadow-slate-500/25',
    subscribeBg: 'from-slate-500/20 to-slate-900/20',
    subscribeBorder: 'border-slate-500/30',
    subscribeIcon: 'text-slate-400',
    subscribeHover: 'hover:bg-slate-500/20 hover:border-slate-500/40',
    progressBar: 'from-slate-400 to-slate-300',
    placeholder: 'from-slate-600/30 to-slate-900/40 border-slate-500/20',
    placeholderIcon: 'text-slate-400/60',
    sectionIcon: 'text-slate-400',
  },
  terraform: {
    name: 'Terraform',
    gradient: 'from-terraform-primary via-slate-900 to-terraform-primary dark:via-white',
    accent: 'text-purple-400',
    border: 'border-purple-500/30',
    badge: 'bg-purple-500/20 border-purple-500/30 text-purple-400',
    glow: 'bg-purple-500/5',
    selectedBg: 'bg-purple-500/10 border-purple-500/40',
    hoverBorder: 'hover:border-purple-500/20',
    playBtn:
      'from-purple-500 to-purple-700 hover:from-purple-400 hover:to-purple-800 shadow-purple-500/25',
    subscribeBg: 'from-purple-500/20 to-purple-900/20',
    subscribeBorder: 'border-purple-500/30',
    subscribeIcon: 'text-purple-400',
    subscribeHover: 'hover:bg-purple-500/20 hover:border-purple-500/40',
    progressBar: 'from-purple-400 to-purple-300',
    placeholder: 'from-purple-600/30 to-purple-900/40 border-purple-500/20',
    placeholderIcon: 'text-purple-400/60',
    sectionIcon: 'text-purple-400',
  },
  finops: {
    name: 'FinOps',
    gradient: 'from-finops-primary via-slate-900 to-finops-primary dark:via-white',
    accent: 'text-emerald-400',
    border: 'border-emerald-500/30',
    badge: 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400',
    glow: 'bg-emerald-500/5',
    selectedBg: 'bg-emerald-500/10 border-emerald-500/40',
    hoverBorder: 'hover:border-emerald-500/20',
    playBtn:
      'from-emerald-500 to-emerald-700 hover:from-emerald-400 hover:to-emerald-800 shadow-emerald-500/25',
    subscribeBg: 'from-emerald-500/20 to-emerald-900/20',
    subscribeBorder: 'border-emerald-500/30',
    subscribeIcon: 'text-emerald-400',
    subscribeHover: 'hover:bg-emerald-500/20 hover:border-emerald-500/40',
    progressBar: 'from-emerald-400 to-emerald-300',
    placeholder: 'from-emerald-600/30 to-emerald-900/40 border-emerald-500/20',
    placeholderIcon: 'text-emerald-400/60',
    sectionIcon: 'text-emerald-400',
  },
  vmware: {
    name: 'VMware',
    gradient:
      'from-sky-700 via-sky-900 to-sky-700 dark:from-sky-400 dark:via-white dark:to-sky-300',
    accent: 'text-sky-400',
    border: 'border-sky-500/30',
    badge: 'bg-sky-500/20 border-sky-500/30 text-sky-400',
    glow: 'bg-sky-500/5',
    selectedBg: 'bg-sky-500/10 border-sky-500/40',
    hoverBorder: 'hover:border-sky-500/20',
    playBtn: 'from-sky-500 to-sky-700 hover:from-sky-400 hover:to-sky-800 shadow-sky-500/25',
    subscribeBg: 'from-sky-500/20 to-sky-900/20',
    subscribeBorder: 'border-sky-500/30',
    subscribeIcon: 'text-sky-400',
    subscribeHover: 'hover:bg-sky-500/20 hover:border-sky-500/40',
    progressBar: 'from-sky-400 to-sky-300',
    placeholder: 'from-sky-600/30 to-sky-900/40 border-sky-500/20',
    placeholderIcon: 'text-sky-400/60',
    sectionIcon: 'text-sky-400',
  },
  ansible: {
    name: 'Red Hat Ansible',
    gradient:
      'from-red-700 via-red-900 to-red-700 dark:from-red-400 dark:via-white dark:to-red-300',
    accent: 'text-red-400',
    border: 'border-red-500/30',
    badge: 'bg-red-500/20 border-red-500/30 text-red-400',
    glow: 'bg-red-500/5',
    selectedBg: 'bg-red-500/10 border-red-500/40',
    hoverBorder: 'hover:border-red-500/20',
    playBtn: 'from-red-500 to-red-700 hover:from-red-400 hover:to-red-800 shadow-red-500/25',
    subscribeBg: 'from-red-500/20 to-red-900/20',
    subscribeBorder: 'border-red-500/30',
    subscribeIcon: 'text-red-400',
    subscribeHover: 'hover:bg-red-500/20 hover:border-red-500/40',
    progressBar: 'from-red-400 to-red-300',
    placeholder: 'from-red-600/30 to-red-900/40 border-red-500/20',
    placeholderIcon: 'text-red-400/60',
    sectionIcon: 'text-red-400',
  },
  // #777. Docker blue (--color-docker-primary, #1D63ED) for the heading, and
  // Tailwind's blue scale for the rest, as the other rows use their own.
  docker: {
    name: 'Docker',
    gradient: 'from-docker-primary via-slate-900 to-docker-primary dark:via-white',
    accent: 'text-blue-400',
    border: 'border-blue-500/30',
    badge: 'bg-blue-500/20 border-blue-500/30 text-blue-400',
    glow: 'bg-blue-500/5',
    selectedBg: 'bg-blue-500/10 border-blue-500/40',
    hoverBorder: 'hover:border-blue-500/20',
    playBtn: 'from-blue-500 to-blue-700 hover:from-blue-400 hover:to-blue-800 shadow-blue-500/25',
    subscribeBg: 'from-blue-500/20 to-blue-900/20',
    subscribeBorder: 'border-blue-500/30',
    subscribeIcon: 'text-blue-400',
    subscribeHover: 'hover:bg-blue-500/20 hover:border-blue-500/40',
    progressBar: 'from-blue-400 to-blue-300',
    placeholder: 'from-blue-600/30 to-blue-900/40 border-blue-500/20',
    placeholderIcon: 'text-blue-400/60',
    sectionIcon: 'text-blue-400',
  },
};

/** Deliberately generic. See where it is used. */
const FALLBACK_META = {
  name: 'Podcast',
  gradient:
    'from-slate-700 via-slate-900 to-slate-700 dark:from-slate-400 dark:via-white dark:to-slate-300',
  accent: 'text-slate-400',
  border: 'border-slate-500/30',
  badge: 'bg-slate-500/20 border-slate-500/30 text-slate-400',
  glow: 'bg-slate-500/5',
  selectedBg: 'bg-slate-500/10 border-slate-500/40',
  hoverBorder: 'hover:border-slate-500/20',
  playBtn:
    'from-slate-500 to-slate-700 hover:from-slate-400 hover:to-slate-800 shadow-slate-500/25',
  subscribeBg: 'from-slate-500/20 to-slate-900/20',
  subscribeBorder: 'border-slate-500/30',
  subscribeIcon: 'text-slate-400',
  subscribeHover: 'hover:bg-slate-500/20 hover:border-slate-500/40',
  progressBar: 'from-slate-400 to-slate-300',
  placeholder: 'from-slate-600/30 to-slate-900/40 border-slate-500/20',
  placeholderIcon: 'text-slate-400/60',
  sectionIcon: 'text-slate-400',
};

/**
 * Last resort only. Prefer the prop or the router context.
 *
 * This used to be the ONLY source, with an incomplete list and `github` as the
 * default, so /vmware/audio and /ansible/audio served pages titled "GitHub
 * Podcast" at HTTP 200 on indexable URLs (#183). Sniffing the path re-derives
 * what the router already knows, and it failed by silently adopting another
 * provider's identity rather than by being visibly unset.
 */
function detectProvider(pathname) {
  const match = /^\/([a-z-]+)(?:\/|$)/.exec(pathname || '');
  return match ? match[1] : null;
}

/**
 * The subscribe box. Renders nothing when no platform has a link: an empty
 * "Subscribe Now" box reads as broken UI (#348). Kept out of the page
 * component so the page stays under the complexity ceiling.
 */
function SubscribeSidebar({ meta, platforms, urlFor }) {
  if (platforms.length === 0) return null;
  return (
    <aside className="h-fit sticky top-28">
      <div
        className={`bg-gradient-to-br ${meta.subscribeBg} backdrop-blur-md border ${meta.subscribeBorder} rounded-2xl p-6`}
      >
        <h3 className="text-lg font-bold mb-2 flex items-center gap-2">
          <span className={`material-symbols-outlined ${meta.subscribeIcon} text-[20px]`}>
            podcast
          </span>
          Subscribe Now
        </h3>
        <p className="text-sm text-foreground mb-5">
          Get new episodes delivered to your favorite podcast app.
        </p>
        <div className="space-y-2">
          {platforms.map((platform) => (
            <a
              key={platform.key}
              href={urlFor(platform)}
              target="_blank"
              rel="noopener noreferrer"
              className={`w-full py-2.5 px-3 bg-card/50 ${meta.subscribeHover} border border-card/60 text-foreground rounded-lg transition-all text-sm font-semibold flex items-center gap-3`}
            >
              <img
                src={PLATFORM_LOGOS[platform.key]}
                alt={platform.name}
                loading="lazy"
                decoding="async"
                width="20"
                height="20"
                className="w-5 h-5 object-contain rounded-sm flex-shrink-0"
              />
              {platform.name}
            </a>
          ))}
        </div>
      </div>
    </aside>
  );
}

function EpisodeImage({ image, title, size = 'md', meta }) {
  const sizeClass = size === 'sm' ? 'w-14 h-14' : 'w-full aspect-square max-w-[200px]';
  // Decide on the sanitised value: an unsafe URL gets the placeholder, not
  // an <img> with no src.
  const src = safeUrl(image);
  if (src) {
    return (
      <img
        src={src}
        alt={title}
        loading="lazy"
        decoding="async"
        className={`${sizeClass} rounded-lg object-cover flex-shrink-0`}
      />
    );
  }
  return (
    <div
      className={`${sizeClass} rounded-lg bg-gradient-to-br ${meta.placeholder} flex items-center justify-center flex-shrink-0`}
    >
      <span className={`material-symbols-outlined ${meta.placeholderIcon} text-3xl`}>podcasts</span>
    </div>
  );
}

/**
 * Filter order, which is also the order the list itself leads with: the site's
 * show, then this provider's feed, then the study episodes.
 */
const FILTER_ORDER = [SOURCE.main, SOURCE.host, SOURCE.listenAndLearn];

/**
 * The filter chips this list needs: none at all below two sources, otherwise
 * `All` and one chip per source PRESENT.
 *
 * Present, not possible. A chip for a source with no rows filters the list to
 * nothing and reads as a page that lost its episodes — and which sources a
 * page has is now a real question rather than a fixed pair, since a provider
 * with no feed of its own still shows the site's show.
 */
export function sourceFilters(episodes) {
  const present = FILTER_ORDER.filter((key) => episodes.some((episode) => episode.source === key));
  if (present.length < 2) return [];
  return [
    { key: 'all', label: 'All' },
    ...present.map((key) => ({ key, label: SOURCE_LABELS[key] })),
  ];
}

/** The sources this page has, named in the order the list leads with them. */
function heroSources(episodes, providerName) {
  const phrases = {
    [SOURCE.main]: "the site's show",
    [SOURCE.host]: `the ${providerName} feed`,
    [SOURCE.listenAndLearn]: `the Listen & Learn study episodes for ${providerName} certifications`,
  };
  return FILTER_ORDER.filter((key) => episodes.some((episode) => episode.source === key)).map(
    (key) => phrases[key]
  );
}

/** `a`, `a and b`, `a, b, and c`. */
function joinPhrases(phrases) {
  if (phrases.length <= 1) return phrases[0] ?? '';
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(', ')}, and ${phrases.at(-1)}`;
}

/**
 * The sentence under the title, naming the sources the page ACTUALLY has.
 *
 * It used to name the provider's feed unconditionally, which was true of every
 * page only for as long as a provider feed was the only thing a page could
 * hold. It is not any more, and the page it is wrong on is the one this whole
 * change exists to produce: a provider with no feed of its own, showing the
 * site's show. Promising a reader an "{Azure} feed" that no row on the page
 * came from is the same class of mistake as an empty Subscribe box (#348) —
 * copy describing a page other than the one being rendered.
 *
 * "in one place" goes with more than one source, for the same reason: it is a
 * claim about bringing things together, and one thing is not gathered.
 */
export function heroBlurb(episodes, providerName) {
  const base = `Deep-dive podcast discussions on ${providerName} architecture, patterns, and enterprise solutions`;
  const sources = heroSources(episodes, providerName);
  if (sources.length === 0) return `${base}.`;
  return `${base} — ${joinPhrases(sources)}${sources.length > 1 ? ', in one place' : ''}.`;
}

/**
 * A source chip on a list row. Listen & Learn rows say which exam; feed rows
 * say they came from the show. The label is the row's `sourceLabel`, set by
 * lib/audioEpisodes.js, so the page never inspects a document.
 */
function SourceChip({ episode }) {
  return (
    <span className="px-2 py-0.5 rounded bg-card/60 border border-card/80 text-[11px] font-semibold text-foreground/80 whitespace-nowrap">
      {episode.sourceLabel}
    </span>
  );
}

/** The rows a source filter leaves in the list. */
function visibleFor(episodes, filter) {
  return filter === 'all' ? episodes : episodes.filter((e) => e.source === filter);
}

/**
 * The player follows the list it sits above: a selection the filter hides
 * gives way to the first visible episode rather than playing something the
 * list no longer shows.
 */
function featuredFor(visible, selectedId) {
  return (selectedId ? visible.find((e) => e.id === selectedId) : null) ?? visible[0] ?? null;
}

export default function SharedPodcastPage({ provider: providerProp } = {}) {
  const { pathname } = useLocation();
  const ctxProvider = useProvider();
  // Prop, then router context, then the path. The first two know the answer;
  // the third is a guess, reached only when both are absent.
  const provider = providerProp || ctxProvider || detectProvider(pathname);
  // A generic podcast page is wrong in a way a reader can see. Another
  // provider's name and colours is wrong in a way that looks deliberate.
  const meta = PROVIDER_META[provider] || FALLBACK_META;
  const podcastConfig = useProviderConfig();
  // Both audio systems, one list (#349): the host's ingested feed and the
  // published Listen & Learn episodes for this provider, newest first.
  const { episodes, feedUrl, loading } = useAudioEpisodes(provider);

  const [selectedId, setSelectedId] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [filter, setFilter] = useState('all');

  const visible = visibleFor(episodes, filter);
  const featured = featuredFor(visible, selectedId);
  const featuredId = featured?.id ?? null;

  // Pin the selection the moment playback starts. The two sources answer
  // independently (useAudioEpisodes), so the list can re-sort after the page
  // has settled — and until a row is clicked the featured episode is only
  // `visible[0]`, so a later arrival at the top would remount the player and
  // stop the audio under the listener. Before playback a re-sort is free to
  // move the featured episode; that is what keeps the newest one there.
  // A plain function, like the two handlers below: a useCallback here reads
  // `featuredId`, which the React Compiler will not accept as a preservable
  // manual memoization (react-hooks/preserve-manual-memoization).
  function onPlayingChange(playing) {
    setIsPlaying(playing);
    if (playing) setSelectedId((current) => current ?? featuredId);
  }

  // The player is stateful and cannot be paused from here, so the page-level
  // flag is reset only when the featured episode actually changes — that is
  // when the player remounts paused. A filter that keeps the featured
  // episode, or a click on the row already playing, leaves audio running and
  // the indicator with it; otherwise the list would say "stopped" over a
  // player that is not.
  function selectEpisode(id) {
    setSelectedId(id);
    if (id !== featured?.id) setIsPlaying(false);
  }
  function selectFilter(key) {
    const next = featuredFor(visibleFor(episodes, key), selectedId);
    setFilter(key);
    if (next?.id !== featured?.id) setIsPlaying(false);
  }

  const filters = sourceFilters(episodes);

  const platforms = [
    { key: 'spotify', name: 'Spotify' },
    { key: 'apple', name: 'Apple Podcasts' },
    { key: 'amazon', name: 'Amazon Music' },
    { key: 'youtube', name: 'YouTube' },
    { key: 'rss', name: 'RSS feed' },
  ];
  // Only platforms with a link are offered, and the whole sidebar goes when
  // there are none: an empty "Subscribe Now" box reads as broken UI (#348).
  // The RSS link is the feed the ingest timer reads (admin_config/
  // podcast_feeds, served on GET public/podcasts), so the button and the
  // list beside it cannot name two different feeds; the static config is a
  // fallback only. `feedUrl` is already this provider's feed or, where it has
  // none, the site's show — useAudioEpisodes resolves that, because it is the
  // hook that knows which rows the list is showing.
  // Sanitised here rather than at the `href`, so one call covers both uses:
  // the filter below decides which buttons exist, and the sidebar renders the
  // same value. An unsafe scheme in a provider config or a seeded feed URL
  // therefore removes the button instead of becoming a clickable link.
  const subscribeUrlFor = (platform) =>
    safeUrl(
      platform.key === 'rss'
        ? feedUrl || podcastConfig?.podcast?.feedUrl
        : podcastConfig?.podcast?.subscribeLinks?.[platform.key]
    );
  const availablePlatforms = platforms.filter((platform) => subscribeUrlFor(platform));

  return (
    <>
      <Helmet>
        <title>{`${meta.name} Podcast | HCW`}</title>
        <meta
          name="description"
          content={`Expert audio episodes on ${meta.name} architecture, patterns, and enterprise solutions.`}
        />
        <meta property="og:title" content={`${meta.ogName || meta.name} Podcast Series`} />
        <meta
          property="og:description"
          content={`Deep-dive podcast discussions on ${meta.name} architecture and design.`}
        />
      </Helmet>

      <main className="flex-grow pt-28 pb-20 px-4 md:px-8 max-w-[1440px] mx-auto w-full">
        {/* Hero */}
        <section className="mb-10 relative">
          <div
            className={`absolute -top-10 -left-10 w-96 h-96 ${meta.glow} blur-3xl rounded-full pointer-events-none`}
          />
          <h1 className="text-3xl sm:text-5xl md:text-6xl font-bold mb-4 relative z-10">
            <span className={`bg-clip-text text-transparent bg-gradient-to-r ${meta.gradient}`}>
              {meta.name} Podcast
            </span>
          </h1>
          <p className="text-base sm:text-lg text-foreground max-w-3xl relative z-10">
            {heroBlurb(episodes, meta.name)}
          </p>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-8">
          {/* Left: Featured + Episode List */}
          <div className="space-y-8">
            {loading && !featured && (
              <div
                className={`bg-card/40 ${meta.border} border rounded-2xl p-8 text-foreground animate-pulse h-64`}
              />
            )}

            {featured && (
              <EpisodePlayer
                key={featured.id}
                episode={featured}
                meta={meta}
                onPlayingChange={onPlayingChange}
              />
            )}

            {!loading && !featured && (
              <div
                className={`bg-card/40 border ${meta.border} rounded-2xl p-8 text-foreground text-sm`}
              >
                No episodes available yet.
              </div>
            )}

            {/* Episode List */}
            <section>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <h3 className="text-xl font-bold flex items-center gap-2">
                  <span className={`material-symbols-outlined ${meta.sectionIcon} text-[22px]`}>
                    library_music
                  </span>
                  All Episodes
                </h3>
                {filters.length > 0 && (
                  <div role="group" aria-label="Filter episodes by source" className="flex gap-1">
                    {filters.map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        aria-pressed={filter === option.key}
                        onClick={() => selectFilter(option.key)}
                        className={`px-3 py-1 rounded-full text-xs font-semibold border transition-colors ${
                          filter === option.key
                            ? meta.selectedBg
                            : `bg-card/30 border-card/50 hover:bg-card/50 ${meta.hoverBorder}`
                        }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {loading && visible.length === 0 && (
                <div className="space-y-3">
                  {[...Array(3)].map((_, i) => (
                    <div
                      key={i}
                      className="h-20 rounded-xl bg-card/30 animate-pulse border border-card/50"
                    />
                  ))}
                </div>
              )}
              <div className="space-y-2">
                {visible.map((ep) => {
                  const isSelected = featured?.id === ep.id;
                  return (
                    <button
                      key={ep.id}
                      type="button"
                      onClick={() => selectEpisode(ep.id)}
                      aria-current={isSelected ? 'true' : undefined}
                      className={`w-full text-left flex items-center gap-4 p-3 rounded-xl border transition-all duration-200
                        ${
                          isSelected
                            ? meta.selectedBg
                            : `bg-card/30 border-card/50 hover:bg-card/50 ${meta.hoverBorder}`
                        }`}
                    >
                      <EpisodeImage image={ep.image} title={ep.title} size="sm" meta={meta} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <p
                            className={`text-sm font-semibold truncate ${isSelected ? meta.accent : 'text-white'}`}
                          >
                            {ep.title}
                          </p>
                          <SourceChip episode={ep} />
                        </div>
                        <p className="text-xs text-foreground line-clamp-1 mt-0.5">
                          {stripHtml(ep.description)}
                        </p>
                      </div>
                      <div className="flex-shrink-0 text-right space-y-1">
                        <p className="text-xs text-foreground flex items-center gap-1 justify-end">
                          <span className="material-symbols-outlined text-[13px]">schedule</span>
                          {formatSeconds(ep.durationSeconds)}
                        </p>
                        {ep.publishedAtString && (
                          <p className="text-xs text-foreground/60">{ep.publishedAtString}</p>
                        )}
                      </div>
                      {isSelected && isPlaying && (
                        <span
                          className={`material-symbols-outlined ${meta.accent} text-[18px] flex-shrink-0`}
                        >
                          graphic_eq
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          </div>

          {/* Right Sidebar: Subscribe */}
          <SubscribeSidebar meta={meta} platforms={availablePlatforms} urlFor={subscribeUrlFor} />
        </div>
      </main>
    </>
  );
}

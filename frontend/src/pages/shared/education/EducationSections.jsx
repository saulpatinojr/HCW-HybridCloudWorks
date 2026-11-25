/**
 * Sections the provider education pages share: the hero, the two "official
 * resource" link cards, the "Learning Paths" picker and the "Learning
 * Resources" grid.
 * Each page used to carry its own copy, differing only in colour and words;
 * the page now passes its words and a colour name (see ./educationTones).
 */
import React, { useState } from 'react';
import { OFFICIAL_CARD_TONES, PATH_TONES } from './educationTones';

/**
 * The page's opening section: soft background glows, the title in a
 * gradient, a sentence about the hub, and one badge per certification level.
 * `glows` and `gradient` are full Tailwind class strings; `levelMeta[level]`
 * gives each badge its `badge` classes.
 */
export function EducationHero({ glows, gradient, title, levels, levelMeta, children }) {
  return (
    <section className="mb-12 relative">
      {glows.map((glow) => (
        <div key={glow} className={glow} />
      ))}
      <h1 className="text-3xl sm:text-5xl md:text-6xl font-bold mb-4 relative z-10">
        <span className={`bg-clip-text text-transparent ${gradient}`}>{title}</span>
      </h1>
      <p className="text-base sm:text-lg text-foreground max-w-3xl relative z-10">{children}</p>
      <div className="flex flex-wrap gap-2 mt-4 relative z-10">
        {levels.map((level) => (
          <span
            key={level}
            className={`px-3 py-1 border text-xs font-bold rounded-full ${levelMeta[level].badge}`}
          >
            {level}
          </span>
        ))}
      </div>
    </section>
  );
}

function OpenInNewIcon({ size = 'text-[16px]' }) {
  return (
    <span className={`material-symbols-outlined ${size}`} aria-hidden="true">
      open_in_new
    </span>
  );
}

/**
 * One big link card to the issuer's own site. `text` is the sentence under
 * the title; `address` is the short web address shown at the bottom.
 */
function OfficialLinkCard({ href, tone, icon, title, badge, address, text }) {
  const t = OFFICIAL_CARD_TONES[tone];
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`group relative ${t.card} transition-all duration-300 flex items-start gap-5`}
    >
      <div
        className={`w-14 h-14 shrink-0 ${t.iconBox} rounded-xl flex items-center justify-center`}
      >
        <span className={`${t.icon} text-[28px] material-symbols-outlined`} aria-hidden="true">
          {icon}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <h2
            className={`text-lg font-bold text-slate-950 dark:text-white ${t.titleHover} transition-colors`}
          >
            {title}
          </h2>
          <span
            className={`px-2 py-0.5 ${t.badge} text-[10px] font-bold rounded-full uppercase tracking-wider shrink-0`}
          >
            {badge}
          </span>
        </div>
        <p className="text-sm text-foreground mb-3">{text}</p>
        <div className={`flex items-center gap-1.5 ${t.link} text-sm font-semibold`}>
          <OpenInNewIcon />
          {address}
        </div>
      </div>
    </a>
  );
}

/**
 * The official link cards side by side, as their own section. Each entry of
 * `links` is one card: { href, tone, icon, title, badge, address, text }.
 */
export function OfficialLinksSection({ links }) {
  return (
    <section className="mb-12">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {links.map((link) => (
          <OfficialLinkCard key={link.href} {...link} />
        ))}
      </div>
    </section>
  );
}

/** The "Learning Paths" heading and the drop-down that picks a path. */
function PathPicker({ paths, value, onChange, tone }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
      <h3 className="text-2xl font-bold text-slate-950 dark:text-white flex items-center gap-2">
        <span
          className={`${tone.heading} text-[24px] material-symbols-outlined`}
          aria-hidden="true"
        >
          bookmark
        </span>
        Learning Paths
      </h3>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className={`appearance-none bg-card/40 backdrop-blur-md border border-card/50 text-foreground text-sm rounded-xl px-4 pr-10 h-10 ${tone.select} transition-colors cursor-pointer`}
        >
          {paths.map((p, i) => (
            <option key={i} value={i} className="bg-slate-900">
              {p.certCode} — {p.title}
            </option>
          ))}
        </select>
        <span
          className="absolute right-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-[16px] text-foreground pointer-events-none"
          aria-hidden="true"
        >
          expand_more
        </span>
      </div>
    </div>
  );
}

/** The chosen path in full: its numbers, its modules and a link to the exam. */
function PathDetail({ path, tone, issuer }) {
  return (
    <article
      className={`bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-8 ${tone.card} transition-all duration-300`}
    >
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <span className={`px-3 py-1 ${tone.code} text-xs font-bold rounded font-mono`}>
          {path.certCode}
        </span>
        <span className="px-3 py-1 bg-card/50 text-foreground text-xs font-bold rounded">
          {path.level}
        </span>
        <span className="text-sm text-foreground/60">{path.hours} hours</span>
      </div>
      <h2 className="text-3xl font-bold text-slate-950 dark:text-white mb-2">{path.title}</h2>
      <p className="text-foreground mb-6 text-lg">{path.description}</p>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
        <div className="bg-card/60 rounded-lg p-4">
          <div className="text-sm text-foreground mb-1">Total Hours</div>
          <div className={`text-2xl font-bold ${tone.hours}`}>{path.hours}</div>
        </div>
        <div className="bg-card/60 rounded-lg p-4">
          <div className="text-sm text-foreground mb-1">Modules</div>
          <div className={`text-2xl font-bold ${tone.count}`}>{path.modules.length}</div>
        </div>
      </div>

      <h3 className="text-sm font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wider mb-3">
        Modules
      </h3>
      <div className="space-y-2">
        {path.modules.map((mod, i) => (
          <div
            key={i}
            className="flex items-center gap-3 p-3 bg-card/30 rounded-lg border border-card/40"
          >
            <span
              className={`w-6 h-6 rounded-full ${tone.step} text-xs font-bold flex items-center justify-center shrink-0`}
            >
              {i + 1}
            </span>
            <span className="text-sm text-foreground">{mod.title}</span>
          </div>
        ))}
      </div>

      <div className="mt-8 flex flex-col sm:flex-row gap-3">
        <a
          href={path.certUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`flex-1 h-11 px-4 ${tone.button} font-bold rounded-lg transition-colors flex items-center justify-center gap-2`}
        >
          <OpenInNewIcon />
          View {path.certCode} on {issuer}
        </a>
      </div>
    </article>
  );
}

/**
 * "Learning Paths": a drop-down of paths and the chosen one shown in full.
 * `issuer` finishes the button's words, "View CDL on <issuer>".
 */
export function LearningPathsSection({ paths, palette, issuer }) {
  const [selectedPathId, setSelectedPathId] = useState(0);
  const tone = PATH_TONES[palette];
  const selectedPath = paths[selectedPathId];
  return (
    <section className="mb-16">
      <PathPicker paths={paths} value={selectedPathId} onChange={setSelectedPathId} tone={tone} />
      {selectedPath && <PathDetail path={selectedPath} tone={tone} issuer={issuer} />}
    </section>
  );
}

/** "Learning Resources": a grid of outside links, each with an icon and a type. */
export function LearningResourcesSection({ resources, palette }) {
  const tone = PATH_TONES[palette];
  return (
    <section className="mb-16">
      <h3 className="text-2xl font-bold text-slate-950 dark:text-white mb-6 flex items-center gap-2">
        <span
          className={`${tone.heading} text-[24px] material-symbols-outlined`}
          aria-hidden="true"
        >
          library_books
        </span>
        Learning Resources
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        {resources.map((resource) => (
          <a
            key={resource.id}
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
            className={`group bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6 flex flex-col ${tone.card} transition-all duration-300`}
          >
            <div
              className={`w-12 h-12 rounded-xl ${tone.iconBox} flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}
            >
              <span
                className={`material-symbols-outlined ${tone.icon} text-[24px]`}
                aria-hidden="true"
              >
                {resource.icon}
              </span>
            </div>
            <div className={`text-xs font-bold ${tone.type} uppercase tracking-wider mb-1`}>
              {resource.type}
            </div>
            <h4
              className={`font-bold text-slate-950 dark:text-white mb-2 ${tone.titleHover} transition-colors`}
            >
              {resource.title}
            </h4>
            <p className="text-xs text-foreground flex-1">{resource.description}</p>
            <div className={`mt-4 flex items-center gap-1 ${tone.icon} text-xs font-semibold`}>
              Explore <OpenInNewIcon size="text-[14px]" />
            </div>
          </a>
        ))}
      </div>
    </section>
  );
}

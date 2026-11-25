/**
 * The building blocks the certification and microcredential detail pages
 * share: the "not found" page, a card section with an icon heading, the
 * topic grid, the numbered module list, the "study next" links, the sidebar
 * buttons, the prerequisites card, one row of quick stats, and the link back.
 *
 * Each page passes a `tone`: the Tailwind class strings for its accent colour
 * and layout, written out in full so Tailwind can find them. The keys are:
 *
 *   main            the <main> element's classes
 *   accentText      the accent text colour (icons, exam code, study hours)
 *   hoverText       the accent colour on hover (breadcrumb and back links)
 *   primaryButton   the filled button's colours
 *   cardHoverBorder a link card's border colour on hover
 *   groupHoverTitle a link card's title colour on hover
 *   groupHoverIcon  a link card's trailing icon colour on hover
 *   numberBadge     the numbered circle in the module list
 *   sideButton      the layout classes of the sidebar buttons
 */
import React from 'react';
import { Link } from 'react-router';

const CARD = 'bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6';

/** The page shown when the slug in the address matches no entry. */
export function DetailNotFound({ tone, heading, noun, slug, backTo, backLabel }) {
  return (
    <main className={tone.main}>
      <div className="text-center py-20">
        <span
          className={`${tone.accentText} text-[64px] material-symbols-outlined mb-4 block`}
          aria-hidden="true"
        >
          search_off
        </span>
        <h1 className="text-3xl font-bold text-slate-950 dark:text-white mb-4">{heading}</h1>
        <p className="text-foreground mb-8">
          {`The ${noun} `}
          <code className={`font-mono ${tone.accentText}`}>{slug}</code>
          {' was not found.'}
        </p>
        <Link
          to={backTo}
          className={`px-6 h-11 ${tone.primaryButton} font-bold rounded-lg transition-colors inline-flex items-center gap-2`}
        >
          <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
            arrow_back
          </span>
          {backLabel}
        </Link>
      </div>
    </main>
  );
}

/** Study hours, prep time and, when known, the average pass rate, under the hero's title. */
export function HeroStats({ cert, hoursClass, passRateClass }) {
  return (
    <div className="flex flex-wrap gap-6 text-sm">
      <div>
        <div className="text-foreground/60 mb-0.5">Study Hours</div>
        <div className={`text-2xl font-bold ${hoursClass}`}>{cert.hours}h</div>
      </div>
      <div>
        <div className="text-foreground/60 mb-0.5">Prep Time</div>
        <div className="text-2xl font-bold text-slate-950 dark:text-white">{cert.prepTime}</div>
      </div>
      {cert.successRate && (
        <div>
          <div className="text-foreground/60 mb-0.5">Avg. Pass Rate</div>
          <div className={`text-2xl font-bold ${passRateClass}`}>{cert.successRate}</div>
        </div>
      )}
    </div>
  );
}

/**
 * A card with an icon heading. `className` replaces the card's classes (a
 * tinted border, say) and `headingGap` the space under the heading.
 */
export function DetailSection({
  icon,
  iconColor,
  title,
  className = CARD,
  headingGap = 'mb-4',
  children,
}) {
  return (
    <section className={className}>
      <h2
        className={`text-xl font-bold text-slate-950 dark:text-white ${headingGap} flex items-center gap-2`}
      >
        <span className={`${iconColor} material-symbols-outlined text-[20px]`} aria-hidden="true">
          {icon}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A grid of short lines, each with a small icon in front. */
export function TopicGrid({ topics, iconColor, icon, columns }) {
  return (
    <div className={`grid ${columns} gap-3`}>
      {topics.map((topic, i) => (
        <div key={i} className="flex items-center gap-2 bg-card/50 rounded-xl px-3 py-2.5">
          <span className={`${iconColor} material-symbols-outlined text-[16px]`} aria-hidden="true">
            {icon}
          </span>
          <span className="text-foreground text-sm">{topic}</span>
        </div>
      ))}
    </div>
  );
}

/** Numbered links to outside study modules, each opening in a new tab. */
export function NumberedModuleLinks({ modules, tone }) {
  return (
    <div className="space-y-3">
      {modules.map((mod, i) => (
        <a
          key={i}
          href={mod.url}
          target="_blank"
          rel="noopener noreferrer"
          className={`flex items-center gap-3 group bg-card/40 hover:bg-card/60 border border-card/30 ${tone.cardHoverBorder} rounded-xl px-4 py-3 transition-all`}
        >
          <span className={tone.numberBadge}>{i + 1}</span>
          <span
            className={`text-sm text-foreground ${tone.groupHoverTitle} transition-colors flex-1`}
          >
            {mod.title}
          </span>
          <span
            className={`material-symbols-outlined text-[14px] text-foreground/40 ${tone.groupHoverIcon} transition-colors shrink-0`}
            aria-hidden="true"
          >
            open_in_new
          </span>
        </a>
      ))}
    </div>
  );
}

/**
 * Link cards to other certifications: a coloured dot, the code, and the
 * title with the vendor prefix (`stripTitle`) taken off.
 */
export function NextCertLinks({ certs, tone, hrefFor, dotClassFor, stripTitle }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {certs.map((next) => (
        <Link
          key={next.slug}
          to={hrefFor(next)}
          className={`group flex items-center gap-3 bg-card/40 hover:bg-card/60 border border-card/30 ${tone.cardHoverBorder} rounded-xl px-4 py-3 transition-all`}
        >
          <span className={`w-2 h-2 rounded-full shrink-0 ${dotClassFor(next)}`} />
          <div className="min-w-0">
            <div className="text-xs font-mono text-foreground/50">{next.code}</div>
            <div
              className={`text-sm font-semibold text-foreground ${tone.groupHoverTitle} transition-colors line-clamp-1`}
            >
              {next.title.replace(stripTitle, '')}
            </div>
          </div>
          <span
            className={`material-symbols-outlined text-[16px] text-foreground/40 ${tone.groupHoverIcon} transition-colors ml-auto shrink-0`}
            aria-hidden="true"
          >
            arrow_forward
          </span>
        </Link>
      ))}
    </div>
  );
}

/** One sidebar button that opens an outside page. `look` is its colours and weight. */
function SideButton({ href, icon, label, layout, look }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${layout} w-full h-11 ${look} rounded-lg transition-colors`}
    >
      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
        {icon}
      </span>
      {label}
    </a>
  );
}

const SECONDARY_LOOK = 'bg-card/50 hover:bg-card/70 text-foreground font-semibold text-sm';

/**
 * The sidebar's buttons: the vendor page always, the exam guide and the
 * practice questions when the entry has them.
 */
export function CertSidebarLinks({ cert, tone, labels }) {
  return (
    <div className={`${CARD} space-y-3`}>
      <SideButton
        href={cert.learnUrl}
        icon="open_in_new"
        label={labels.learn}
        layout={tone.sideButton}
        look={`${tone.primaryButton} font-bold`}
      />
      {cert.studyGuideUrl && (
        <SideButton
          href={cert.studyGuideUrl}
          icon="description"
          label={labels.guide}
          layout={tone.sideButton}
          look={SECONDARY_LOOK}
        />
      )}
      {cert.practiceUrl && (
        <SideButton
          href={cert.practiceUrl}
          icon="quiz"
          label={labels.practice}
          layout={tone.sideButton}
          look={SECONDARY_LOOK}
        />
      )}
    </div>
  );
}

/** The sidebar card that states what to know before starting. */
export function PrerequisitesCard({ text, iconColor }) {
  return (
    <div className={CARD}>
      <h3 className="text-base font-bold text-slate-950 dark:text-white mb-3 flex items-center gap-2">
        <span className={`${iconColor} material-symbols-outlined text-[18px]`} aria-hidden="true">
          info
        </span>
        Prerequisites
      </h3>
      <p className="text-sm text-foreground">{text}</p>
    </div>
  );
}

/** One label and value row in a "Quick Stats" card. */
export function StatRow({
  label,
  valueClass = 'font-bold text-slate-950 dark:text-white',
  children,
}) {
  return (
    <div className="flex justify-between">
      <span className="text-foreground/60">{label}</span>
      <span className={valueClass}>{children}</span>
    </div>
  );
}

/** The link at the foot of the sidebar back to the provider's education page. */
export function BackLink({ to, hoverText, label }) {
  return (
    <Link
      to={to}
      className={`flex items-center gap-2 text-sm text-foreground/60 ${hoverText} transition-colors`}
    >
      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
        arrow_back
      </span>
      {label}
    </Link>
  );
}

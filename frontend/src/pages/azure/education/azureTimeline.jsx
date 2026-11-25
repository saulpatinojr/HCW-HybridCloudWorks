import React from 'react';
import { DATA_AS_OF, certifications } from '@/data/azure/certifications';
import { daysUntil, formatIsoDate, isPastDate, useToday } from '@/lib/certStatus';

export const TIMELINE_TYPE_META = {
  beta_launch: {
    icon: 'science',
    color: 'text-amber-400',
    bg: 'bg-amber-500/15 border-amber-500/30',
    label: 'Beta',
  },
  ga_launch: {
    icon: 'rocket_launch',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/15 border-emerald-500/30',
    label: 'Live',
  },
  retirement: {
    icon: 'schedule',
    color: 'text-rose-400',
    bg: 'bg-rose-500/15 border-rose-500/30',
    label: 'Retiring',
  },
  update: {
    icon: 'update',
    color: 'text-blue-400',
    bg: 'bg-blue-500/15 border-blue-500/30',
    label: 'Updated',
  },
};

export const TIMELINE_STATUS_ORDER = ['beta_launch', 'ga_launch', 'update', 'retirement'];

export const TIMELINE_CREDENTIAL_TYPE_META = {
  applied_skill: {
    icon: 'construction',
    label: 'Applied Skills',
    color: 'text-cyan-300',
  },
  certification: {
    iconSrc: '/icons/certs/certification.svg',
    label: 'Certification',
    color: 'text-primary',
  },
};

// A bare YYYY-MM-DD parsed with `new Date(iso)` is UTC midnight, and
// formatting that in a zone west of Greenwich printed the previous day — so
// "Jun 30, 2026" read "Jun 29, 2026" for a viewer in Chicago. formatIsoDate
// formats the calendar day itself.
export const CODE_BY_SLUG = new Map(certifications.map((c) => [c.slug, c.code]));

export function getMonthColumnFill(isCurrentMonth, index) {
  if (isCurrentMonth) {
    return 'rgba(99,102,241,0.07)';
  }
  return index % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.00)';
}

export const formatDate = formatIsoDate;

/** Sort comparator on `date` (`YYYY-MM-DD`): the strings order correctly as text, no Date, no zone. */
export const byIsoDate = (a, b) => a.date.localeCompare(b.date);

/**
 * `status` is the DERIVED status (see lib/certStatus.js), never the stored
 * field: until 2026-09-09 this badge printed "BETA · ends Jun 30, 2026" and
 * "Expiring Soon" for exams already gone, because the stored field had not
 * been touched since April (#461).
 */
export function StatusBadge({
  status,
  expiryDate,
  betaEndDate,
  replacedBy,
  today,
  className = '',
}) {
  const replacementCode = replacedBy ? CODE_BY_SLUG.get(replacedBy) : null;
  if (status === 'retired') {
    return (
      <span
        className={`inline-flex items-center gap-1 px-2.5 py-1 bg-slate-500/20 border border-slate-500/40 text-slate-300 text-[10px] font-bold rounded-full ${className}`}
      >
        <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
          block
        </span>
        Retired
        {expiryDate && <span className="opacity-70">· {formatDate(expiryDate)}</span>}
        {replacementCode && <span className="opacity-70">· now {replacementCode}</span>}
      </span>
    );
  }
  if (status === 'beta') {
    return (
      <span
        className={`inline-flex items-center gap-1 px-2.5 py-1 bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[10px] font-bold rounded-full ${className}`}
      >
        <span className="w-1.5 h-1.5 bg-amber-400 rounded-full animate-pulse" />
        BETA
        {betaEndDate && <span className="opacity-70">· ends {formatDate(betaEndDate)}</span>}
      </span>
    );
  }
  if (status === 'expiring') {
    const days = expiryDate ? daysUntil(expiryDate, today) : null;
    return (
      <span
        className={`inline-flex items-center gap-1 px-2.5 py-1 bg-rose-500/20 border border-rose-500/40 text-rose-300 text-[10px] font-bold rounded-full ${className}`}
      >
        <span className="material-symbols-outlined text-[12px]" aria-hidden="true">
          schedule
        </span>
        Expiring Soon
        {days !== null && days > 0 && <span className="opacity-70">· {days}d</span>}
        {replacementCode && <span className="opacity-70">· then {replacementCode}</span>}
      </span>
    );
  }
  return null;
}

export function getTimelineStatusType(type) {
  return type === 'applied_skill_retirement' ? 'retirement' : type;
}

export function getTimelineStatusMeta(type) {
  return TIMELINE_TYPE_META[getTimelineStatusType(type)] || TIMELINE_TYPE_META.update;
}

export function getTimelineCredentialType(ev) {
  return (
    ev.credentialType ||
    (ev.type === 'applied_skill_retirement' ? 'applied_skill' : 'certification')
  );
}

export function TimelineCredentialTypeIcon({ credentialType, className = 'h-4 w-4' }) {
  const meta = TIMELINE_CREDENTIAL_TYPE_META[credentialType];
  if (!meta) return null;
  if (meta.iconSrc) {
    return <img src={meta.iconSrc} alt="" aria-hidden="true" className={className} />;
  }
  return (
    <span className={`material-symbols-outlined text-[16px] ${meta.color}`} aria-hidden="true">
      {meta.icon}
    </span>
  );
}

// ── Horizontal Timeline ───────────────────────────────────────────────────────

// Every Date in the timeline is a UTC calendar day: a bare YYYY-MM-DD parses
// as UTC midnight, and only the UTC getters are used, so the month grid and
// the x positions are the same for every viewer and on the build runner. The
// comparisons that decide "past" and the day counts never touch a Date at all
// (isPastDate / daysUntil compare the ISO strings).
export function buildMonthColumns(events) {
  if (!events.length) return { months: [], minDate: null, maxDate: null };
  const days = events.map((e) => Date.parse(e.date));
  const minDate = new Date(Math.min(...days));
  const maxDate = new Date(Math.max(...days));
  // Start from the first day of minDate's month, end last day of maxDate's month + 1 buffer
  const start = new Date(Date.UTC(minDate.getUTCFullYear(), minDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(maxDate.getUTCFullYear(), maxDate.getUTCMonth() + 2, 0));
  const months = [];
  let cur = new Date(start);
  while (cur <= end) {
    months.push(new Date(cur));
    cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
  }
  return { months, minDate: start, maxDate: end };
}

export const COL_WIDTH = 160; // px per month column
export const TRACK_HEIGHT = 56; // px per event row
export const HEADER_HEIGHT = 40;

export function HorizontalTimeline({ events }) {
  const [tooltip, setTooltip] = React.useState(null);
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);
  const scrollContainerRef = React.useRef(null);
  // The catalogue date while pre-rendering and hydrating, the real date after;
  // called before any early return so the hook order is stable. See lib/certStatus.js.
  const today = useToday(DATA_AS_OF);
  const [todayYear, todayMonth] = today.split('-').map(Number);

  const { months, minDate, maxDate } = buildMonthColumns(events);
  const liveCount = events.filter((ev) => ev.live).length;

  // Check scroll position to enable/disable buttons
  const checkScrollPosition = React.useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    setCanScrollLeft(container.scrollLeft > 0);
    setCanScrollRight(container.scrollLeft < container.scrollWidth - container.clientWidth - 1);
  }, []);

  // Scroll left/right by 300px
  const scrollLeft = () => {
    scrollContainerRef.current?.scrollBy({ left: -300, behavior: 'smooth' });
  };

  const scrollRight = () => {
    scrollContainerRef.current?.scrollBy({ left: 300, behavior: 'smooth' });
  };

  // Check scroll position on mount and when scrolling
  React.useEffect(() => {
    checkScrollPosition();
    const container = scrollContainerRef.current;
    if (container) {
      container.addEventListener('scroll', checkScrollPosition);
      window.addEventListener('resize', checkScrollPosition);
      return () => {
        container.removeEventListener('scroll', checkScrollPosition);
        window.removeEventListener('resize', checkScrollPosition);
      };
    }
  }, [checkScrollPosition]);

  if (!months.length) return null;

  const totalMs = maxDate - minDate;
  const totalWidth = months.length * COL_WIDTH;

  function xForDate(iso) {
    const ms = Date.parse(iso) - minDate;
    return Math.round((ms / totalMs) * totalWidth);
  }

  // Assign events to non-overlapping rows (greedy lane packing)
  const lanes = [];
  const sortedEvts = [...events].sort(byIsoDate);
  const laneEnds = []; // x-end per lane
  const EVENT_W = 130;
  const eventLanes = sortedEvts.map((ev) => {
    const x = xForDate(ev.date);
    let lane = laneEnds.findIndex((end) => end + 8 <= x);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(x + EVENT_W);
      lanes.push(lane);
    } else {
      laneEnds[lane] = x + EVENT_W;
    }
    return lane;
  });

  const numLanes = Math.max(...eventLanes, 0) + 1;
  const svgHeight = HEADER_HEIGHT + numLanes * TRACK_HEIGHT + 16;

  return (
    <section className="mb-16">
      <h3 className="text-2xl font-bold text-slate-950 dark:text-white mb-2 flex items-center gap-2">
        <span className="text-primary text-[24px] material-symbols-outlined" aria-hidden="true">
          timeline
        </span>
        Certification &amp; Applied Skills Lifecycle
      </h3>
      <p className="text-sm text-foreground mb-4 max-w-2xl">
        Beta launches, GA dates, and retirement deadlines, checked against{' '}
        <a
          href="https://learn.microsoft.com/en-us/credentials/support/credential-retirement"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
        >
          Microsoft Learn
        </a>{' '}
        on {formatDate(DATA_AS_OF)}.
        {liveCount > 0 && (
          <>
            {' '}
            Plus {liveCount} from the{' '}
            <a
              href="https://techcommunity.microsoft.com/category/skills-hub/blog/skills-hub-blog"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Microsoft Skills Hub blog
            </a>
            , as last scraped.
          </>
        )}
      </p>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mb-4">
        {TIMELINE_STATUS_ORDER.map((type) => {
          const meta = TIMELINE_TYPE_META[type];
          return (
            <div key={type} className="flex items-center gap-1.5">
              <span
                className={`material-symbols-outlined text-[14px] ${meta.color}`}
                aria-hidden="true"
              >
                {meta.icon}
              </span>
              <span className="text-xs text-foreground/70">{meta.label}</span>
            </div>
          );
        })}
        <div className="w-6" aria-hidden="true" />
        {Object.entries(TIMELINE_CREDENTIAL_TYPE_META).map(([credentialType, meta]) => (
          <div key={credentialType} className="flex items-center gap-1.5">
            <TimelineCredentialTypeIcon credentialType={credentialType} />
            <span className="text-xs text-foreground/70">{meta.label}</span>
          </div>
        ))}
      </div>

      {/* Scrollable timeline container */}
      <div className="relative bg-card/20 backdrop-blur-md border border-card/40 rounded-2xl overflow-hidden">
        {/* Left scroll button */}
        {canScrollLeft && (
          <button
            onClick={scrollLeft}
            className="absolute left-2 top-1/2 -translate-y-1/2 z-30 bg-primary/90 hover:bg-primary text-primary-foreground rounded-full p-2 shadow-lg transition-all duration-200 hover:scale-110"
            aria-label="Scroll left"
          >
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              chevron_left
            </span>
          </button>
        )}

        {/* Right scroll button */}
        {canScrollRight && (
          <button
            onClick={scrollRight}
            className="absolute right-2 top-1/2 -translate-y-1/2 z-30 bg-primary/90 hover:bg-primary text-primary-foreground rounded-full p-2 shadow-lg transition-all duration-200 hover:scale-110"
            aria-label="Scroll right"
          >
            <span className="material-symbols-outlined text-[20px]" aria-hidden="true">
              chevron_right
            </span>
          </button>
        )}

        <div
          ref={scrollContainerRef}
          className="overflow-x-auto scrollbar-thin scrollbar-thumb-card/60 scrollbar-track-transparent"
        >
          <div style={{ width: totalWidth, minWidth: '100%', position: 'relative' }}>
            {/* SVG layer for grid lines and month headers */}
            <svg
              width={totalWidth}
              height={svgHeight}
              style={{ display: 'block', userSelect: 'none' }}
            >
              {/* Month columns */}
              {months.map((m, i) => {
                const x = i * COL_WIDTH;
                const isCurrentMonth =
                  m.getUTCFullYear() === todayYear && m.getUTCMonth() + 1 === todayMonth;
                return (
                  <g key={i}>
                    {/* Alternating column shading */}
                    <rect
                      x={x}
                      y={HEADER_HEIGHT}
                      width={COL_WIDTH}
                      height={svgHeight - HEADER_HEIGHT}
                      fill={getMonthColumnFill(isCurrentMonth, i)}
                    />
                    {/* Vertical grid line */}
                    <line
                      x1={x}
                      y1={0}
                      x2={x}
                      y2={svgHeight}
                      stroke="rgba(255,255,255,0.06)"
                      strokeWidth={1}
                    />
                    {/* Month label */}
                    <text
                      x={x + COL_WIDTH / 2}
                      y={HEADER_HEIGHT / 2 + 5}
                      textAnchor="middle"
                      fill={isCurrentMonth ? 'rgba(139,92,246,0.9)' : 'rgba(255,255,255,0.45)'}
                      fontSize={11}
                      fontWeight={isCurrentMonth ? '700' : '500'}
                      fontFamily="inherit"
                    >
                      {m.toLocaleDateString('en-US', {
                        month: 'short',
                        year: '2-digit',
                        timeZone: 'UTC',
                      })}
                    </text>
                  </g>
                );
              })}

              {/* Horizontal separator below header */}
              <line
                x1={0}
                y1={HEADER_HEIGHT}
                x2={totalWidth}
                y2={HEADER_HEIGHT}
                stroke="rgba(255,255,255,0.10)"
                strokeWidth={1}
              />

              {/* Event markers */}
              {sortedEvts.map((ev, idx) => {
                const isPast = isPastDate(ev.date, today);
                const x = xForDate(ev.date);
                const lane = eventLanes[idx];
                const y = HEADER_HEIGHT + lane * TRACK_HEIGHT + TRACK_HEIGHT / 2;
                const pillW = EVENT_W;
                const pillH = 36;
                const pillX = Math.min(x - 4, totalWidth - pillW - 4);
                const pillY = y - pillH / 2;

                const colorMap = {
                  beta_launch: {
                    fill: 'rgba(245,158,11,0.18)',
                    stroke: 'rgba(245,158,11,0.50)',
                    text: 'rgba(252,211,77,1)',
                  },
                  ga_launch: {
                    fill: 'rgba(16,185,129,0.18)',
                    stroke: 'rgba(16,185,129,0.50)',
                    text: 'rgba(110,231,183,1)',
                  },
                  retirement: {
                    fill: 'rgba(244,63,94,0.18)',
                    stroke: 'rgba(244,63,94,0.50)',
                    text: 'rgba(251,113,133,1)',
                  },
                  update: {
                    fill: 'rgba(59,130,246,0.18)',
                    stroke: 'rgba(59,130,246,0.50)',
                    text: 'rgba(147,197,253,1)',
                  },
                };
                const c = colorMap[getTimelineStatusType(ev.type)] || colorMap.update;

                return (
                  <g
                    key={ev.id}
                    data-event-id={ev.id}
                    data-past={isPast ? 'true' : 'false'}
                    style={{ cursor: 'pointer', opacity: isPast ? 0.55 : 1 }}
                    onMouseEnter={() => setTooltip(ev.id)}
                    onMouseLeave={() => setTooltip(null)}
                  >
                    {/* Stem line from axis to pill */}
                    <line
                      x1={x}
                      y1={HEADER_HEIGHT}
                      x2={x}
                      y2={pillY + pillH / 2}
                      stroke={c.stroke}
                      strokeWidth={1}
                      strokeDasharray="2 2"
                    />
                    {/* Diamond marker on axis */}
                    <rect
                      x={x - 5}
                      y={HEADER_HEIGHT - 5}
                      width={10}
                      height={10}
                      rx={2}
                      fill={c.fill}
                      stroke={c.stroke}
                      strokeWidth={1.5}
                      transform={`rotate(45 ${x} ${HEADER_HEIGHT})`}
                    />
                    {/* Pill background */}
                    <rect
                      x={pillX}
                      y={pillY}
                      width={pillW}
                      height={pillH}
                      rx={8}
                      fill={c.fill}
                      stroke={tooltip === ev.id ? c.text : c.stroke}
                      strokeWidth={tooltip === ev.id ? 1.5 : 1}
                    />
                    {/* Cert code */}
                    {ev.certCode && (
                      <text
                        x={pillX + 8}
                        y={pillY + 13}
                        fill={c.text}
                        fontSize={9}
                        fontWeight="700"
                        fontFamily="monospace"
                      >
                        {ev.certCode}
                      </text>
                    )}
                    {/* Event title (truncated) */}
                    <text
                      x={pillX + 8}
                      y={pillY + 26}
                      fill="hsl(var(--foreground))"
                      fontSize={9.5}
                      fontWeight="500"
                      fontFamily="inherit"
                    >
                      {ev.title.length > 18 ? `${ev.title.slice(0, 17)}…` : ev.title}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Tooltip overlay */}
        {tooltip &&
          (() => {
            const ev = sortedEvts.find((e) => e.id === tooltip);
            if (!ev) return null;
            const meta = getTimelineStatusMeta(ev.type);
            const credentialType = getTimelineCredentialType(ev);
            const credentialMeta = TIMELINE_CREDENTIAL_TYPE_META[credentialType];
            const isPast = isPastDate(ev.date, today);
            const days = daysUntil(ev.date, today);
            return (
              <div className="absolute bottom-3 right-3 max-w-xs bg-background/95 backdrop-blur-md border border-card/60 rounded-xl px-4 py-3 shadow-2xl z-20 pointer-events-none">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span
                    className={`material-symbols-outlined text-[14px] ${meta.color}`}
                    aria-hidden="true"
                  >
                    {meta.icon}
                  </span>
                  <span className={`text-[10px] font-bold ${meta.color}`}>{meta.label}</span>
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold text-foreground/70">
                    <TimelineCredentialTypeIcon
                      credentialType={credentialType}
                      className="h-3.5 w-3.5"
                    />
                    {credentialMeta?.label}
                  </span>
                  {ev.certCode && (
                    <span className="font-mono text-[10px] text-foreground/50">{ev.certCode}</span>
                  )}
                  {isPast && <span className="text-[10px] text-foreground/40 italic">past</span>}
                </div>
                <div className="font-semibold text-slate-950 dark:text-white text-sm mb-0.5">
                  {ev.title}
                </div>
                <div className="text-[11px] text-foreground/70 mb-1.5">{ev.description}</div>
                <div className="text-[10px] text-foreground/50 flex items-center justify-between">
                  <span>{formatDate(ev.date)}</span>
                  {!isPast && (
                    <span className="text-primary font-semibold">
                      {days === 0 ? 'today' : `in ${days}d`}
                    </span>
                  )}
                </div>
              </div>
            );
          })()}
      </div>
    </section>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

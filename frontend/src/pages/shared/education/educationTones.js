/**
 * Colour classes for the shared education sections, one set per colour.
 * A page names its colour ('amber', 'purple', ...) and the section looks the
 * classes up here, so the section's markup names no colour.
 *
 * Every class is written out in full, never built from pieces, because
 * Tailwind only generates the classes it can find written in the source.
 */

/**
 * The two big "official resource" link cards near the top of an education
 * page. `card` is the gradient, border and hover glow; the rest colour the
 * icon box, icon, title on hover, small badge and the address line.
 */
export const OFFICIAL_CARD_TONES = {
  amber: {
    card: 'bg-gradient-to-br from-amber-900/40 to-card/40 backdrop-blur-md border border-amber-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(245,158,11,0.2)] hover:border-amber-400/60',
    iconBox: 'bg-amber-500/20',
    icon: 'text-amber-400',
    titleHover: 'group-hover:text-amber-300',
    badge: 'bg-amber-500/20 border border-amber-500/30 text-amber-300',
    link: 'text-amber-400',
  },
  orange: {
    card: 'bg-gradient-to-br from-orange-900/40 to-card/40 backdrop-blur-md border border-orange-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(249,115,22,0.2)] hover:border-orange-400/60',
    iconBox: 'bg-orange-500/20',
    icon: 'text-orange-400',
    titleHover: 'group-hover:text-orange-300',
    badge: 'bg-orange-500/20 border border-orange-500/30 text-orange-300',
    link: 'text-orange-400',
  },
  blue: {
    card: 'bg-linear-to-br from-blue-900/40 to-card/40 backdrop-blur-md border border-blue-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(59,130,246,0.2)] hover:border-blue-400/60',
    iconBox: 'bg-blue-500/20',
    icon: 'text-blue-400',
    titleHover: 'group-hover:text-blue-300',
    badge: 'bg-blue-500/20 border border-blue-500/30 text-blue-300',
    link: 'text-blue-400',
  },
  cyan: {
    card: 'bg-linear-to-br from-cyan-900/40 to-card/40 backdrop-blur-md border border-cyan-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(6,182,212,0.2)] hover:border-cyan-400/60',
    iconBox: 'bg-cyan-500/20',
    icon: 'text-cyan-400',
    titleHover: 'group-hover:text-cyan-300',
    badge: 'bg-cyan-500/20 border border-cyan-500/30 text-cyan-300',
    link: 'text-cyan-400',
  },
  azure: {
    card: 'bg-linear-to-br from-blue-900/40 to-card/40 backdrop-blur-md border border-blue-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(0,120,212,0.2)] hover:border-primary/60',
    iconBox: 'bg-primary/20',
    icon: 'text-primary',
    titleHover: 'group-hover:text-primary',
    badge: 'bg-primary/20 border border-primary/30 text-primary',
    link: 'text-primary',
  },
  azureCyan: {
    card: 'bg-linear-to-br from-cyan-900/40 to-card/40 backdrop-blur-md border border-cyan-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(0,188,212,0.2)] hover:border-cyan-400/60',
    iconBox: 'bg-cyan-500/20',
    icon: 'text-cyan-400',
    titleHover: 'group-hover:text-cyan-300',
    badge: 'bg-cyan-500/20 border border-cyan-500/30 text-cyan-300',
    link: 'text-cyan-400',
  },
  slate: {
    card: 'bg-gradient-to-br from-slate-800/60 to-card/40 backdrop-blur-md border border-slate-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(148,163,184,0.15)] hover:border-slate-400/60',
    iconBox: 'bg-slate-500/20',
    icon: 'text-slate-300',
    titleHover: 'group-hover:text-slate-300',
    badge: 'bg-slate-500/20 border border-slate-500/30 text-slate-300',
    link: 'text-slate-300',
  },
  purple: {
    card: 'bg-gradient-to-br from-purple-900/40 to-card/40 backdrop-blur-md border border-purple-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(168,85,247,0.2)] hover:border-purple-400/60',
    iconBox: 'bg-purple-500/20',
    icon: 'text-purple-400',
    titleHover: 'group-hover:text-purple-300',
    badge: 'bg-purple-500/20 border border-purple-500/30 text-purple-300',
    link: 'text-purple-400',
  },
  violet: {
    card: 'bg-gradient-to-br from-violet-900/40 to-card/40 backdrop-blur-md border border-violet-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(139,92,246,0.2)] hover:border-violet-400/60',
    iconBox: 'bg-violet-500/20',
    icon: 'text-violet-400',
    titleHover: 'group-hover:text-violet-300',
    badge: 'bg-violet-500/20 border border-violet-500/30 text-violet-300',
    link: 'text-violet-400',
  },
  emerald: {
    card: 'bg-gradient-to-br from-emerald-900/40 to-card/40 backdrop-blur-md border border-emerald-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(16,185,129,0.2)] hover:border-emerald-400/60',
    iconBox: 'bg-emerald-500/20',
    icon: 'text-emerald-400',
    titleHover: 'group-hover:text-emerald-300',
    badge: 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-300',
    link: 'text-emerald-400',
  },
  teal: {
    card: 'bg-gradient-to-br from-teal-900/40 to-card/40 backdrop-blur-md border border-teal-500/30 rounded-2xl p-6 hover:shadow-[0_0_30px_rgba(20,184,166,0.2)] hover:border-teal-400/60',
    iconBox: 'bg-teal-500/20',
    icon: 'text-teal-400',
    titleHover: 'group-hover:text-teal-300',
    badge: 'bg-teal-500/20 border border-teal-500/30 text-teal-300',
    link: 'text-teal-400',
  },
};

/**
 * The "Learning Paths" and "Learning Resources" sections. One set per hub:
 * `primary` follows the page's theme colour; the rest are fixed colours.
 */
export const PATH_TONES = {
  primary: {
    heading: 'text-primary',
    select: 'hover:border-primary/50 focus:outline-none focus:border-primary',
    card: 'hover:shadow-[0_0_25px_rgba(59,130,246,0.15)] hover:border-primary/50',
    code: 'bg-primary/20 border border-primary/30 text-primary',
    hours: 'text-primary',
    count: 'text-cyan-400',
    step: 'bg-primary/20 text-primary',
    button: 'bg-primary hover:opacity-90 text-primary-foreground',
    iconBox: 'bg-primary/10',
    icon: 'text-primary',
    type: 'text-primary/70',
    titleHover: 'group-hover:text-primary',
  },
  slate: {
    heading: 'text-slate-300',
    select: 'hover:border-slate-400/50 focus:outline-none focus:border-slate-400',
    card: 'hover:shadow-[0_0_25px_rgba(148,163,184,0.12)] hover:border-slate-400/50',
    code: 'bg-slate-500/20 border border-slate-500/30 text-slate-300',
    hours: 'text-slate-300',
    count: 'text-slate-400',
    step: 'bg-slate-500/20 text-slate-300',
    button: 'bg-slate-600 hover:bg-slate-500 text-white',
    iconBox: 'bg-slate-500/10',
    icon: 'text-slate-300',
    type: 'text-slate-400/70',
    titleHover: 'group-hover:text-slate-300',
  },
  purple: {
    heading: 'text-purple-400',
    select: 'hover:border-purple-400/50 focus:outline-none focus:border-purple-400',
    card: 'hover:shadow-[0_0_25px_rgba(168,85,247,0.15)] hover:border-purple-400/50',
    code: 'bg-purple-500/20 border border-purple-500/30 text-purple-300',
    hours: 'text-purple-400',
    count: 'text-violet-400',
    step: 'bg-purple-500/20 text-purple-300',
    button: 'bg-purple-600 hover:bg-purple-500 text-white',
    iconBox: 'bg-purple-500/10',
    icon: 'text-purple-400',
    type: 'text-purple-400/70',
    titleHover: 'group-hover:text-purple-300',
  },
  emerald: {
    heading: 'text-emerald-400',
    select: 'hover:border-emerald-400/50 focus:outline-none focus:border-emerald-400',
    card: 'hover:shadow-[0_0_25px_rgba(16,185,129,0.15)] hover:border-emerald-400/50',
    code: 'bg-emerald-500/20 border border-emerald-500/30 text-emerald-300',
    hours: 'text-emerald-400',
    count: 'text-teal-400',
    step: 'bg-emerald-500/20 text-emerald-300',
    button: 'bg-emerald-700 hover:bg-emerald-600 text-white',
    iconBox: 'bg-emerald-500/10',
    icon: 'text-emerald-400',
    type: 'text-emerald-400/70',
    titleHover: 'group-hover:text-emerald-300',
  },
  amber: {
    heading: 'text-amber-400',
    select: 'hover:border-amber-400/50 focus:outline-none focus:border-amber-400',
    card: 'hover:shadow-[0_0_25px_rgba(245,158,11,0.15)] hover:border-amber-400/50',
    code: 'bg-amber-500/20 border border-amber-500/30 text-amber-300',
    step: 'bg-amber-500/20 text-amber-300',
    button: 'bg-amber-700 hover:bg-amber-600 text-white',
    iconBox: 'bg-amber-500/10',
    icon: 'text-amber-400',
    type: 'text-amber-400/70',
    titleHover: 'group-hover:text-amber-300',
  },
};

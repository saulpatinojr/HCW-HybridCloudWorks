/**
 * The amber accent the AWS certification and microcredential detail pages
 * use for the shared parts in components/education/CertDetailParts.jsx. The
 * keys are explained at the top of that file. Full class strings, so
 * Tailwind finds them.
 */
export const AWS_DETAIL_TONE = Object.freeze({
  main: 'flex-grow pt-28 pb-20 px-4 md:px-8 max-w-[1440px] mx-auto w-full',
  accentText: 'text-amber-400',
  hoverText: 'hover:text-amber-400',
  primaryButton: 'bg-amber-500 hover:bg-amber-400 text-slate-950',
  cardHoverBorder: 'hover:border-amber-400/30',
  groupHoverTitle: 'group-hover:text-amber-300',
  groupHoverIcon: 'group-hover:text-amber-400',
  numberBadge:
    'flex-shrink-0 w-6 h-6 bg-amber-500/20 rounded-full flex items-center justify-center text-xs font-bold text-amber-400',
  sideButton: 'flex items-center justify-center gap-2',
});

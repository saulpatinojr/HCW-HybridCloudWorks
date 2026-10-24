/**
 * The book view: the same interview as the article, laid out as the pages of a
 * book that turn. Built here with CSS, with no library: the usual flip-book
 * package was last released in April 2021 and nothing about this needs it.
 *
 * HOW IT TURNS. A book is a stack of LEAVES, a leaf being a sheet with a page
 * on each side. Leaf `k` has page `2k` on its front and page `2k + 1` on its
 * back. A leaf hinges on its left edge, so turning it swings it over onto the
 * left-hand side and shows its back. `spread` is how many leaves have been
 * turned: 0 is the closed book, cover on the right; `leaves` is the closed
 * book again, back cover on the left; in between the left page is the back of
 * leaf `spread - 1` and the right page is the front of leaf `spread`.
 *
 * Only the two pages on show are readable. The rest are `inert` (no focus, no
 * clicks, hidden from screen readers) and `aria-hidden`, because a turned-away
 * page is still in the document and a screen reader would otherwise read the
 * whole book at once. A hidden page's links cannot be tabbed to for the same
 * reason.
 *
 * ACCESSIBILITY. This view is an extra, not the way in: the article view holds
 * every word and is what a screen reader, a phone and a search engine get. The
 * book is a labelled group, turned with the two real buttons beneath it, which
 * is the way in for everyone; with focus on either button the left and right
 * arrow keys, Home and End turn it too, and each turn is spoken ("Pages 3 and
 * 4 of 8"). The keys live on the buttons and not on the book because a
 * focusable, key-handling `div` is the wrong pattern (jsx-a11y refuses it), and
 * because a button that is out of moves stays focusable (`aria-disabled`, not
 * `disabled`): a disabled button under a keyboard user's focus drops it out of
 * the page. The page only offers the book when the screen is wide and the
 * visitor has not asked for less motion; the turn is also switched off by the
 * `motion-reduce` class if that preference changes while it is open.
 *
 * Every string is rendered as text by React, from an interview file that was
 * checked when the site was built.
 */
import React, { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  buildBookPages,
  formatInterviewDate,
  isExternalLink,
  lastSpread,
  spreadStatus,
  visiblePageIndexes,
} from '@/lib/interviews';

const TURN_MS = 700;

// The paper is a fixed colour, in an inline style, and NOT `bg-white`: inside a
// provider page the site's theme rewrites `.bg-white` to its own surface colour
// with !important (index.css, the `.theme-*` rules), which in the dark theme
// made the pages dark with dark text on them, unreadable. Found by looking at
// the page in a browser; jsdom has no layout and passed. Paper stays paper, and
// its text stays dark, in either theme.
const PAPER = { backgroundColor: '#fffdf8', color: '#1e293b' };

const faceBase = {
  ...PAPER,
  position: 'absolute',
  inset: 0,
  backfaceVisibility: 'hidden',
  WebkitBackfaceVisibility: 'hidden',
};

// A link on paper is a fixed dark blue, inline, for the same reason as the paper
// itself: a site-wide link rule repaints `a` in a bright cyan, and on this paper
// that measured 2.2:1 and 2.7:1 (axe in a real browser), well under the 4.5:1
// text needs. #1d4ed8 on #fffdf8 is about 6.6:1.
const LINK_STYLE = { color: '#1d4ed8' };

function BookLink({ to, children }) {
  const className = 'underline underline-offset-2';
  if (isExternalLink(to)) {
    return (
      <a href={to} className={className} style={LINK_STYLE} rel="noopener noreferrer">
        {children}
        <span className="sr-only"> (opens another site)</span>
      </a>
    );
  }
  return (
    <Link to={to} className={className} style={LINK_STYLE}>
      {children}
    </Link>
  );
}

function Related({ heading, items }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-4">
      <h4 className="font-semibold text-slate-900">{heading}</h4>
      <ul className="mt-1 list-disc pl-5 space-y-1">
        {items.map((item) => (
          <li key={item.url}>
            <BookLink to={item.url}>{item.title}</BookLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What is printed on one page. */
function PageContent({ page }) {
  switch (page.kind) {
    case 'cover': {
      const { interview } = page;
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 bg-gradient-to-br from-blue-700 to-blue-900 p-8 text-center text-white">
          {interview.image && (
            <img
              src={interview.image.src}
              alt={interview.image.alt}
              width={96}
              height={96}
              className="h-24 w-24 rounded-full border-2 border-white/60 object-cover"
            />
          )}
          <p className="text-2xl font-bold leading-tight">{interview.title}</p>
          {interview.subtitle && <p className="text-base text-white/90">{interview.subtitle}</p>}
          <p className="text-sm text-white/80">
            <time dateTime={interview.date}>{formatInterviewDate(interview.date)}</time>
          </p>
        </div>
      );
    }
    case 'bio': {
      const { interview } = page;
      return (
        <div className="p-6">
          <h3 className="text-xl font-semibold text-slate-900">About the guest</h3>
          <p className="mt-2 font-medium text-slate-900">
            {interview.guest.name}
            {interview.guest.role ? `, ${interview.guest.role}` : ''}
          </p>
          {interview.bio && <p className="mt-2 whitespace-pre-line">{interview.bio}</p>}
          {interview.tags.length > 0 && (
            <ul className="mt-4 flex flex-wrap gap-2" aria-label="Topics">
              {interview.tags.map((tag) => (
                <li key={tag} className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                  {tag}
                </li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    case 'qa':
      return (
        <div className="p-6">
          <p className="text-sm font-bold text-blue-700">
            Question {page.number} of {page.total}
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">{page.q}</h3>
          <p className="mt-3 whitespace-pre-line leading-relaxed">{page.a}</p>
          {page.pullQuote && (
            <blockquote className="mt-4 border-l-4 border-blue-700 pl-3 text-base italic text-slate-800">
              {page.pullQuote}
            </blockquote>
          )}
        </div>
      );
    case 'related':
      return (
        <div className="p-6">
          <h3 className="text-xl font-semibold text-slate-900">Keep learning</h3>
          <Related heading="Labs" items={page.labs} />
          <Related heading="Microsoft Learn" items={page.learn} />
        </div>
      );
    case 'end':
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-blue-900 to-blue-700 p-8 text-center text-white">
          <p className="text-xl font-semibold">Thanks for reading</p>
          <p className="text-sm text-white/80">{page.interview.title}</p>
        </div>
      );
    default:
      return null;
  }
}

/** One side of a leaf. Out of view means unreachable. */
function Face({ page, shown, back = false, label }) {
  return (
    <div
      data-book-face
      className="overflow-hidden border border-slate-300 shadow-inner"
      style={{ ...faceBase, transform: back ? 'rotateY(180deg)' : undefined }}
      inert={!shown}
      aria-hidden={shown ? undefined : true}
    >
      {page.kind === 'blank' ? null : (
        <div
          className="h-full overflow-y-auto"
          tabIndex={shown && page.kind === 'qa' ? 0 : undefined}
          role={shown && page.kind === 'qa' ? 'region' : undefined}
          aria-label={shown && page.kind === 'qa' ? label : undefined}
        >
          <PageContent page={page} />
        </div>
      )}
    </div>
  );
}

/** @param {{ interview: ReturnType<typeof import('@/lib/interviews').normalizeInterview> }} props */
export default function InterviewBook({ interview }) {
  const pages = useMemo(() => buildBookPages(interview), [interview]);
  const last = lastSpread(pages);
  const [spread, setSpread] = useState(0);
  const shown = new Set(visiblePageIndexes(spread, pages));

  const goTo = (next) => setSpread(Math.min(Math.max(next, 0), last));

  // On the two buttons only. A link or a scrolling page inside the book never
  // sees these keys taken: a reader moving through text keeps them.
  const onKeyDown = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowRight') goTo(spread + 1);
    else if (event.key === 'ArrowLeft') goTo(spread - 1);
    else if (event.key === 'Home') goTo(0);
    else if (event.key === 'End') goTo(last);
    else return;
    event.preventDefault();
  };

  // Closed on the cover: centred by moving the right-hand half left by a
  // quarter of the book. Closed on the back cover: the same, the other way.
  let shift = '0%';
  if (spread === 0) shift = '-50%';
  else if (spread === last) shift = '50%';

  const leaves = Array.from({ length: last }, (_, k) => k);

  return (
    <div>
      <div
        role="group"
        aria-roledescription="book"
        aria-label={`${interview.title}, book view`}
        className="relative mx-auto aspect-[3/2] w-full max-w-4xl"
        style={{ perspective: '2400px' }}
      >
        <div
          className="absolute right-0 top-0 h-full w-1/2 transition-transform ease-in-out motion-reduce:transition-none"
          style={{ transform: `translateX(${shift})`, transitionDuration: `${TURN_MS}ms` }}
        >
          {leaves.map((k) => {
            const turned = spread > k;
            const frontIndex = 2 * k;
            const backIndex = 2 * k + 1;
            return (
              <div
                key={k}
                className="absolute inset-0 transition-transform ease-in-out motion-reduce:transition-none"
                style={{
                  transformOrigin: 'left center',
                  transformStyle: 'preserve-3d',
                  transform: turned ? 'rotateY(-180deg)' : 'rotateY(0deg)',
                  transitionDuration: `${TURN_MS}ms`,
                  zIndex: turned ? k : last - k,
                }}
              >
                <Face
                  page={pages[frontIndex]}
                  shown={shown.has(frontIndex)}
                  label={`Question ${pages[frontIndex].number ?? ''}`}
                />
                {pages[backIndex] && (
                  <Face
                    back
                    page={pages[backIndex]}
                    shown={shown.has(backIndex)}
                    label={`Question ${pages[backIndex].number ?? ''}`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-center gap-4">
        <button
          type="button"
          onClick={() => goTo(spread - 1)}
          onKeyDown={onKeyDown}
          aria-disabled={spread === 0}
          className="rounded border border-border bg-card/50 px-4 py-2 text-foreground aria-disabled:opacity-40"
        >
          Previous page
        </button>
        <p
          role="status"
          aria-live="polite"
          className="min-w-40 text-center text-sm text-foreground"
        >
          {spreadStatus(spread, pages)}
        </p>
        <button
          type="button"
          onClick={() => goTo(spread + 1)}
          onKeyDown={onKeyDown}
          aria-disabled={spread === last}
          className="rounded border border-border bg-card/50 px-4 py-2 text-foreground aria-disabled:opacity-40"
        >
          Next page
        </button>
      </div>
      <p className="mt-2 text-center text-xs text-foreground/60">
        With a page button focused, the left and right arrow keys also turn the pages. Home goes to
        the cover and End to the back cover.
      </p>
    </div>
  );
}

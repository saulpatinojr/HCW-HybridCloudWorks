/**
 * Interviews: the list at `/azure/interviews` and one interview at
 * `/azure/interviews/:interviewId`.
 *
 * The article is the page. It holds every word, is what is pre-rendered for
 * search engines, and is what a phone and a screen reader get. "Book view" is
 * an extra the visitor chooses: the button only appears once the page has
 * loaded in a browser, and only when the screen is wide and the visitor has
 * not asked for less motion. Nothing here reads the screen or the motion
 * preference during the first render, so the pre-rendered page and the first
 * browser render are the same and hydration matches; the choice is made in an
 * effect afterwards. The book's code is loaded when the button is first used.
 *
 * Interviews are read live from the public API (ADR 0040, D6): the list from
 * `public/interviews` under the key `interviews:list`, one interview from
 * `public/interviews/<slug>` under `interview:<slug>`. The pre-render seeds
 * the same keys from the content manifest, so a built page carries the whole
 * interview. Every item goes through `normalizeInterview`, the one validator
 * of the shape (lib/interviews.js): an item that fails it is left out of the
 * list, and a page that fails it is the not-found page, never a broken one.
 * While a read is in flight the page shows a skeleton; with none, it says
 * there are none yet. The Azure landing page's Interviews card reads the same
 * list key and only shows once there is one.
 *
 * NO `<main>` HERE. The site's layout already wraps every page in
 * `<main id="main-content">`, and a second one made axe report a nested and a
 * duplicate main landmark when this page was checked in a browser. The older
 * pages still carry their own; this one does not copy that.
 */
import React, { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useParams } from 'react-router';
import InterviewArticle from '@/components/interviews/InterviewArticle';
import { Skeleton } from '@/components/performance/Skeleton';
import NotFoundPage from '@/pages/NotFoundPage';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchPublicInterview, fetchPublicInterviews } from '@/lib/publicApi';
import {
  formatInterviewDate,
  interviewPath,
  interviewSummary,
  interviewsPath,
  normalizeInterview,
  sortInterviews,
} from '@/lib/interviews';

const InterviewBook = lazy(() => import('@/components/interviews/InterviewBook'));

const SITE = 'https://hybridcloudworks.com';
const WIDE = '(min-width: 768px)';
const LESS_MOTION = '(prefers-reduced-motion: reduce)';

/** The query key of the list; the landing card and the pre-render seed use the same one. */
export const INTERVIEWS_LIST_KEY = 'interviews:list';
/** The query key of one interview. */
export const interviewKey = (slug) => `interview:${slug}`;

/**
 * One API item as the pages read it, or null when it is not a valid
 * interview. The slug is the item's own: the API answers by slug, so an
 * item without one has no address.
 */
export function readInterview(item) {
  if (!item || typeof item !== 'object' || typeof item.slug !== 'string') return null;
  try {
    return normalizeInterview(item, item.slug);
  } catch {
    return null;
  }
}

/** The API list as the pages read it: every valid item, newest first. */
export function readInterviewList(items) {
  if (!Array.isArray(items)) return [];
  return sortInterviews(items.map(readInterview).filter(Boolean));
}

/** The published interviews, newest first, with the read's state. */
export function useInterviewList() {
  const { data, loading, error } = usePublicData(fetchPublicInterviews, INTERVIEWS_LIST_KEY);
  const interviews = useMemo(() => readInterviewList(data), [data]);
  return { interviews, loading, error };
}

/** Whether the book view is worth offering: a wide screen and no request for less motion. */
function useBookAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const wide = window.matchMedia(WIDE);
    const calm = window.matchMedia(LESS_MOTION);
    const update = () => setAvailable(wide.matches && !calm.matches);
    update();
    wide.addEventListener?.('change', update);
    calm.addEventListener?.('change', update);
    return () => {
      wide.removeEventListener?.('change', update);
      calm.removeEventListener?.('change', update);
    };
  }, []);
  return available;
}

/** An address on this site made absolute for structured data; an https address is already. */
const absoluteUrl = (src) => (src.startsWith('/') ? `${SITE}${src}` : src);

/** The structured data a search engine reads. `<` is escaped so no text can close the script tag. */
function articleJsonLd(interview) {
  const image = interview.image ? absoluteUrl(interview.image.src) : undefined;
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: interview.title,
    description: interviewSummary(interview),
    datePublished: interview.date,
    image,
    about: interview.tags,
    author: { '@type': 'Organization', name: 'Hybrid Cloud Works' },
    mainEntityOfPage: `${SITE}${interviewPath(interview.slug)}`,
  }).replace(/</g, '\\u003c');
}

/** The list's shape while it loads: two cards' worth of lines, nothing to click. */
function ListSkeleton() {
  return (
    <div className="grid gap-6 md:grid-cols-2" aria-busy="true" aria-label="Loading interviews">
      {[0, 1].map((n) => (
        <div key={n} className="rounded-xl border border-border bg-card/40 p-6">
          <Skeleton variant="heading" className="mb-3 w-3/4" />
          <Skeleton variant="text" className="mb-3 w-1/2" />
          <Skeleton variant="text" />
          <Skeleton variant="text" className="w-5/6" />
        </div>
      ))}
    </div>
  );
}

/** One interview's shape while it loads: the heading and a few lines of article. */
function DetailSkeleton() {
  return (
    <div
      className="flex-grow pt-28 pb-20 px-4 md:px-8 max-w-4xl mx-auto w-full"
      aria-busy="true"
      aria-label="Loading interview"
    >
      <Skeleton variant="text" className="mb-6 w-32" />
      <Skeleton variant="heading" className="mb-4 w-3/4" />
      <Skeleton variant="text" className="mb-8 w-1/2" />
      <Skeleton variant="text" />
      <Skeleton variant="text" />
      <Skeleton variant="text" className="w-4/5" />
    </div>
  );
}

function InterviewList() {
  const { interviews, loading } = useInterviewList();
  return (
    <>
      <Helmet>
        <title>Azure Interviews | HCW</title>
        <meta
          name="description"
          content="Conversations with people building and running Microsoft Azure, written up as readable interviews."
        />
        <meta property="og:title" content="Azure Interviews | HCW" />
      </Helmet>
      <div className="flex-grow pt-28 pb-20 px-4 md:px-8 max-w-5xl mx-auto w-full">
        <h1 className="text-3xl sm:text-5xl font-bold text-slate-900 dark:text-white mb-4">
          Interviews
        </h1>
        <p className="text-base sm:text-lg text-foreground max-w-3xl mb-10">
          Conversations with people building and running Microsoft Azure, written up in full.
        </p>
        <ListBody interviews={interviews} loading={loading} />
      </div>
    </>
  );
}

/** The list itself: a skeleton while it loads, a sentence when there is none, else the cards. */
function ListBody({ interviews, loading }) {
  if (loading && interviews.length === 0) return <ListSkeleton />;
  if (interviews.length === 0) {
    return <p className="text-foreground">No interviews yet. Check back soon.</p>;
  }
  return (
    <ul className="grid gap-6 md:grid-cols-2">
      {interviews.map((interview) => (
        <li key={interview.slug} className="rounded-xl border border-border bg-card/40 p-6">
          <h2 className="text-xl font-semibold text-slate-900 dark:text-white">
            <Link to={interviewPath(interview.slug)} className="hover:underline underline-offset-2">
              {interview.title}
            </Link>
          </h2>
          <p className="mt-1 text-sm text-foreground/70">
            {interview.guest.name}
            {interview.guest.role ? `, ${interview.guest.role}` : ''} ·{' '}
            <time dateTime={interview.date}>{formatInterviewDate(interview.date)}</time>
          </p>
          <p className="mt-3 text-foreground">{interviewSummary(interview)}</p>
        </li>
      ))}
    </ul>
  );
}

function InterviewDetail({ interview }) {
  const [view, setView] = useState('article');
  const bookAvailable = useBookAvailable();
  const showBook = view === 'book' && bookAvailable;
  const description = interviewSummary(interview);

  return (
    <>
      <Helmet>
        <title>{`${interview.title} | HCW`}</title>
        <meta name="description" content={description} />
        <meta property="og:title" content={`${interview.title} | HCW`} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="article" />
        <script type="application/ld+json">{articleJsonLd(interview)}</script>
      </Helmet>
      <div className="flex-grow pt-28 pb-20 px-4 md:px-8 max-w-4xl mx-auto w-full">
        <nav aria-label="Breadcrumb" className="mb-6 text-sm">
          <Link to={interviewsPath()} className="text-primary underline underline-offset-2">
            All interviews
          </Link>
        </nav>

        {bookAvailable && (
          <div className="mb-8 flex gap-2" role="group" aria-label="How to read this interview">
            <button
              type="button"
              onClick={() => setView('article')}
              aria-pressed={!showBook}
              className="rounded border border-border px-4 py-2 text-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground"
            >
              Read as article
            </button>
            <button
              type="button"
              onClick={() => setView('book')}
              aria-pressed={showBook}
              className="rounded border border-border px-4 py-2 text-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground"
            >
              Book view
            </button>
          </div>
        )}

        {showBook ? (
          <Suspense fallback={<p className="text-foreground">Opening the book…</p>}>
            <InterviewBook interview={interview} />
          </Suspense>
        ) : (
          <InterviewArticle interview={interview} />
        )}
      </div>
    </>
  );
}

/** One interview by its slug: the skeleton while it loads, the not-found page when there is none. */
function InterviewBySlug({ slug }) {
  const { data, loading } = usePublicData(() => fetchPublicInterview(slug), interviewKey(slug));
  const interview = useMemo(() => readInterview(data), [data]);
  if (loading && !interview) return <DetailSkeleton />;
  if (!interview || interview.slug !== slug) return <NotFoundPage />;
  return <InterviewDetail interview={interview} />;
}

export default function InterviewsPage() {
  const { interviewId } = useParams();
  if (!interviewId) return <InterviewList />;
  return <InterviewBySlug slug={interviewId} />;
}

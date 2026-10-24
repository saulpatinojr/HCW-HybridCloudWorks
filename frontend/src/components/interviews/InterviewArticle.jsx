/**
 * One interview as an article: the whole transcript in reading order.
 *
 * This is the interview. The book view (InterviewBook) is the same text laid
 * out as pages for people who want it; this is what search engines read, what
 * a screen reader reads, what a phone shows, and what is pre-rendered, so it
 * holds every word and every link the book does.
 *
 * Every string comes from a checked interview file (lib/interviews.js) and is
 * rendered as text by React, never as markup, so a stray `<` in an answer
 * shows as a `<` and not as a tag. Links were checked there too: an address on
 * this site or an https:// address, nothing else.
 */
import React from 'react';
import { Link } from 'react-router';
import { formatInterviewDate, isExternalLink } from '@/lib/interviews';

/** A link that stays in the app when it is on this site, and says so when it leaves. */
function InterviewLink({ to, children }) {
  const className = 'text-primary underline underline-offset-2 hover:no-underline';
  if (isExternalLink(to)) {
    return (
      <a href={to} className={className} rel="noopener noreferrer">
        {children}
        <span className="sr-only"> (opens another site)</span>
      </a>
    );
  }
  return (
    <Link to={to} className={className}>
      {children}
    </Link>
  );
}

function LinkList({ heading, items }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">{heading}</h3>
      <ul className="list-disc pl-5 space-y-1 text-foreground">
        {items.map((item) => (
          <li key={item.url}>
            <InterviewLink to={item.url}>{item.title}</InterviewLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** @param {{ interview: ReturnType<typeof import('@/lib/interviews').normalizeInterview> }} props */
export default function InterviewArticle({ interview }) {
  const { title, subtitle, date, guest, bio, image, tags, qa, related } = interview;
  const hasRelated = related.labs.length > 0 || related.learn.length > 0;

  return (
    <article className="text-foreground" aria-labelledby="interview-title">
      {/* A plain div, not <header>: the site styles every bare <header> element
          (index.css) as its own page header, a darker box with a rule beneath. */}
      <div className="mb-10">
        <div className="flex items-start gap-5">
          {image && (
            <img
              src={image.src}
              alt={image.alt}
              width={112}
              height={112}
              className="h-28 w-28 shrink-0 rounded-full object-cover border border-border"
            />
          )}
          <div>
            <h1
              id="interview-title"
              className="text-3xl sm:text-4xl md:text-5xl font-bold text-slate-900 dark:text-white"
            >
              {title}
            </h1>
            {subtitle && <p className="mt-3 text-lg text-foreground">{subtitle}</p>}
            <p className="mt-3 text-sm text-foreground/70">
              {guest.name}
              {guest.role ? `, ${guest.role}` : ''} ·{' '}
              <time dateTime={date}>{formatInterviewDate(date)}</time>
            </p>
          </div>
        </div>
        {bio && (
          <section aria-labelledby="interview-guest" className="mt-8">
            <h2
              id="interview-guest"
              className="text-xl font-semibold text-slate-900 dark:text-white mb-2"
            >
              About the guest
            </h2>
            <p className="whitespace-pre-line">{bio}</p>
          </section>
        )}
        {tags.length > 0 && (
          <ul className="mt-5 flex flex-wrap gap-2" aria-label="Topics">
            {tags.map((tag) => (
              <li
                key={tag}
                className="rounded border border-border bg-card/40 px-2 py-0.5 text-xs text-foreground/80"
              >
                {tag}
              </li>
            ))}
          </ul>
        )}
      </div>

      <section aria-labelledby="interview-transcript">
        <h2 id="interview-transcript" className="sr-only">
          Transcript
        </h2>
        <div className="space-y-8">
          {qa.map((item, index) => (
            <section
              key={item.q}
              id={`question-${index + 1}`}
              aria-labelledby={`question-${index + 1}-heading`}
              className="border-t border-border pt-6"
            >
              <h3
                id={`question-${index + 1}-heading`}
                className="text-xl font-semibold text-slate-900 dark:text-white mb-3"
              >
                {item.q}
              </h3>
              <p className="whitespace-pre-line leading-relaxed">{item.a}</p>
              {item.pullQuote && (
                <blockquote className="mt-4 border-l-4 border-primary pl-4 text-lg italic text-foreground">
                  {item.pullQuote}
                </blockquote>
              )}
            </section>
          ))}
        </div>
      </section>

      {hasRelated && (
        <section aria-labelledby="interview-related" className="mt-12 border-t border-border pt-6">
          <h2
            id="interview-related"
            className="text-2xl font-semibold text-slate-900 dark:text-white mb-4"
          >
            Keep learning
          </h2>
          <div className="space-y-6">
            <LinkList heading="Labs" items={related.labs} />
            <LinkList heading="Microsoft Learn" items={related.learn} />
          </div>
        </section>
      )}
    </article>
  );
}

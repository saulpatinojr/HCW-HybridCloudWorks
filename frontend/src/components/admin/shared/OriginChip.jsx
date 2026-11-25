/**
 * OriginChip — which admin Page sent a piece of content into the Pipeline,
 * and which record on it (#1886): "Ambassador · Example Program", with
 * that Page's icon, linking back to the record.
 *
 * Rendered by TaxonomyChips, so every Pipeline list and board that shows the
 * kind and idea origin shows this too, with no wiring per page. Nothing is
 * rendered for content that no Page sent.
 *
 * `asLink={false}` renders a plain chip, for a row that is itself a button
 * or a link (a link inside either is not valid HTML).
 */
import React from 'react';
import { Link } from 'react-router';
import { originLink } from '@/lib/pageLinks';

const CHIP =
  'inline-flex max-w-full items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary whitespace-nowrap';

export default function OriginChip({ originRef, asLink = true, className = '' }) {
  const link = originLink(originRef);
  if (!link) return null;
  const Icon = link.icon;
  const text = `${link.pageLabel} · ${link.label}`;
  const body = (
    <>
      {Icon && <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />}
      <span className="truncate">{text}</span>
    </>
  );
  const title = `Sent from ${link.pageLabel}: ${link.label}`;
  if (asLink && link.href) {
    return (
      <Link
        to={link.href}
        className={`${CHIP} hover:underline ${className}`}
        title={title}
        data-origin-page={originRef.page}
        onClick={(event) => event.stopPropagation()}
      >
        {body}
      </Link>
    );
  }
  return (
    <span className={`${CHIP} ${className}`} title={title} data-origin-page={originRef.page}>
      {body}
    </span>
  );
}

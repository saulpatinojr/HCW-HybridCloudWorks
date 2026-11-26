/**
 * NextStepLink — once a piece another admin Page sent is live, the natural
 * next Page for it (#1886): "File as evidence" for a program's piece, "Back
 * to the talk", "Back to the certification". The list is lib/nextSteps.js.
 *
 * Rendered by TaxonomyChips beside the "sent from" chip, so every Pipeline
 * list and board that shows a live piece (Publish, Live Pages, the Editor's
 * live board, a review board) offers it with no wiring per page. Renders
 * nothing for a piece that is not live or that no Page sent.
 */
import React from 'react';
import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { nextStepFor } from '@/lib/nextSteps';

const CHIP =
  'inline-flex max-w-full items-center gap-1 rounded-full border border-primary bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground whitespace-nowrap hover:underline';

export default function NextStepLink({ item, className = '' }) {
  const step = nextStepFor(item);
  if (!step) return null;
  return (
    <Link
      to={step.href}
      className={`${CHIP} ${className}`}
      title={step.hint}
      data-next-step={step.page}
      onClick={(event) => event.stopPropagation()}
    >
      {step.label}
      <ArrowRight className="h-3 w-3 shrink-0" aria-hidden="true" />
    </Link>
  );
}

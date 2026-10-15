/**
 * /admin/coder-corner — code-focused content (snippets, breakdowns, use
 * cases, tutorials), listed by status with approve / reject / restore. The
 * list, the filters and the transitions are TypedReviewList (ADR 0033 §2);
 * the card is CoderCornerReviewBoard.
 */
import React from 'react';
import { Code2 } from 'lucide-react';
import TypedReviewList from '@/components/admin/TypedReviewList';
import { CoderCornerReviewBoard } from '@/components/admin/CoderCornerReviewBoard';

const CODER_CORNER_HELP = [
  'What arrives here: content created with the Coder Corner type on Submit URLs, or classified as coder_corner on the review page.',
  'Each card shows the language, difficulty, tags and the first fenced code block, so a snippet can be judged without opening it.',
  'What to do: View opens the review board; Approve sends it to the Editor and Publish stages; Reject removes it (recoverable for about eight days).',
  'Where it goes next: approved items are polished in the Editor and go live from the Publish page under /<provider>/code.',
];

export default function CoderCornerPage() {
  return (
    <TypedReviewList
      type="coder_corner"
      icon={Code2}
      help={CODER_CORNER_HELP}
      nouns={{ singular: 'coder corner item', plural: 'coder corner items' }}
      renderCard={({ navigate: _navigate, ...props }) => (
        <CoderCornerReviewBoard key={props.item.id} {...props} />
      )}
    />
  );
}

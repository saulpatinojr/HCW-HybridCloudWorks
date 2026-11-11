/**
 * ArticleTopicSelect — the "Address topic" dropdown (#1628): the word an
 * article's page address starts with. "Pick automatically" ('') leaves it to
 * the server, which chooses one from the article's words at publish time.
 *
 * A native select, as TaxonomyPicker uses, so it is keyboard-operable and
 * labelled with nothing extra.
 */
import React, { useId } from 'react';
import { Label } from '@/components/ui/label';
import { ARTICLE_TOPICS, ARTICLE_TOPIC_HINT } from '@/lib/articleTopics';

const SELECT_CLASS =
  'mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60';

/**
 * @param {{
 *   value: string,                    a topic word, or '' for automatic
 *   onChange: (value: string) => void,
 *   disabled?: boolean,
 *   hint?: string,                    replaces the standard line under the dropdown
 *   className?: string,
 * }} props
 */
export default function ArticleTopicSelect({
  value,
  onChange,
  disabled = false,
  hint = ARTICLE_TOPIC_HINT,
  className = '',
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const current = value || '';
  // A stored word not on the list is still shown, so the editor sees what
  // the record carries instead of a silently changed value.
  const unknown = current && !ARTICLE_TOPICS.includes(current) ? [current] : [];
  return (
    <div className={className}>
      <Label htmlFor={id} className="text-xs">
        Address topic
      </Label>
      <select
        id={id}
        value={current}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        aria-describedby={hintId}
        className={SELECT_CLASS}
      >
        <option value="">Pick automatically</option>
        {[...unknown, ...ARTICLE_TOPICS].map((topic) => (
          <option key={topic} value={topic}>
            {topic}
          </option>
        ))}
      </select>
      <p id={hintId} className="mt-1 text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

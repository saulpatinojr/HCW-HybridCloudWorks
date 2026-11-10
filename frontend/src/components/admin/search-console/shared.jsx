/**
 * The small pieces every Search Console tab draws: a number tile, a time shown
 * both as "3 hours ago" and as the exact UTC time, a card with a title, and the
 * table styling. Colour is never the only signal: every tone has a word.
 */
import React from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { agoLabel } from '@/lib/cost';
import { utcText } from '@/lib/searchConsole';

/** Text colour for a tone. */
export const TONE_TEXT = Object.freeze({
  ok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-rose-700 dark:text-rose-400',
  muted: 'text-muted-foreground',
});

export const TABLE_CLASS = 'w-full text-xs';
export const TH_CLASS = 'pb-1 pr-3 text-left font-medium text-muted-foreground';
export const TD_CLASS = 'py-1.5 pr-3 align-top border-b border-border/60';
/**
 * A cell holding long text: a page or sitemap address, or a search query in
 * the same breakdown table. It wraps at a space, hyphen or (with Breakable)
 * a slash where it can, and mid-word only when a part is longer than the
 * column, instead of `break-all`, which split every address at the column
 * edge ("…/e/m" then "icrosoft-…").
 */
export const URL_CELL_CLASS = 'min-w-[13rem] [overflow-wrap:anywhere]';
/** A short cell (a word or two, a link) that should not wrap. */
export const NOWRAP_CELL_CLASS = 'whitespace-nowrap';

/**
 * An address with an optional line break after each slash, so a long one
 * wraps between its parts ("…hybridcloudworks.com/" then "e/…") before it is
 * ever split inside one, and a host name that is itself too long wraps after
 * a dot ("podcast." then "hybridcloudworks.com/"). The scheme stays on the
 * host ("https://docs…"), so no line is just "https://". The text, and what
 * a screen reader or a copy reads, is unchanged: `<wbr>` adds no character.
 */
export function Breakable({ text }) {
  const value = String(text ?? '');
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value)?.[0] ?? '';
  const parts = value.slice(scheme.length).split('/');
  const host = scheme ? parts[0].split('.') : null;
  return parts.map((part, index) => (
    <React.Fragment key={index}>
      {index === 0 && host
        ? [
            scheme,
            ...host.map((label, at) => (
              <React.Fragment key={at}>
                {label}
                {at < host.length - 1 ? (
                  <>
                    .<wbr />
                  </>
                ) : null}
              </React.Fragment>
            )),
          ]
        : part}
      {index < parts.length - 1 ? (
        <>
          /<wbr />
        </>
      ) : null}
    </React.Fragment>
  ));
}

/**
 * One number and what it counts, with an optional second line.
 * Not a link (the shared StatTile is one), because these tiles open nothing.
 */
export function Tile({ label, value, note = null, tone = null, testId }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border p-3.5 sm:p-4" data-testid={testId}>
      <span className={`text-2xl font-bold leading-8 tabular-nums ${tone ? TONE_TEXT[tone] : ''}`}>
        {value}
      </span>
      <span className="truncate text-xs font-medium text-muted-foreground" title={label}>
        {label}
      </span>
      {note ? <span className="mt-0.5 text-xs text-muted-foreground">{note}</span> : null}
    </div>
  );
}

/** "3 hours ago" with the exact UTC time beside it, or a dash when there is no time. */
export function WhenText({ iso, fallback = '—', stacked = false }) {
  const exact = utcText(iso);
  if (!exact) return <span>{fallback}</span>;
  const ago = agoLabel(iso);
  return (
    <time dateTime={iso} title={exact} className={stacked ? 'flex flex-col' : undefined}>
      <span>{ago}</span>
      <span className="text-muted-foreground">{stacked ? exact : ` (${exact})`}</span>
    </time>
  );
}

/** The card each section sits in: a title, one optional sentence, then the content. */
export function Section({ title, description = null, children }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

/** A row of toggle chips: one pressed at a time, "All" first. */
export function ChipRow({ label, options, value, onChange }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs text-muted-foreground">{label}:</span>
      {options.map((option) => {
        const pressed = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={pressed}
            onClick={() => onChange(option.value)}
            className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
              pressed
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

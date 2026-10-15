/**
 * "Slug" — the per-article URL control on the Publish page (#400).
 *
 * WHERE IT LIVES AND WHY. On PublishedPage's already-live list, inside the row
 * for the article being fixed. That list is where an operator goes to see what
 * is live and on what URL: every row already carries "View Live", the page
 * already owns the publish workflow, and the bulk image backfill already sits
 * on it. The editor at /admin/editor/:blogId was the alternative and is worse
 * for this job — it is about an article's body, it is reached by knowing an
 * id, and a URL collision is something you notice while looking across the
 * published set rather than while editing one article.
 *
 * WHAT IT SENDS. The raw input, to POST cms/content/slug. Normalisation is
 * `slugify` in functions/src/lib/cms/publish.js and there is no package shared
 * with this one, so a live client-side preview would mean a second copy of the
 * one function whose output IS the URL — which is the class of divergence that
 * caused #400 in the first place. The response names `requested` beside `slug`
 * instead, and this panel shows both whenever they differ, so an operator who
 * typed something loose sees exactly what was stored.
 *
 * WHAT COMES BACK is one atomic outcome, not two: the route sets the slug and
 * moves curatedSubpagePath / slugPageUrl / publishedUrl / publicUrl in a single
 * conditional patch. So there is no "half applied" state to render — every
 * response is a move, a repair, a truthful no-op, or a refusal that wrote
 * nothing, and all four are shown with their reason.
 *
 * The response's `fields` is what was actually written, and this panel prints
 * it rather than naming the four URL fields itself: keys already holding the
 * right value are dropped from the patch, so which of them a given write
 * touches depends on the document (see `buildSlugPublishUpdate` in
 * functions/src/lib/cms/publish.js) and a fixed list here would be a claim
 * this page cannot make.
 *
 * A refusal always means nothing was written — including the one an operator
 * is most likely to meet by surprise, an article whose published path cannot
 * be computed. Its message names what would fix it, so it is rendered as-is
 * rather than reworded here.
 */
import React, { useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import RoleGate from '@/components/admin/RoleGate';
import { postJSON } from '@/lib/api';
import { logAdminAction } from '@/lib/auditLog';
import { safeUrl } from '@/lib/safeUrl';

export const SET_SLUG_ROUTE = 'cms/content/slug';

/**
 * The `sourceUrl` to render as a link, or `''` when it must not be one.
 *
 * `sourceUrl` IS ATTACKER-INFLUENCED. It arrives on curated articles from an
 * upstream feed this site does not control, and putting it straight into an
 * `href` is the `javascript:` sink `safeUrl` exists for. Caught in review on
 * PR #421.
 *
 * `safeUrl` alone is necessary and not sufficient here. It also permits
 * `mailto:` and relative references, and its own header warns that a leading
 * `//` is a relative reference by the URL grammar — `//evil.example` passes and
 * navigates off-site. None of those is ever a legitimate upstream source, so
 * this narrows to an ABSOLUTE http/https URL and rejects everything else,
 * including the empty string, which would render a link to the current page.
 */
export function sourceLinkHref(value) {
  const safe = safeUrl(value, '');
  if (!safe) return '';
  return /^https?:\/\//i.test(safe) ? safe : '';
}

/**
 * The value to offer. `Slug` FIRST, because where the two differ, `slug` holds
 * the contested URL and `Slug` holds the source publisher's — the surviving
 * record of what the article actually is, and therefore the right answer.
 *
 * THE SUGGESTION CAN BE USELESS, AND ON #400's OWN ARTICLES IT NOW IS. This
 * was written expecting `Slug` to still differ per article. Measured against
 * production on 2026-09-08, all three of them carry the SAME value in both
 * fields, so the suggestion is the contested slug three times over and tells
 * an operator nothing. That is why the panel identifies the article
 * independently of the slug — see the identity line in the render.
 *
 * `slug` is the fallback for an article that only needs its URLs re-derived;
 * neither present means there is nothing to suggest and the operator types one.
 */
export function suggestedSlugFor(item = {}) {
  return String(item.Slug || item.slug || '').trim();
}

/** The slug the article is serving on today, for the "current" line. */
export function currentSlugOf(item = {}) {
  return String(item.slug || item.Slug || '').trim();
}

/**
 * The response as a line to render. Pure, so every branch is pinned by a test
 * rather than by clicking.
 *
 * THREE OUTCOMES, NOT TWO, and the third is the one this got wrong. A write
 * that does not move the slug is still a real write: `Slug` brought into line
 * with `slug`, or URL fields that were never written, on an article whose
 * published URLs had drifted from the slug it serves. That is one of the
 * situations this control exists for, and reporting it with the same sentence
 * as a move produced `Moved from "x" to "x"` — which reads as a bug in the
 * tool rather than as the repair it was. An operator correcting a live URL has
 * to be able to tell a move from a repair, so they are separate sentences and
 * the repair names the fields it touched.
 *
 * `moved` comes from the server, which knows what it wrote, rather than being
 * inferred here — the same reason normalisation is server-side. The comparison
 * is kept only as a fallback for the deploy window in which the page is newer
 * than the Functions app and the field is absent.
 */
export function describeSetSlugResult(result = {}) {
  if (!result.changed) {
    return {
      tone: 'muted',
      message: `No change — ${result.reason || 'the article was already on that slug'}.`,
      publicUrl: result.publicUrl || '',
    };
  }
  const moved =
    typeof result.moved === 'boolean' ? result.moved : result.previousSlug !== result.slug;

  if (!moved) {
    const fields = Array.isArray(result.fields) ? result.fields : [];
    const what = fields.length ? `Repaired ${fields.join(', ')}.` : 'Repaired its published URLs.';
    return {
      tone: 'ok',
      message: `Slug unchanged ("${result.slug}") — its published URLs had drifted from it. ${what}`,
      publicUrl: result.publicUrl || '',
    };
  }

  const normalised =
    result.requested && result.requested.trim() !== result.slug
      ? ` (normalised from "${result.requested.trim()}")`
      : '';
  return {
    tone: 'ok',
    message: `Moved from "${result.previousSlug || 'no slug'}" to "${result.slug}"${normalised}. The manifest routes it on the next rebuild.`,
    publicUrl: result.publicUrl || '',
  };
}

export default function SetSlugPanel({ item, onApplied }) {
  const suggested = suggestedSlugFor(item);
  const current = currentSlugOf(item);
  const sourceHref = sourceLinkHref(item.sourceUrl);
  const [value, setValue] = useState(suggested);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState(null);

  const apply = async () => {
    setSaving(true);
    setError('');
    setOutcome(null);
    try {
      const result = await postJSON(SET_SLUG_ROUTE, { contentId: item.id, slug: value });
      setOutcome(describeSetSlugResult(result));
      await logAdminAction('content_slug_set', {
        contentId: item.id,
        requested: value,
        slug: result.slug || null,
        previousSlug: result.previousSlug || null,
        changed: Boolean(result.changed),
        moved: Boolean(result.moved),
      });
      if (result.changed) onApplied?.(item.id, result);
    } catch (err) {
      // authedFetch throws the API's own `error` string, which for a refusal
      // names the holding document id or says the probe could not answer.
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2 border-t pt-3 text-sm">
      {/*
        WHO THIS ARTICLE IS, independent of anything that can collide.

        A slug collision is the one case where several rows look identical in
        the list — same title, same provider, same date — because sharing a
        title is how they collided in the first place. #400's three articles
        are exactly that, and neither the row nor the "current slug" line below
        can tell them apart: all three carry the same value in `slug` AND in
        `Slug`. Without this line the operator has to guess which row is which,
        and guessing wrong puts an article on another article's URL.

        The content id always exists and is what every other admin surface and
        the API refer to. The source URL is the human-readable half — for a
        curated article it is the upstream post, which says what the article is
        in a way a title that has been overwritten cannot. Rendered only when
        present, because an authored article has none.
      */}
      <p className="text-xs text-muted-foreground">
        Article: <code>{item.id}</code>
        {sourceHref ? (
          <>
            {' · '}
            <a
              href={sourceHref}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2"
            >
              source
            </a>
          </>
        ) : null}
      </p>

      <p className="text-xs text-muted-foreground">
        Current slug: <code>{current || 'none'}</code>
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`slug-${item.id}`} className="sr-only">
          Slug for {item.Title || item.title || item.id}
        </label>
        <input
          id={`slug-${item.id}`}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={saving}
          placeholder="article-url-slug"
          className="flex-1 min-w-[16rem] rounded-md border bg-background px-2 py-1 font-mono text-xs"
        />
        {/* The route republishes, so it is publisher (lib/cms/set-slug.js). */}
        <RoleGate
          minRole="publisher"
          reason="Setting a slug republishes the page, which needs the publisher role."
        >
          <Button size="sm" onClick={apply} disabled={saving || !value.trim()}>
            {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Set slug &amp; republish
          </Button>
        </RoleGate>
      </div>

      {suggested && suggested !== value && (
        <p className="text-xs text-muted-foreground">
          Suggested (this article&apos;s own <code>Slug</code> field): <code>{suggested}</code>{' '}
          <button
            type="button"
            onClick={() => setValue(suggested)}
            disabled={saving}
            className="underline"
          >
            Use it
          </button>
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        Writes the slug and moves the article&apos;s URLs in one step. A slug another article holds
        is refused, and the value is normalised the way the publish pipeline would.
      </p>

      {error && <p className="text-sm text-destructive">Slug not set: {error}</p>}
      {outcome && (
        <p
          className={
            outcome.tone === 'ok'
              ? 'text-sm text-emerald-600 dark:text-emerald-400'
              : 'text-sm text-muted-foreground'
          }
        >
          {outcome.message}{' '}
          {outcome.publicUrl && (
            <a href={outcome.publicUrl} target="_blank" rel="noreferrer" className="underline">
              {outcome.publicUrl}
            </a>
          )}
        </p>
      )}
    </div>
  );
}

/** The row button that opens the panel, so the icon and label live with it. */
export function SetSlugButton({ open, onToggle }) {
  return (
    <Button size="sm" variant="outline" onClick={onToggle} aria-expanded={open}>
      <Link2 className="h-4 w-4 mr-2" />
      Slug
    </Button>
  );
}

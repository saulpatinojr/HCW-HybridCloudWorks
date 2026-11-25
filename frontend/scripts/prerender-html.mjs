/**
 * What prerender.mjs puts into each document and how it judges a render
 * (moved out of prerender.mjs by #1845, which re-exports all of it): the
 * canonical and social tags, the head React hoists, the seed on the mount
 * point, the template injection, and the checks that refuse a shell, an
 * error page or React's streamed form. Pure functions; nothing here reads
 * or writes a file.
 */

/**
 * Below this many characters of visible text, a page is a shell rather than a
 * page. The smallest legitimate route is a Coming Soon page at ~470; the shell
 * this replaces measured 389 on every URL. 420 sits between them.
 */
const MIN_TEXT_CHARS = 420;

/** Tags React hoists to the document head, emitted ahead of the body markup. */
const HEAD_TAG = /^\s*<(link|meta|title|style|script|base)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/i;

/**
 * The canonical origin and URL shape. Decided 2026-08-23 from evidence, not
 * preference, because canonical and trailing slash cannot be chosen separately:
 * a canonical pointing at a URL that redirects is worse than no canonical.
 *
 *   - The live Firebase site 301s `/about` to `/about/`, so the form Google
 *     actually resolved and indexed is the TRAILING one.
 *   - Its sitemap advertises `/about`, the non-trailing form. The two have
 *     disagreed the whole time; the sitemap is the half that is wrong.
 *   - Azure was configured `trailingSlash: "never"`, the opposite of live.
 *
 * Trailing looked right — it preserves the indexed form — and was shipped that
 * way for one deploy. It is wrong on this platform.
 *
 * `trailingSlash: "always"` in Static Web Apps applies to EVERY path, files
 * included. Measured live: `/assets/index-*.js`, `/assets/vendor-*.css`,
 * `/icons/hcw-logo.png` and `/sitemap.xml` all returned 301 to a slashed URL.
 * They resolve at the redirect with the correct content type, so nothing broke
 * — it simply cost an extra round trip on every asset on every page load,
 * permanently, to preserve a URL form that a 301 already handles.
 *
 * So: NON-trailing, matching `trailingSlash: "never"`. Existing trailing-form
 * inbound links redirect once and pass their equity on, which is the same
 * mechanism that made the trailing form look preferable in the first place.
 *
 * Apex, not www: every indexed URL and the sitemap use the apex.
 */
export const SITE_ORIGIN = 'https://hybridcloudworks.com';
const DEFAULT_SOCIAL_IMAGE = `${SITE_ORIGIN}/icons/hcw-logo.png`;

/** `/azure/blog` -> `https://hybridcloudworks.com/azure/blog` (root keeps its slash) */
export function canonicalFor(route) {
  const clean = String(route).replace(/^\/+|\/+$/g, '');
  return clean ? `${SITE_ORIGIN}/${clean}` : `${SITE_ORIGIN}/`;
}

/** The value of a `<meta>` already present in the rendered head, if any. */
function metaContent(head, attr, name) {
  const match = new RegExp(`<meta[^>]*${attr}="${name}"[^>]*content="([^"]*)"`, 'i').exec(head);
  return match?.[1] || null;
}

/**
 * The head tags a route did not supply itself.
 *
 * WHY THIS IS NOT OPTIONAL. Pre-rendering made these pages legible to crawlers
 * for the first time, and what they read was `index.html`'s hardcoded
 * `<link rel="canonical" href="https://hybridcloudworks.com">` — every page
 * declaring itself a duplicate of the home page. Titles were correct and the
 * canonical said to consolidate all of them onto one URL anyway.
 *
 * Coverage was also uneven rather than absent: `/azure/news` already emitted
 * og:title and og:description from NewsPage, `/about` emitted neither, and the
 * routes with the best metadata of all — the article and architecture detail
 * templates, which set canonical, og:image and more — are the ones not
 * pre-rendered at all. So this fills gaps and never overwrites: a page that
 * says something about itself keeps saying it.
 */
export function socialTags(head, route, title) {
  const canonical = canonicalFor(route);
  const description = metaContent(head, 'name', 'description');
  const ogTitle = metaContent(head, 'property', 'og:title') || title;
  const ogDescription = metaContent(head, 'property', 'og:description') || description;
  const ogImage = metaContent(head, 'property', 'og:image') || DEFAULT_SOCIAL_IMAGE;

  // escapeAttr, like every other tag below. This one was raw until 2026-08-30,
  // when a T-714 escaping test on the route stamp failed by matching the
  // canonical instead — a route of `/a"><script>x` closed the href and emitted
  // a live element into <head>. Routes are not all hardcoded: `manifest.routes`
  // is built from content slugs, so the value does reach here from data.
  const tags = [`<link rel="canonical" href="${escapeAttr(canonical)}" />`];
  const add = (attr, name, content) => {
    if (!content) return;
    if (metaContent(head, attr, name)) return; // the page said it; leave it alone
    tags.push(`<meta ${attr}="${name}" content="${escapeAttr(content)}" />`);
  };

  // og:url must agree with the canonical or the two signals contradict.
  add('property', 'og:url', canonical);
  add('property', 'og:type', 'website');
  add('property', 'og:site_name', 'Hybrid Cloud Works');
  add('property', 'og:title', ogTitle);
  add('property', 'og:description', ogDescription);
  add('property', 'og:image', ogImage);
  add('name', 'twitter:card', 'summary_large_image');
  add('name', 'twitter:title', ogTitle);
  add('name', 'twitter:description', ogDescription);
  add('name', 'twitter:image', ogImage);

  return tags.join('\n    ');
}

/**
 * `>` IS ESCAPED TOO, and that is not cosmetic. A raw `>` inside a quoted
 * attribute value is legal HTML, so nothing rendered wrong — but it makes the
 * attribute value unscannable by any `[^>]*` pattern, and the mount point this
 * writes is scanned by exactly such a pattern in deploy-azure-frontend.yml. A
 * seed containing `>` would have made that check read the tag as ending early.
 * Added 2026-09-01 alongside the guard that depends on it.
 */
function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Split React's output into head tags and body markup.
 *
 * React 19 hoists `<title>`, `<meta>` and `<link>` rendered anywhere in the tree
 * to the front of the stream, ahead of the first real element. This consumes
 * that run; whatever is left is the body.
 */
export function splitHead(rendered) {
  let rest = rendered;
  const head = [];
  for (;;) {
    const match = HEAD_TAG.exec(rest);
    if (!match) break;
    head.push(match[0].trim());
    rest = rest.slice(match[0].length);
  }
  return { head: head.join('\n    '), body: rest };
}

/**
 * Fizz's streamed form, which a static file must never carry: a pending
 * boundary marker with its placeholder template, a hidden completion segment,
 * or the inline runtime that swaps one into the other. Returns a description
 * of the first thing found, or null for a fully inline document. The three
 * are checked separately because a future React could emit any subset.
 */
export function findStreamedBoundary(html) {
  const source = String(html || '');
  if (source.includes('<!--$?-->')) return 'pending Suspense boundary (<!--$?-->) in the output';
  if (/<div hidden id="S:\d+">/.test(source))
    return 'hidden completion segment (S:n) in the output';
  if (/\$RC\(|\$RB=\[\]|\$RT=performance\.now\(\)/.test(source)) {
    return 'React streaming runtime script in the output';
  }
  return null;
}

/**
 * The attribute `main.jsx` reads the seed from. Agreed in two files; changing
 * it in one and not the other turns hydration back into a full client
 * re-render, silently — the page still works, it just throws away the
 * pre-rendered DOM again, which is precisely the bug T-714 was opened for.
 * `prerender.test.js` pins the pair.
 */
export const SEED_ATTRIBUTE = 'data-prerendered-seed';

/**
 * Serialize the seed into an attribute on the mount point.
 *
 * WHY THIS EXISTS AT ALL. Hydration requires the client's first render to
 * produce the same tree the pre-render produced. `usePublicData` fetches in an
 * effect, so without the data in hand at mount the client renders a skeleton,
 * React sees a mismatch against the article markup, and discards the whole
 * pre-rendered DOM — the 120 documents would be built, shipped, and thrown away
 * exactly as they were before T-714, only more expensively.
 *
 * WHY AN ATTRIBUTE AND NOT A `<script type="application/json" id="...">`
 * ISLAND, which is the usual shape for this (it is what Next.js does with
 * `__NEXT_DATA__`). An island is found with `document.getElementById`, and
 * `getElementById` returns the FIRST element with that id in document order —
 * any element, not just a script. Article bodies are author-written HTML
 * rendered through `DOMPurify.sanitize`, and DOMPurify's default configuration
 * keeps `id` attributes on ordinary elements: it strips an injected
 * `<script id="__PRERENDER_DATA__">` but passes an injected
 * `<div id="__PRERENDER_DATA__">` through untouched. That div sits inside
 * `#root`, so it comes first, and it would have become the seed for its own
 * page — an author-controlled object flowing into every `href` and `src` on it.
 * That is not theoretical: it was reproduced against this repo's DOMPurify
 * before this attribute replaced the island.
 *
 * `src/lib/sanitizeHtml.js` now prefixes author-written ids as well, so the
 * clobber is closed at the sanitizer too. This attribute stays regardless: it
 * does not depend on that configuration staying right, which was the point.
 *
 * The mount point cannot be shadowed the same way. `<div id="root">` is written
 * by the template, ahead of everything the pre-render puts inside it, so an
 * injected `id="root"` is always later in document order and always loses. The
 * seed therefore stops depending on a sanitizer's configuration staying right.
 *
 * `escapeAttr` handles the quoting, and it escapes `<` as well as `&` and `"`,
 * so a literal `</script>` or `<img onerror=...>` inside article text is inert
 * markup-wise — it is attribute text that only ever reaches `JSON.parse`.
 */
export function seedAttribute(seededData) {
  if (!seededData) return '';
  return ` ${SEED_ATTRIBUTE}="${escapeAttr(JSON.stringify(seededData))}"`;
}

/**
 * Put the rendered markup and head tags into the built index.html.
 *
 * The template's own `<title>` is REPLACED, not appended to. Two title elements
 * in one document is not a tie a crawler resolves the way you would hope, and
 * the template's is the generic one.
 */
export function injectIntoTemplate(template, { head, body }, route = '/', seededData = null) {
  let html = template;

  if (/<title\b/i.test(head)) {
    html = html.replace(/\s*<title\b[^>]*>[\s\S]*?<\/title>/i, '');
  }

  // The template's canonical is ALWAYS removed, whether or not the route
  // supplies its own. It is hardcoded to the home page, so leaving it means
  // either a wrong canonical or two competing ones — and Google's guidance for
  // JavaScript sites is explicit that the canonical in the served HTML must not
  // contradict the rendered one.
  html = html.replace(/\s*<link[^>]*rel="canonical"[^>]*>/gi, '');

  const title = /<title\b[^>]*>([^<]*)<\/title>/i.exec(head)?.[1] || '';
  const generated = socialTags(head, route, title);

  // Detail templates set their own canonical via Helmet, so it arrives in
  // `head` — correct in spirit, but the route decides the origin and the
  // trailing-slash form and this step already knows both. Dropping it here and
  // letting socialTags emit one keeps exactly one per document. Leaving it
  // produced TWO on all 24 article pages, which is not a tie a crawler
  // resolves the way anyone hopes.
  const headWithoutCanonical = head.replace(/\s*<link[^>]*rel="canonical"[^>]*>/gi, '');
  const combined = [headWithoutCanonical, generated].filter(Boolean).join('\n    ');

  if (combined) {
    html = html.replace(/<\/head>/i, `    ${combined}\n  </head>`);
  }

  // The mount point keeps its id: the client bundle still hydrates into it.
  const rootDiv = /<div id="root"><\/div>/;
  if (!rootDiv.test(html)) {
    // `/` is written back to dist/index.html, which is also the template. Run
    // this twice without an intervening `vite build` and the second run reads
    // its own output — an empty mount point is the thing that distinguishes
    // them, so say which case this is rather than "no root div".
    if (/<div id="root">\s*\S/.test(html)) {
      throw new Error(
        'dist/index.html has already been pre-rendered. This step needs the ' +
          'template `vite build` produces — run `npm run build`, which does both in order.'
      );
    }
    throw new Error('dist/index.html has no <div id="root"></div> to render into');
  }
  // The seed rides on the mount point itself. Vite's entry is a module script
  // and therefore deferred, so it runs after parsing and the attribute is
  // always present by the time main.jsx reads it — there is no ordering race
  // to reason about.
  const seed = seedAttribute(seededData);

  // THE ROUTE IS STAMPED ON THE MOUNT POINT, and main.jsx refuses to hydrate
  // unless it matches the URL being displayed. This is not belt-and-braces; it
  // is the difference between hydration working and hydration corrupting every
  // page that was never pre-rendered.
  //
  // A path without a file of its own gets some other page's markup: the
  // client-only areas (/admin, /preview, ...) are rewritten to app-shell.html
  // by staticwebapp.config.json, and any other unknown path gets the same
  // shell with a 404 (#1613). The stamp was added when that fallback was the
  // HOME PAGE's markup (T-714), and it still guards the same thing: hydrating
  // markup rendered for one route against the tree of another is a guaranteed
  // mismatch, so main.jsx only hydrates when the stamp matches the URL.
  //
  // Comparing the stamp to location.pathname turns that from something a future
  // route addition can silently trip into a decision made per page load.
  return html.replace(
    rootDiv,
    `<div id="root" data-prerendered-route="${escapeAttr(route)}"${seed}>${body}</div>`
  );
}

/**
 * What to do with one rendered route: write it (`{ ok: true }`), skip it as
 * the 404 page (`{ skip: true }`), or fail the build (`{ failure }`, one line
 * naming the route and the reason). The checks run in this order, and the
 * first that applies decides.
 */
export function judgeRender(route, rendered) {
  if (rendered.errors.length > 0) {
    // An error boundary produces perfectly valid-looking HTML. Without this
    // check the error state would be written out and published as the page.
    return { failure: `${route}: rendered an error — ${rendered.errors[0].message}` };
  }

  const streamed = findStreamedBoundary(rendered.html);
  if (streamed) {
    // A page in Fizz's streamed form passed every check below on 2026-09-06:
    // the shell had header, footer and a spinner, the page itself sat in a
    // hidden segment, and the text count was well above the shell floor.
    // It is not a page — nothing without JavaScript ever sees the content,
    // and the browser cannot run the swap script under this site's CSP.
    return { failure: `${route}: ${streamed} (see prerender-entry.jsx progressiveChunkSize)` };
  }

  if (rendered.html.includes('data-page="not-found"')) {
    // Not an error. `/:provider/<section>` is declared for every provider,
    // and the dispatcher behind it renders the 404 page for the combinations
    // that have no content — /azure/code and /github/frameworks among them.
    // The route list is a candidate grid, so this is the expected answer for
    // a real part of it.
    //
    // It must still be SKIPPED rather than written: the page says "this page
    // does not exist" and would be served at HTTP 200 for a crawler to index
    // as content. Reported so the count is visible and a sudden jump is not.
    return { skip: true };
  }

  const text = rendered.html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < MIN_TEXT_CHARS) {
    return { failure: `${route}: only ${text.length} characters of text — a shell, not a page` };
  }
  return { ok: true };
}

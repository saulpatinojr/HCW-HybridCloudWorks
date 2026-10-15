/**
 * template-layout.js — a weekly issue laid out in the owner's Resend template
 * (#557, Settings → Template).
 *
 * Resend broadcasts take no template id, and template variables cannot loop
 * over a list of articles, so the site does the merge: the published
 * template's HTML is the frame, and the issue's body, rendered by render.js
 * exactly as the built-in design renders it, goes where the template says.
 * Pure: no I/O, no clock, so every rule below is a unit test.
 *
 * ## Markers
 *
 *   {{{NEWSLETTER_BODY}}}       REQUIRED, exactly once: intro, note and sections
 *   {{{NEWSLETTER_SUBJECT}}}    optional: the subject, escaped
 *   {{{NEWSLETTER_PREHEADER}}}  optional: the preview text, escaped
 *   {{{NEWSLETTER_PERIOD}}}     optional: the week's date range, escaped
 *
 * A template without `{{{NEWSLETTER_PREHEADER}}}` still gets the built-in
 * hidden preheader block, first in its body, so the inbox preview text the
 * owner edited is not lost by choosing a design.
 *
 * ## What every email still carries
 *
 * The postal address (CAN-SPAM) and `{{{RESEND_UNSUBSCRIBE_URL}}}`, whatever
 * the template holds. Resend's documentation names the placeholder both
 * `{{{RESEND_UNSUBSCRIBE_URL}}}` and `{{{UNSUBSCRIBE_URL}}}`, so the second is
 * rewritten to the first. A template with neither gets the built-in
 * compliance footer (address and unsubscribe link) before `</body>`; one with
 * the link but not the address gets the address line.
 *
 * A test send makes every unsubscribe link inert and says so, the same as the
 * built-in design (render.js `testSend`). The plain-text part is always the
 * built-in one.
 *
 * ## Trust boundary
 *
 * The template's own HTML is NOT sanitized. It is the owner's content, from
 * the owner's own Resend account, fetched with the site's key; the admin page
 * previews it in an iframe with an empty `sandbox`, so it cannot run script or
 * navigate the page, and inboxes apply their own rules. What IS escaped is
 * everything that comes from an issue: the body is render.js output and every
 * marker value goes through escapeHtml. The only checks on the template are
 * the ones here, which decide whether it can be used at all.
 */
import {
  FOOTER_COLOR,
  TEST_SEND_NOTE,
  TEST_UNSUBSCRIBE_HREF,
  UNSUBSCRIBE_PLACEHOLDER,
  addressHtml,
  escapeHtml,
  renderIssue,
  renderIssueContent,
} from './render.js';

export const NEWSLETTER_BODY_MARKER = '{{{NEWSLETTER_BODY}}}';
export const NEWSLETTER_SUBJECT_MARKER = '{{{NEWSLETTER_SUBJECT}}}';
export const NEWSLETTER_PREHEADER_MARKER = '{{{NEWSLETTER_PREHEADER}}}';
export const NEWSLETTER_PERIOD_MARKER = '{{{NEWSLETTER_PERIOD}}}';
/** The other spelling in Resend's documentation; rewritten to UNSUBSCRIBE_PLACEHOLDER. */
export const ALTERNATE_UNSUBSCRIBE_PLACEHOLDER = '{{{UNSUBSCRIBE_URL}}}';

/** Far above any real email template, and a bound on what one request renders. */
export const MAX_TEMPLATE_BYTES = 500 * 1024;

const APPENDED_STYLE = `padding:16px;font-size:13px;line-height:1.6;color:${FOOTER_COLOR};text-align:center;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

/** Every occurrence, literally: no RegExp, and no `$` replacement patterns. */
const replaceAll = (text, marker, value) => text.split(marker).join(value);
const count = (text, marker) => text.split(marker).length - 1;

/**
 * Why a template cannot be used, or null. `code` is fixed and safe to log;
 * `message` is for the owner.
 *
 * @returns {{ code: string, message: string } | null}
 */
export function templateUnusableReason(templateHtml) {
  if (typeof templateHtml !== 'string') {
    return { code: 'TEMPLATE_NOT_HTML', message: 'The template has no HTML.' };
  }
  if (Buffer.byteLength(templateHtml, 'utf8') > MAX_TEMPLATE_BYTES) {
    return {
      code: 'TEMPLATE_TOO_LARGE',
      message: `The template is larger than ${MAX_TEMPLATE_BYTES / 1024} KB.`,
    };
  }
  const markers = count(templateHtml, NEWSLETTER_BODY_MARKER);
  if (markers === 0) {
    return {
      code: 'TEMPLATE_MARKER_MISSING',
      message: `The template does not contain ${NEWSLETTER_BODY_MARKER}, so there is nowhere to put the week's articles.`,
    };
  }
  if (markers > 1) {
    return {
      code: 'TEMPLATE_MARKER_REPEATED',
      message: `The template contains ${NEWSLETTER_BODY_MARKER} ${markers} times; it must appear exactly once.`,
    };
  }
  return null;
}

/** `insert` placed before the last `</body>`, or at the end when there is none. */
function beforeBodyClose(html, insert) {
  // Matched on the original string: lower-casing the whole document first can
  // change its length (some Unicode characters expand), which would shift the
  // index and splice the footer into the wrong place.
  let at = -1;
  for (const match of html.matchAll(/<\/body\b/gi)) at = match.index;
  return at === -1 ? `${html}${insert}` : `${html.slice(0, at)}${insert}${html.slice(at)}`;
}

/**
 * Issue text for a marker: HTML-escaped, and with braces as entities, so text
 * such as a subject reading `{{{NEWSLETTER_BODY}}}` can never become a marker
 * (or a Resend placeholder) once it is in the document. Braces render the same.
 */
function markerText(value) {
  return escapeHtml(value).replaceAll('{', '&#123;').replaceAll('}', '&#125;');
}

/** `insert` placed just after the opening `<body ...>`, or at the start when there is none. */
function afterBodyOpen(html, insert) {
  const match = /<body\b[^>]*>/i.exec(html);
  if (!match) return `${insert}${html}`;
  const at = match.index + match[0].length;
  return `${html.slice(0, at)}${insert}${html.slice(at)}`;
}

/**
 * Whether the template already shows the postal address: every non-blank line
 * of it, as typed or HTML-escaped. A blank address is never "present".
 */
function containsAddress(html, postalAddress) {
  const lines = String(postalAddress ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => html.includes(line) || html.includes(escapeHtml(line)));
}

/**
 * The template with the issue placed in it.
 *
 * @param {string} templateHtml the published template's HTML
 * @param {ReturnType<typeof renderIssueContent>['parts']} parts render.js's pieces for this issue
 * @param {{ postalAddress: string, testSend?: boolean }} settings
 * @returns {{ ok: true, html: string } | { ok: false, code: string, message: string }}
 */
export function applyTemplateLayout(templateHtml, parts, { postalAddress, testSend = false }) {
  const unusable = templateUnusableReason(templateHtml);
  if (unusable) return { ok: false, ...unusable };

  // Checked against the owner's template alone, before anything from the
  // issue is placed in it, so a subject cannot stand in for the address.
  let html = replaceAll(templateHtml, ALTERNATE_UNSUBSCRIBE_PLACEHOLDER, UNSUBSCRIBE_PLACEHOLDER);
  const hasUnsubscribe = html.includes(UNSUBSCRIBE_PLACEHOLDER);
  const hasAddress = containsAddress(html, postalAddress);
  const hasPreheaderMarker = html.includes(NEWSLETTER_PREHEADER_MARKER);

  html = replaceAll(html, NEWSLETTER_SUBJECT_MARKER, markerText(parts.subject));
  html = replaceAll(html, NEWSLETTER_PREHEADER_MARKER, markerText(parts.preheader));
  html = replaceAll(html, NEWSLETTER_PERIOD_MARKER, markerText(parts.range));
  if (!hasPreheaderMarker && parts.preheaderHtml) html = afterBodyOpen(html, parts.preheaderHtml);

  if (testSend) {
    // A single email has no per-recipient link to fill in.
    html = replaceAll(html, UNSUBSCRIBE_PLACEHOLDER, TEST_UNSUBSCRIBE_HREF);
  }
  if (!hasUnsubscribe) {
    // render.js's footer carries the address, the link and, on a test, the note.
    html = beforeBodyClose(html, `<div style="${APPENDED_STYLE}">${parts.footerHtml}</div>`);
  } else {
    if (!hasAddress) html = beforeBodyClose(html, `<div style="${APPENDED_STYLE}">${addressHtml(postalAddress)}</div>`);
    if (testSend) html = beforeBodyClose(html, `<div style="${APPENDED_STYLE}">${escapeHtml(TEST_SEND_NOTE)}</div>`);
  }

  // The body goes in last, so nothing above can rewrite text inside it.
  const at = html.indexOf(NEWSLETTER_BODY_MARKER);
  html = `${html.slice(0, at)}${parts.bodyHtml}${html.slice(at + NEWSLETTER_BODY_MARKER.length)}`;
  return { ok: true, html };
}

/**
 * The issue in the template, or in the built-in design with the reason when
 * the template cannot be used. The subject and plain text are the same either
 * way.
 *
 * @returns {{ subject: string, html: string, text: string, templateProblem: { code: string, message: string } | null }}
 */
export function renderIssueInTemplate(issue, settings, templateHtml) {
  const { parts, text } = renderIssueContent(issue, settings);
  const merged = applyTemplateLayout(templateHtml, parts, settings);
  if (!merged.ok) {
    // Passed through whole: `{ code, message }` from templateUnusableReason,
    // every sentence of which is written in this module.
    const { ok: _ok, ...templateProblem } = merged;
    return { ...renderIssue(issue, settings), templateProblem };
  }
  return { subject: parts.subject, html: merged.html, text, templateProblem: null };
}

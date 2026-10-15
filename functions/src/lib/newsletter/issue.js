/**
 * issue.js — build this week's newsletter as a DRAFT (ADR 0030 §2a).
 *
 * Replaces `lib/content/digest.js`, which drafted a markdown article from
 * titles and summaries with no links into `newsletters`, where no code read
 * it; the `build-newsletter-issue` job runs this instead of
 * `generate-weekly-digest`. Its drafts carry no `kind`, so the admin surface,
 * which reads only `kind: 'weekly_issue'`, ignores them. An issue is
 * structured instead: the registered sections' items (each with the public URL
 * publishing stored), a short AI-written intro and subject, and a note the
 * owner can add. The email is rendered from that structure (render.js), so
 * editing the note never means editing HTML.
 *
 * Building never sends. An issue is created `draft`, and nothing in this module
 * reaches Resend: sending is a separate, approval-gated step (ADR 0029 §1b's
 * rule, kept by the owner on 2026-09-13).
 *
 * ## One issue per day, and an approved one is never rebuilt
 *
 * The id is the UTC date of the build, so pressing Build twice refreshes the
 * same draft (keeping the owner's note) instead of creating two drafts that
 * could both be approved. Once an issue is scheduled or sent, a rebuild on
 * that day is refused: the email readers get must be the one that was approved.
 *
 * ## Keeping a build in Drafts
 *
 * `build({ keep: true, keptBy })` stamps `savedAt`/`savedBy` on the issue it
 * writes, as the Save-to-Drafts button does, so the issue lands on the Drafts
 * tab instead of the Newsletter tab. The Monday timer uses it (#504). Keeping
 * changes where the draft is shown, never its status: it is still a `draft`,
 * and still needs the owner's approval to send. Every refusal above applies
 * unchanged, so a keep never overwrites a kept or approved issue.
 *
 * ## What goes in is the owner's choice (#557)
 *
 * Every build reads Newsletter settings → Content: only the sections turned
 * on, in the saved order, each capped at its saved item count; the saved
 * number of days back unless the caller names `days` (which is still clamped);
 * and the AI intro only when it is on, in the saved tone. The Build button and
 * the Monday timer both pass no `days`, so both follow the saved window.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { authoredMessage, errorCode } from '../http/error-response.js';
import { presentSetting } from '../platform-settings.js';
import { SECTIONS, collectSections, plainText } from './sections.js';
import {
  DEFAULT_INTRO_TONE,
  DEFAULT_WINDOW_DAYS,
  INTRO_TONES,
  MAX_WINDOW_DAYS,
  NEWSLETTER_SETTINGS_CONFIG_ID,
  newsletterSettingsDefaults,
} from './settings.js';

export { DEFAULT_WINDOW_DAYS };
const MAX_INTRO_LENGTH = 1200;

/**
 * An issue id: the UTC build date, optionally with a short suffix a
 * duplicate gets (admin-handlers.js duplicate; ADR 0033 Amplify slice).
 * Shared with the admin and insights routes so none of them accepts an id
 * the others refuse.
 */
export const ISSUE_ID_PATTERN = /^issue-\d{4}-\d{2}-\d{2}(-[a-z0-9]{1,12})?$/;

/** Statuses a rebuild may overwrite. Anything else has left the owner's hands. */
const REBUILDABLE = new Set(['draft', 'rejected', 'deleted']);

export const INTRO_INSTRUCTION = [
  'You are writing the opening of a weekly email newsletter, not an article.',
  'In "title": a subject line of at most 70 characters naming the week\'s main theme. No emoji, no clickbait.',
  'In "postContent": 3 or 4 plain sentences in one paragraph, first person plural, summarising what was',
  'published and what it means for people running hybrid and multi-cloud estates.',
  'Plain text only in postContent: no markdown, no headings, no lists, no links, no bullet characters.',
  'Mention only items listed in the source material. Do not invent news, numbers or dates.',
].join(' ');

/** The intro instruction with the tone sentence for `tone` appended; an unknown tone reads as the default. */
export function introInstruction(tone = DEFAULT_INTRO_TONE) {
  const sentence = Object.hasOwn(INTRO_TONES, tone)
    ? INTRO_TONES[tone]
    : INTRO_TONES[DEFAULT_INTRO_TONE];
  return `${INTRO_INSTRUCTION} ${sentence}`;
}

/** Remove markdown a model may still emit, so the renderer only ever escapes text. */
export function stripMarkdown(value) {
  return String(value ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$)/g, '$1$2')
    .trim();
}

export function clampWindowDays(days) {
  const n = Number(days);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_WINDOW_DAYS;
  return Math.min(Math.floor(n), MAX_WINDOW_DAYS);
}

/** The context the drafter reads: what is in the issue, and nothing else. */
export function buildIntroContext(sections) {
  return sections
    .map((section) =>
      [
        `## ${section.title}`,
        ...section.items.map(
          (item) => `- ${item.title}${item.summary ? ` — ${item.summary}` : ''}`
        ),
      ].join('\n')
    )
    .join('\n\n');
}

/**
 * An AI failure as the owner reads it: the router's own sentence for a
 * refusal it states (not configured, switched off, out of budget), and a
 * fixed one for anything a provider said (#945).
 *
 * @param {unknown} error - what the AI call threw
 * @returns {string}
 */
export const describeAiError = (error) =>
  authoredMessage(error, `the AI call failed (${errorCode(error)})`).slice(0, 300);

/**
 * Draft an intro, and a subject, for an issue's sections. The builder and the
 * regenerate-intro route (admin-handlers.js) both call this, so an intro
 * written on Monday and one regenerated on Tuesday come from the same
 * instruction and the same cleaning. Throws when the AI does: each caller
 * decides what a failure costs.
 *
 * @param {object} args
 * @param {{ generateDraft: Function }} args.drafter
 * @param {object[]} args.sections the issue's sections
 * @param {string} args.subject kept when the model offers no title
 * @param {string} [args.tone] Newsletter settings' introTone
 * @param {number} [args.budgetMs] the regenerate route's time budget; the
 *   Monday build passes none (router.js, SYNCHRONOUS CALLS HAVE A TIME BUDGET)
 * @returns {Promise<{ subject: string, intro: string }>}
 */
export async function draftIntro({ drafter, sections, subject, tone, budgetMs = null, signal = null }) {
  const draft = await drafter.generateDraft({
    url: 'weekly-newsletter',
    cloudProvider: 'Auto',
    scrapedTitle: subject,
    description: "This week's newsletter issue.",
    markdown: buildIntroContext(sections),
    customInstructionPrompt: introInstruction(tone),
    budgetMs,
    signal,
  });
  const drafted = plainText(stripMarkdown(draft?.title), 120);
  return {
    subject: drafted || subject,
    intro: stripMarkdown(draft?.postContent).slice(0, MAX_INTRO_LENGTH),
  };
}

export const SUBJECT_INSTRUCTION = [
  'You are suggesting subject lines for a weekly email newsletter, not writing an article.',
  'In "keyTopics": exactly 5 different subject lines, each at most 70 characters, each naming the week\'s',
  'main theme a different way. In "title": the best of them. No emoji, no clickbait, no quotation marks.',
  'In "postContent": one plain sentence saying why the first one leads.',
  'Mention only items listed in the source material. Do not invent news, numbers or dates.',
].join(' ');

/** At most this many suggestions come back, and at least MIN or the call failed. */
export const MAX_SUBJECT_SUGGESTIONS = 5;
export const MIN_SUBJECT_SUGGESTIONS = 3;

/**
 * Subject-line suggestions for an issue, through the same drafter as the
 * intro. The drafter's JSON shape is fixed (title, postContent, keyTopics...),
 * so the suggestions ride in `keyTopics` with `title` as the lead. Cleaned to
 * plain text of at most 120 characters, deduplicated without regard to case,
 * capped at five. Throws when the AI does, or when fewer than three survive.
 * `budgetMs` is the route's time budget, as for draftIntro.
 *
 * @returns {Promise<string[]>}
 */
export async function suggestSubjects({ drafter, sections, subject, budgetMs = null }) {
  const draft = await drafter.generateDraft({
    url: 'weekly-newsletter-subjects',
    cloudProvider: 'Auto',
    scrapedTitle: subject,
    description: "Subject lines for this week's newsletter issue.",
    markdown: buildIntroContext(sections),
    customInstructionPrompt: SUBJECT_INSTRUCTION,
    budgetMs,
  });
  const candidates = [draft?.title, ...(Array.isArray(draft?.keyTopics) ? draft.keyTopics : [])];
  const seen = new Set();
  const subjects = [];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const cleaned = plainText(stripMarkdown(candidate).replace(/^["'“”]+|["'“”]+$/g, ''), 120);
    const key = cleaned.toLowerCase();
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    subjects.push(cleaned);
    if (subjects.length === MAX_SUBJECT_SUGGESTIONS) break;
  }
  if (subjects.length < MIN_SUBJECT_SUGGESTIONS) {
    throw new Error(
      `The AI suggested ${subjects.length} usable subject line(s); at least ${MIN_SUBJECT_SUGGESTIONS} are needed. Try again.`
    );
  }
  return subjects;
}

/**
 * The registry sections a build collects, from the saved Content list: the
 * enabled ones in the saved order with their item caps. A registered section
 * the list does not name is collected after them at the default cap, the same
 * rule the settings normalizer applies, so a section passed in that the saved
 * list predates is never silently skipped.
 */
export function planSections(registry, entries = []) {
  const byId = new Map(registry.map((section) => [section.id, section]));
  const named = new Set();
  const sections = [];
  const maxItems = {};
  for (const entry of entries) {
    const section = byId.get(entry?.id);
    if (!section || named.has(section.id)) continue;
    named.add(section.id);
    if (!entry.enabled) continue;
    sections.push(section);
    if (Number.isInteger(entry.maxItems)) maxItems[section.id] = entry.maxItems;
  }
  for (const section of registry) {
    if (!named.has(section.id)) sections.push(section);
  }
  return { sections, maxItems };
}

const defaultSubject = (since, until) => {
  const fmt = (date) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  return `HybridCloudWorks Weekly: ${fmt(since)} – ${fmt(new Date(until.getTime() - 1))}`;
};

/**
 * Newsletter settings, as admin-handlers reads them. An unreadable document
 * costs the owner's choices for this build, not the build: the defaults are
 * what the builder did before settings existed, and the problem is recorded
 * on the issue so the draft says why it may not match the settings.
 */
async function readBuildSettings(store, log) {
  try {
    const doc = await store.readDoc(
      'admin_config',
      NEWSLETTER_SETTINGS_CONFIG_ID,
      ADMIN_CONFIG_PARTITION
    );
    const presented = presentSetting('newsletter-settings', doc);
    // A stored document that fails validation presents as the defaults; say
    // why on the issue, as the Platform Settings API does, instead of silently.
    const problem =
      presented.stored === 'invalid'
        ? `settings: the saved newsletter settings are invalid (${presented.problem}), so the default content choices were used`
        : null;
    return { settings: presented.value, problem };
  } catch (error) {
    log?.warn?.(`[newsletter] settings not read, defaults used: ${error?.message ?? error}`);
    return {
      settings: newsletterSettingsDefaults(),
      problem: 'settings: could not be read, so the default content choices were used',
    };
  }
}

/**
 * Why today's issue is not rebuilt, as the build's answer, or null when it
 * may be: a kept draft holds the owner's edits, and anything approved has
 * left their hands (see the header).
 */
function rebuildRefusal(existing, id) {
  if (existing?.status === 'draft' && existing.savedAt) {
    return {
      success: false,
      issueId: id,
      reason: 'kept',
      message:
        "Today's issue is saved in Drafts, so it is not rebuilt over your edits. Delete it first to build it again.",
    };
  }
  if (existing && !REBUILDABLE.has(existing.status)) {
    return {
      success: false,
      issueId: id,
      reason: 'locked',
      status: existing.status,
      message: `Today's issue is already ${existing.status}; it is not rebuilt, so readers get the version that was approved.`,
    };
  }
  return null;
}

/**
 * The subject and intro for a build: the AI's when the intro is on and the
 * drafter is there, else the default subject and no intro. Intro off is a
 * choice, not a failure: no AI call, no intro, no introError. The AI being
 * off or down costs the intro, not the issue: the items are the newsletter,
 * and the owner can write the note by hand.
 */
async function draftIntroIfEnabled({ drafter, settings, sections, subject, log, signal }) {
  if (!drafter || settings.introEnabled === false) return { subject, intro: '', introError: null };
  try {
    const drafted = await draftIntro({ drafter, sections, subject, tone: settings.introTone, signal });
    return { subject: drafted.subject, intro: drafted.intro, introError: null };
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    const introError = describeAiError(error);
    log?.warn?.(`[newsletter] intro not drafted (${errorCode(error)})`);
    return { subject, intro: '', introError };
  }
}

/**
 * What a rebuild carries forward from the issue it replaces: the owner's
 * note, inbox line and send time belong to them, not to the build, as does
 * the version history (ADR 0033).
 */
function inheritedFields(existing) {
  return {
    customNote: typeof existing?.customNote === 'string' ? existing.customNote : '',
    preheader: typeof existing?.preheader === 'string' ? existing.preheader : '',
    ...(typeof existing?.sendAt === 'string' ? { sendAt: existing.sendAt } : {}),
    ...(Array.isArray(existing?.versions) ? { versions: existing.versions } : {}),
  };
}

/** The issue document a build writes. */
function issueDocument({
  id,
  since,
  until,
  existing,
  collected,
  itemCount,
  drafted,
  keep,
  keptBy,
}) {
  const stamp = until.toISOString();
  return {
    id,
    kind: 'weekly_issue',
    version: 1,
    status: 'draft',
    periodStart: since.toISOString(),
    periodEnd: until.toISOString(),
    subject: drafted.subject,
    intro: drafted.intro,
    introError: drafted.introError,
    ...inheritedFields(existing),
    sections: collected.sections,
    itemCount,
    problems: collected.problems,
    createdAt: existing?.createdAt ?? stamp,
    updatedAt: stamp,
    ...(keep ? { savedAt: stamp, savedBy: keptBy ? String(keptBy).slice(0, 100) : null } : {}),
  };
}

/**
 * @param {object} deps
 * @param {{ queryDocs: Function, readDoc: Function, upsertDoc: Function }} deps.store
 * @param {{ generateDraft: Function } | null} deps.drafter null skips the intro
 * @param {() => Date} [deps.now]
 * @param {object[]} [deps.sections]
 * @param {object} [deps.log]
 * @param {AbortSignal} [deps.signal]
 */
export function createIssueBuilder({
  store,
  drafter,
  now = () => new Date(),
  sections = SECTIONS,
  log,
  signal: defaultSignal,
}) {
  /**
   * @param {{ days?: number, keep?: boolean, keptBy?: string, signal?: AbortSignal }} [payload]
   *   `days` overrides the saved window (clamped); `keep` lands the built issue
   *   in Drafts; `keptBy` is recorded as `savedBy`.
   */
  async function build({ days, keep = false, keptBy = null, signal: callSignal } = {}) {
    const activeSignal = callSignal || defaultSignal;
    if (activeSignal?.aborted) throw activeSignal.reason || new Error('aborted');
    const until = now();
    const { settings, problem: settingsProblem } = await readBuildSettings(store, log);
    const windowDays = clampWindowDays(days ?? settings.windowDays);
    const since = new Date(until.getTime() - windowDays * 24 * 60 * 60 * 1000);
    const id = `issue-${until.toISOString().slice(0, 10)}`;

    const stored = await store.readDoc('newsletters', id, id).catch(() => null);
    // A deleted issue is gone as far as the owner is concerned: rebuild it from
    // scratch rather than carrying its note or creation time forward.
    const existing = stored?.status === 'deleted' ? null : stored;
    const refusal = rebuildRefusal(existing, id);
    if (refusal) return refusal;

    const plan = planSections(sections, settings.sections);
    const collected = await collectSections({
      store,
      since,
      until,
      sections: plan.sections,
      maxItems: plan.maxItems,
      log,
    });
    if (settingsProblem) collected.problems.unshift(settingsProblem);
    const itemCount = collected.sections.reduce((sum, section) => sum + section.items.length, 0);
    if (itemCount === 0) {
      return {
        success: false,
        itemCount: 0,
        reason: 'empty',
        problems: collected.problems,
        message: `Nothing new in the last ${windowDays} days, so no issue was built.`,
      };
    }

    const drafted = await draftIntroIfEnabled({
      drafter,
      settings,
      sections: collected.sections,
      subject: defaultSubject(since, until),
      log,
      signal: activeSignal,
    });
    const doc = issueDocument({
      id,
      since,
      until,
      existing,
      collected,
      itemCount,
      drafted,
      keep,
      keptBy,
    });
    await store.upsertDoc('newsletters', doc);
    return {
      success: true,
      issueId: id,
      subject: drafted.subject,
      itemCount,
      introError: drafted.introError,
      kept: Boolean(keep),
      sections: collected.sections.map((section) => section.id),
      problems: collected.problems,
      message: `Drafted ${id} with ${itemCount} item(s)${keep ? ' and saved it to Drafts' : ''}. Review and approve it in the Newsletter Hub.`,
    };
  }

  return { build };
}

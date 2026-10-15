/**
 * newsletter-autobuild.js — build the weekly newsletter into Drafts every
 * Monday and tell the owner on Telegram (owner decision 2026-09-13, #504).
 *
 * **This never sends.** It calls the issue builder with `keep: true`, which
 * writes a `draft` with `savedAt` set so the issue shows on the Drafts tab of
 * the Newsletter Hub page. Nothing here reaches Resend, and nothing here approves:
 * the only way an issue reaches subscribers is the owner pressing Approve on
 * that tab (ADR 0029 §1b, ADR 0030 §2a).
 *
 * It passes no `days`: how far back to look, which sections and whether an
 * intro is written are Newsletter settings → Content (#557), read by the
 * builder, so the Monday build and the Build button follow the same choices.
 *
 * The builder's refusals are kept, not worked around. If today's issue is
 * already saved to Drafts, or has been approved, scheduled or sent, the build
 * writes nothing and the message says so. A week with nothing new builds
 * nothing. Neither is an error: the timer returns normally, so the host does
 * not record a failure for an outcome that is the builder doing its job.
 *
 * The notification is best-effort (notify.js never throws). A build that
 * throws — Cosmos unreachable, say — is reported and then rethrown, so the
 * failure is visible both on Telegram and in the Functions host.
 */
import { SITE_ORIGIN } from '../newsletter/sections.js';

export const AUTOBUILD_SOURCE = 'buildWeeklyNewsletter';
export const AUTOBUILD_ACTOR = 'auto-build';

/** Where the admin page shows kept drafts: App.jsx `/admin/newsletter-hub`, tab `drafts`. */
export const DRAFTS_PATH = '/admin/newsletter-hub?tab=drafts';

/** The message the owner reads, exported so the test pins it. */
export function buildAutoBuildMessage(result, draftsUrl) {
  if (result?.success) {
    const lines = [
      `Subject: ${result.subject}`,
      `Items: ${result.itemCount}`,
    ];
    if (result.introError) {
      lines.push(`The AI intro was not written (${result.introError}). Add a note by hand before approving.`);
    }
    lines.push('', 'Nothing has been sent. Review and approve it on the Drafts tab:', draftsUrl);
    return {
      title: `Newsletter ready in Drafts: ${result.issueId}`,
      message: lines.join('\n'),
      severity: result.introError ? 'warning' : 'info',
    };
  }
  if (result?.reason === 'empty') {
    return {
      title: 'Newsletter not built: nothing new this week',
      message: `${result.message}\n\nNothing was sent and no draft was written.`,
      severity: 'info',
    };
  }
  return {
    title: `Newsletter not rebuilt${result?.issueId ? `: ${result.issueId}` : ''}`,
    message: `${result?.message || 'The builder refused to build this issue.'}\n\nNothing was overwritten and nothing was sent.\n${draftsUrl}`,
    severity: 'info',
  };
}

/**
 * @param {object} deps
 * @param {{ build: Function }} deps.builder createIssueBuilder(...)
 * @param {{ notifyTelegram: Function }} deps.notifier createNotifier(...)
 * @param {object} [deps.log]
 * @param {string} [deps.siteUrl] origin the Drafts link is built on
 */
export function createNewsletterAutoBuild({ builder, notifier, log = {}, siteUrl = SITE_ORIGIN }) {
  const draftsUrl = `${String(siteUrl).replace(/\/+$/, '')}${DRAFTS_PATH}`;

  async function run() {
    let result;
    try {
      result = await builder.build({ keep: true, keptBy: AUTOBUILD_ACTOR });
    } catch (error) {
      const reason = String(error?.message ?? error).slice(0, 300);
      log.error?.(`[${AUTOBUILD_SOURCE}] build failed: ${reason}`);
      await notifier.notifyTelegram({
        title: 'Newsletter build failed',
        message: `The Monday build of the weekly newsletter failed: ${reason}\n\nNothing was sent. You can build it from the Newsletter Hub:\n${draftsUrl}`,
        severity: 'warning',
        source: AUTOBUILD_SOURCE,
      });
      throw error;
    }

    const notice = buildAutoBuildMessage(result, draftsUrl);
    const notified = await notifier.notifyTelegram({ ...notice, source: AUTOBUILD_SOURCE });
    return {
      success: Boolean(result?.success),
      issueId: result?.issueId ?? null,
      itemCount: result?.itemCount ?? 0,
      reason: result?.success ? 'built' : result?.reason ?? 'refused',
      introError: result?.introError ?? null,
      notified: Boolean(notified?.sent),
      notifyReason: notified?.sent ? null : notified?.reason ?? null,
    };
  }

  return { run };
}

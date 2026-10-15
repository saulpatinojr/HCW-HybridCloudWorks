/**
 * Listen & Learn (route `/admin/listen-and-learn`) — the Audio Library
 * (ADR 0033 §4): books and courses, their chapters and lessons, and each
 * chapter's audio versions, generated as drafts and published only on
 * approval.
 *
 * Four tabs by duty (components/admin/listen-and-learn):
 *
 *   Library    every book and course; open one for its chapters, where a
 *              chapter is reordered, regenerated, versioned, renamed,
 *              archived, deleted, approved or withdrawn
 *   Generate   run a certification's study guide into a course, grounded on
 *              owner-supplied pages and videos (#433), with the expected
 *              speech spend
 *   Review     the chapters of one book that are not live, with transcripts
 *              and a player, and the approval that publishes them
 *   Settings   the voice default and its cost, the voices, where audio
 *              lives, and the providers behind it
 *
 * Deep links are `?tab=`; the old tab and section words (published, sets,
 * episodes, voice, grounding) and anything unknown land where their content
 * went (listen-and-learn/tabs.js). `?platform=&exam=` opens that book, and
 * `&chapter=` rings one of its chapters — the dashboard's Decision Center
 * links a chapter awaiting review as `?tab=review&platform&exam&chapter`.
 *
 * The books and the open book's chapters are read once, here on the page,
 * because Library and Review both show them and an approval on one must be
 * on the other (useListenAndLearn, with its generation guard on reads and a
 * per-chapter in-flight guard on writes). A run keeps reporting its progress
 * while the operator is on another tab, because `generating` and `progress`
 * live in the hook rather than in the Generate tab.
 */

import React, { useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { Headphones } from 'lucide-react';
import { useAuthReady } from '@/hooks/useAuthReady';
import { LINK_PARAMS } from '@/lib/itemLinks';
import PageHeader from '@/components/admin/shared/PageHeader';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import HubTabs from '@/components/admin/HubTabs';
import LibraryTab from '@/components/admin/listen-and-learn/LibraryTab';
import GenerateTab from '@/components/admin/listen-and-learn/GenerateTab';
import { ReviewTab } from '@/components/admin/listen-and-learn/SetEpisodesTab';
import SettingsTab from '@/components/admin/listen-and-learn/SettingsTab';
import useListenAndLearn from '@/components/admin/listen-and-learn/useListenAndLearn';
import { TABS, resolveTab } from '@/components/admin/listen-and-learn/tabs';

/**
 * Each tab's panel, by id. With TABS in listen-and-learn/tabs.js this is the
 * whole of adding a tab: every panel receives the same hub state.
 */
const PANELS = {
  library: LibraryTab,
  generate: GenerateTab,
  review: ReviewTab,
  settings: SettingsTab,
};

const HELP = [
  'A book or course is a set of audio chapters filed under a provider. A course is bound to a certification and its lessons come from the official study guide; a book is your own text, read as written.',
  'A chapter (or lesson) is one audio track with a transcript. It is generated as a draft, approved on the Review tab to go live, and can be renamed, reordered, archived or deleted in the Library.',
  'A version is one take of a chapter’s audio. Regenerating adds a take and keeps the approval; the active take is what the site plays, and an earlier one can be made active again or deleted.',
  'Every take is stored at its own stamped path, so regeneration never overwrites. Audio files are served by path, drafts included: the review gate is on the chapter, not on the bytes.',
  'Economy (gemini-2.5-flash-preview-tts) reads when nothing chooses a model; the estimate beside each action is a ceiling, priced before the money goes.',
];

/** The speech provider that would run today, as the header's status line. */
function speechStatus(catalog) {
  if (!catalog) return <StatusBadge system="unknown" size="xs" />;
  if (catalog.error) return <StatusBadge system="offline" size="xs" />;
  const { speech } = catalog;
  if (speech?.pinError) {
    return (
      <>
        <StatusBadge system="critical" size="xs" />
        <span className="text-muted-foreground">{speech.pinError}</span>
      </>
    );
  }
  if (!speech?.wouldRun) {
    return (
      <>
        <StatusBadge system="critical" size="xs" />
        <span className="text-muted-foreground">
          No speech provider configured — runs save transcripts only
        </span>
      </>
    );
  }
  return (
    <>
      <StatusBadge system="healthy" size="xs" />
      <span className="text-muted-foreground">
        Speech by {speech.wouldRun} · model{' '}
        {catalog.model?.model || 'chosen under AI Engine → Tasks'}
      </span>
    </>
  );
}

export default function ListenAndLearnPage() {
  const { authReady: ready } = useAuthReady();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const hub = useListenAndLearn(ready);

  // A link that names a book opens it once the session is ready. Deferred
  // like every other admin read: the effect starts it, state follows.
  const linkedPlatform = searchParams.get(LINK_PARAMS.platform);
  const linkedExam = searchParams.get(LINK_PARAMS.exam);
  const { openSet } = hub;
  useEffect(() => {
    if (!ready || !linkedPlatform || !linkedExam) return;
    queueMicrotask(() => openSet(linkedPlatform, linkedExam));
  }, [ready, linkedPlatform, linkedExam, openSet]);

  const setTab = (id) => {
    if (id === activeTab) return;
    setSearchParams({ tab: id });
  };

  const ActivePanel = PANELS[activeTab];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Headphones}
        status={speechStatus(hub.catalog)}
        help={HELP}
        helpTitle="How the Audio Library works"
      />

      {hub.error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          <span>{hub.error}</span>
          <button
            type="button"
            onClick={hub.clearError}
            className="text-xs underline underline-offset-2"
          >
            Dismiss
          </button>
        </div>
      )}

      <HubTabs
        tabs={TABS}
        active={activeTab}
        onSelect={setTab}
        idPrefix="listen-and-learn"
        label="Listen & Learn Hub"
      >
        <ActivePanel hub={hub} />
      </HubTabs>
    </div>
  );
}

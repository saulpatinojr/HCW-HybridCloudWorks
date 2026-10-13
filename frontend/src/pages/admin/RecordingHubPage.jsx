/**
 * Recording Hub (route `/admin/recording-hub`) — the podcast pipeline, from a
 * recording to a published episode.
 *
 * Until #576 this had one tab per PROVIDER: Podcast, and Plaud with three
 * sub-tabs of its own. That made "where do I approve a transcript" depend on
 * which service produced it, and put the OAuth setup two clicks inside a
 * working tab. It is a tab per duty now, at the Newsletter Hub's standard
 * (components/admin/recording-hub):
 *
 *   Recordings    the live Plaud library, what is stored, and the two ways to
 *                 add audio — with "Script this" on each
 *   Transcripts   what the pipeline produced, with review and approval
 *   Episodes      what is live on the show, read from the public feed
 *   Distribution  what this hub sent to Podbean and how it went, failures first
 *   Settings      the Plaud connection, the refresh timer's record, and links
 *                 to the settings this hub reads but does not own
 *
 * Providers are named in the header and inside the tabs, not as tabs.
 *
 * Deep links are `?tab=`, which this page did not have at all before — it held
 * the selected tab in `useState`, so no link could name one and Back could not
 * leave one. The two old provider ids and the Plaud sub-tab ids land where
 * their content went (recording-hub/tabs.js).
 *
 * The transcript list is read once, here, because Transcripts and Distribution
 * are two views of it: approving a transcript is exactly what creates the
 * Podbean record Distribution shows (useRecordingHub). /admin/recordings
 * redirects here.
 */
import React from 'react';
import { useSearchParams } from 'react-router';
import { Radio, RefreshCw } from 'lucide-react';
import { useAuthReady } from '@/hooks/useAuthReady';
import { useToast } from '@/components/ui/use-toast';
import { Button } from '@/components/ui/button';
import PageHeader from '@/components/admin/shared/PageHeader';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import HubTabs from '@/components/admin/HubTabs';
import RecordingsTab from '@/components/admin/recording-hub/RecordingsTab';
import TranscriptsTab from '@/components/admin/recording-hub/TranscriptsTab';
import EpisodesTab from '@/components/admin/recording-hub/EpisodesTab';
import DistributionTab from '@/components/admin/recording-hub/DistributionTab';
import SettingsTab from '@/components/admin/recording-hub/SettingsTab';
import useRecordingHub, { CONNECTION } from '@/components/admin/recording-hub/useRecordingHub';
import { TABS, resolveTab } from '@/components/admin/recording-hub/tabs';

/**
 * Each tab's panel, by id. With TABS in recording-hub/tabs.js this is the whole
 * of adding a tab: every panel receives the same hub state.
 */
const PANELS = {
  recordings: RecordingsTab,
  transcripts: TranscriptsTab,
  episodes: EpisodesTab,
  distribution: DistributionTab,
  settings: SettingsTab,
};

/**
 * The Plaud connection as the shared status vocabulary (ADR 0033 §2).
 * `unknown` is a check that could not run — not `disconnected`, which is a
 * check that ran and said so — and keeps its own word.
 */
const HEADER_STATE = Object.freeze({
  [CONNECTION.connected]: { system: 'healthy', text: 'Plaud connected' },
  [CONNECTION.disconnected]: { system: 'critical', text: 'Plaud disconnected' },
  [CONNECTION.checking]: { system: 'unknown', text: 'Checking Plaud…' },
  [CONNECTION.unknown]: { system: 'unknown', text: 'Plaud status unknown' },
});

const HELP = [
  'Recordings: the live Plaud library (once Plaud is connected on Settings), what this site stores, and two ways to add audio by hand. Script this queues a podcast script; Create Content drafts an article from the transcript and opens it in the Editor.',
  'Transcripts: what the pipeline produced. Approve one and it is published to Podbean.',
  'Episodes: what is live on the show, read from the public feed.',
  'Distribution: every send to Podbean and how it went, failures first, each with Retry.',
  'Settings: the Plaud OAuth token, the refresh timer’s record, and links to the voice and licence settings this hub reads but does not own.',
];

export default function RecordingHubPage() {
  const { authReady } = useAuthReady();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const hub = useRecordingHub(authReady, toast);
  const header = HEADER_STATE[hub.connection] || HEADER_STATE[CONNECTION.unknown];

  const setTab = (id) => {
    if (id === activeTab) return;
    setSearchParams({ tab: id });
  };

  const ActivePanel = PANELS[activeTab];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Radio}
        title="Recording Hub"
        help={HELP}
        status={
          <>
            <StatusBadge system={header.system} />
            <span className="text-muted-foreground">{header.text}</span>
          </>
        }
      />

      {hub.connection === CONNECTION.unknown && (
        <p
          role="status"
          className="text-xs text-amber-800 dark:text-amber-300 flex items-center gap-2 flex-wrap"
        >
          Could not check the Plaud connection; the Library may still work.
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-xs px-2"
            onClick={hub.recheckConnection}
          >
            <RefreshCw className="h-3 w-3 mr-1" /> Check again
          </Button>
        </p>
      )}

      <HubTabs
        tabs={TABS}
        active={activeTab}
        onSelect={setTab}
        idPrefix="recording-hub"
        label="Recording Hub"
      >
        <ActivePanel hub={hub} />
      </HubTabs>
    </div>
  );
}

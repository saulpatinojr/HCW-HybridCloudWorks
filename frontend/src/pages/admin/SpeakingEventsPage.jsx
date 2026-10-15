/**
 * Speaking Events Hub (route `/admin/speaking`) — sessions from
 * Sessionize, enriched and published from here; the Spotlight hub the
 * Ambassador hub imports speaking evidence from (ADR 0033 §5).
 *
 * A tab per duty, at the Newsletter Hub's standard (#573, #578;
 * components/admin/speaking-events):
 *
 *   Upcoming    sessions today or later, with Enrich / Edit / Delete, search
 *               and a status filter
 *   Past        delivered sessions, with slides and event links, still editable
 *   Sources     Sessionize (last read, what a sync would change, Sync) and
 *               manual entries (Manual Entry)
 *   Publishing  the public snapshot, what a publish would write, Publish
 *   Settings    the Sessionize speaker ID (read here, saved on the Integrations
 *               Hub's Sessionize card), the speaker profile, the display rules
 *
 * Deep links are `?tab=`; an unknown id, or one naming a tab's content, lands
 * where that content is (speaking-events/tabs.js).
 *
 * The state that Upcoming, Past and Sources share lives on this page: the
 * Sessionize read, the stored overrides, the override editor and the sync.
 * So switching tabs never refetches, and a form opened on Upcoming is still
 * open on Sources. Each read is generation-guarded and each write has an
 * in-flight guard; each tab shows the loading and error state of only the
 * reads it uses, and the header and tab bar always render. The two
 * confirmations the editor asks for — delete, and discard unsaved edits —
 * render here with the shared ConfirmModal.
 *
 * NOT MOVED SERVER-SIDE (yet). #573 proposes reading Sessionize from the API
 * rather than the browser. The browser still fetches the public Sessionize
 * JSON, as the Integrations Hub's Sessionize test does.
 */

import React, { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { Mic } from 'lucide-react';
import { useAuthReady } from '@/hooks/useAuthReady';
import HubTabs from '@/components/admin/HubTabs';
import ConfirmModal from '@/components/admin/ConfirmModal';
import PageHeader from '@/components/admin/shared/PageHeader';
import { TABS, resolveTab } from '@/components/admin/speaking-events/tabs';
import { PastTab, UpcomingTab } from '@/components/admin/speaking-events/SessionsTab';
import SourcesTab from '@/components/admin/speaking-events/SourcesTab';
import PublishingTab from '@/components/admin/speaking-events/PublishingTab';
import SettingsTab from '@/components/admin/speaking-events/SettingsTab';
import useEventEditor, {
  DELETE_CONFIRM,
  DISCARD_CONFIRM,
} from '@/components/admin/speaking-events/useEventEditor';
import useSessionizeSync from '@/components/admin/speaking-events/useSessionizeSync';
import {
  useSessionizeEvents,
  useStoredEvents,
} from '@/components/admin/speaking-events/useSpeakingData';
import { mergeEvents } from '@/components/admin/speaking-events/eventModel';

const PANELS = {
  upcoming: UpcomingTab,
  past: PastTab,
  sources: SourcesTab,
  publishing: PublishingTab,
  settings: SettingsTab,
};

const HELP = [
  'Sessionize is read live; Sync from Sessionize on Sources creates a stored row for each event so you can enrich it.',
  'Enrich a row with its status, CFP deadline, sessions, slides, recording, attendance and evidence links. The Ambassador hub imports those as evidence.',
  'Only rows with Show on site ticked are public; unticking it on a Sessionize event hides that event publicly too.',
  'Visitors see changes after Publish snapshot on the Publishing tab — the About page renders the newer of the published snapshot and the deploy-time copy.',
];

export default function SpeakingEventsPage() {
  const { authReady } = useAuthReady();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));

  const sessionize = useSessionizeEvents();
  const stored = useStoredEvents(authReady);
  const editor = useEventEditor(stored);
  const sync = useSessionizeSync(sessionize, stored);
  const rows = useMemo(
    () => mergeEvents(sessionize.data, stored.data),
    [sessionize.data, stored.data]
  );

  const setTab = (id) => {
    if (id !== activeTab) setSearchParams({ tab: id });
  };
  const ActivePanel = PANELS[activeTab];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Mic}
        description={
          <>
            Sessions from <strong>Sessionize</strong>: ID, name, and date come from Sessionize
            automatically. Use <strong>Enrich</strong> to add a status, description, sessions, image
            and links, then publish them from the Publishing tab.
          </>
        }
        help={HELP}
      />

      <HubTabs
        tabs={TABS}
        active={activeTab}
        onSelect={setTab}
        idPrefix="speaking-events"
        label="Speaking Events Hub"
      >
        <ActivePanel data={{ sessionize, stored, rows }} editor={editor} sync={sync} />
      </HubTabs>

      <ConfirmModal
        open={Boolean(editor.pendingDelete)}
        title={DELETE_CONFIRM.title}
        description={DELETE_CONFIRM.description}
        confirmLabel="Delete"
        onConfirm={editor.confirmRemove}
        onCancel={editor.cancelConfirm}
      />
      <ConfirmModal
        open={editor.pendingDiscard}
        title={DISCARD_CONFIRM.title}
        description={DISCARD_CONFIRM.description}
        confirmLabel="Discard changes"
        onConfirm={editor.confirmDiscard}
        onCancel={editor.cancelConfirm}
      />
    </div>
  );
}

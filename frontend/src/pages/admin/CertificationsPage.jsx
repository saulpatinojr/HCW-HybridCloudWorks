/**
 * Certifications Hub (route `/admin/certifications`) — CRUD for the
 * `certifications` container (via the cms/certifications API) that powers the
 * About page.
 *
 * Until #572 this was one list with an all / featured / expiring / hidden
 * toggle. It now has a tab per duty, at the Newsletter Hub's standard
 * (components/admin/certifications):
 *
 *   Catalog     every cert: stats, search, the issuer filter, add and edit
 *   Featured    what Spotlight leads with, in display order
 *   Renewals    expired and expiring certs with due dates, and what the
 *               Sunday re-verify timer does about them
 *   Publishing  the public snapshot, when it was last published, what changed
 *               since, and Publish snapshot
 *   Settings    image rules, the verification source, the hidden-items list
 *
 * Deep links are `?tab=`; the old view ids (all, featured, expiring, hidden)
 * and anything unknown land where their content went (certifications/tabs.js).
 *
 * The certification list is read once, here on the page, because four tabs
 * show it and an edit on one must be on all of them (useCertifications, with
 * its generation guard and per-cert in-flight guard). Each of those tabs
 * renders the list's loading and error state in place of its own content;
 * Publishing reads its own snapshot while it is open. The header and tab bar
 * always render. The editor and the delete confirmation live here too, so any
 * tab's card can open them.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Award } from 'lucide-react';
import { useAuthReady } from '@/hooks/useAuthReady';
import { useToast } from '@/components/ui/use-toast';
import ServicePageHeader from '@/components/admin/ServicePageHeader';
import PublishSnapshotButton from '@/components/admin/PublishSnapshotButton';
import HubTabs from '@/components/admin/HubTabs';
import CatalogTab from '@/components/admin/certifications/CatalogTab';
import FeaturedTab from '@/components/admin/certifications/FeaturedTab';
import RenewalsTab from '@/components/admin/certifications/RenewalsTab';
import PublishingTab from '@/components/admin/certifications/PublishingTab';
import SettingsTab from '@/components/admin/certifications/SettingsTab';
import CertEditor from '@/components/admin/certifications/CertEditor';
import { DeleteCertDialog } from '@/components/admin/certifications/shared';
import useCertifications from '@/components/admin/certifications/useCertifications';
import { emptyForm } from '@/components/admin/certifications/certView';
import { TABS, resolveTab } from '@/components/admin/certifications/tabs';

/**
 * Each tab's panel, by id. With TABS in certifications/tabs.js this is the
 * whole of adding a tab: every panel receives the same page state.
 */
const PANELS = {
  catalog: CatalogTab,
  featured: FeaturedTab,
  renewals: RenewalsTab,
  publishing: PublishingTab,
  settings: SettingsTab,
};

/** Now, re-read every minute so expiry badges and Renewals move on their own. */
function useNowMs() {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return nowMs;
}

function headerStatus(certs) {
  if (certs.loading) return 'checking';
  return !certs.error;
}

export default function CertificationsPage() {
  const { authReady } = useAuthReady();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = resolveTab(searchParams.get('tab'));
  const certs = useCertifications(authReady, { toast });
  const nowMs = useNowMs();
  const [editing, setEditing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const setTab = (id) => {
    if (id === activeTab) return;
    setSearchParams({ tab: id });
  };

  const { patch, remove, items } = certs;
  const actions = {
    onEdit: setEditing,
    onToggleDisplay: (c) => patch(c, { display: c.display !== true }),
    onToggleFeatured: (c) => patch(c, { featured: !c.featured }),
    onDelete: setConfirmDelete,
  };
  const onNew = () =>
    setEditing({ ...emptyForm, display_order: (items.at(-1)?.display_order || 0) + 1 });

  const confirm = useCallback(
    async (cert) => {
      // Close only when the delete landed: a refused delete keeps the dialog
      // open so it can be retried, and never reads as if it went through.
      if (await remove(cert)) setConfirmDelete(null);
    },
    [remove]
  );

  const ActivePanel = PANELS[activeTab];

  // Update Cert Catalog lives in the header, under the Powered-by pill, so
  // it is one click from every tab (owner request 2026-10-05; it had moved
  // onto the Publishing tab with the tabbed page). The tab keeps the
  // snapshot summary and the diff; this counter tells it a publish landed
  // so it re-reads past every cache.
  const [publishCount, setPublishCount] = useState(0);
  const onPublished = useCallback(() => setPublishCount((n) => n + 1), []);

  return (
    <div className="space-y-6">
      <ServicePageHeader
        icon={Award}
        service="Cosmos DB"
        connected={headerStatus(certs)}
        description="Curate the certification showcase on the About page — feature the wins, hide the noise, and stay ahead of renewals."
        poweredBy="Cosmos DB"
        accent="amber"
        actions={<PublishSnapshotButton label="Update Cert Catalog" onPublished={onPublished} />}
      />

      <HubTabs
        tabs={TABS}
        active={activeTab}
        onSelect={setTab}
        idPrefix="certifications"
        label="Certifications Hub"
      >
        <ActivePanel
          certs={certs}
          nowMs={nowMs}
          actions={actions}
          onNew={onNew}
          publishCount={publishCount}
        />
      </HubTabs>

      {editing && (
        <CertEditor
          cert={editing}
          allCerts={items}
          onClose={() => setEditing(null)}
          onSaved={certs.upsertLocal}
        />
      )}

      <DeleteCertDialog
        cert={confirmDelete}
        busy={Boolean(confirmDelete && certs.busyIds.has(confirmDelete._docId))}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={confirm}
      />
    </div>
  );
}

import React, { useState, useRef } from 'react';
import { useParams, Link } from 'react-router';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchPublicContentItem } from '@/lib/publicApi';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { architecturesByProvider } from '@/data/architectures';
import NotFoundPage from '@/pages/NotFoundPage';
import { useResolvedHotspots } from '@/hooks/useResolvedHotspots';
import ContextSidebar from '@/components/layout/ContextSidebar';
import ShareVia from '@/components/shared/ShareVia';
import MiniLandingFrame from '@/components/shared/MiniLandingFrame';
import {
  architecturePromise,
  architectureSummary,
  deepDiveSections,
  hotspotsOf,
  landingBadges,
  landingPanes,
  paneTab,
  resolveArchitecture,
} from './architectureModel';
import { CostTab, ImplementationTab, OverviewTab, WafTab } from './ArchitectureDeepDiveTabs';
import {
  ArchitectureHelmet,
  LandingActions,
  RelatedArchitectures,
} from './ArchitectureDetailParts';

// Which deep-dive tab is open, and a way to open one and scroll to it.
// A tab that no longer exists falls back to the first one.
function useDeepDiveTabs(availableTabs) {
  const deepDiveRef = useRef(null);
  const defaultTab = availableTabs[0]?.value || '';
  const [activeTab, setActiveTab] = useState(defaultTab);
  const resolvedActiveTab = availableTabs.some((t) => t.value === activeTab)
    ? activeTab
    : defaultTab;

  const openDeepDiveTab = (targetTab) => {
    const resolved = availableTabs.some((t) => t.value === targetTab)
      ? targetTab
      : availableTabs[0]?.value;
    if (!resolved) return;
    setActiveTab(resolved);
    if (deepDiveRef.current && typeof deepDiveRef.current.scrollIntoView === 'function') {
      deepDiveRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return { deepDiveRef, resolvedActiveTab, setActiveTab, openDeepDiveTab };
}

/**
 * Detail page template for architecture designs (#1084).
 *
 * Opens as a one-screen Mini Landing Page (Hero + Promise + Full-width Diagram
 * + 4 doorway panes: How it works, Key services, Security and best practices,
 * Outcome). Clicking any pane opens and scrolls to its deep-dive section below.
 * Empty fields hide their pane or tab rather than rendering placeholder text.
 */
export default function ArchitectureDetailTemplate({ provider = 'aws' }) {
  const { slug } = useParams();

  const { data: item, loading } = usePublicData(
    () => fetchPublicContentItem(slug),
    slug ? `architecture:${slug}` : ''
  );

  const providerKey = String(provider || 'aws').toLowerCase();
  // Only this provider's own catalogue. A provider with none (VMware today)
  // has no built-in designs, so a slug borrowed from another provider is an
  // unknown page, not that provider's design under this heading (#1616 item 3).
  const staticData = architecturesByProvider[providerKey]?.[slug] || null;
  const architecture = resolveArchitecture(item, staticData, providerKey);

  // Before the early returns: hooks must run in the same order on every
  // render, and the loading branch below returns before the diagram exists.
  const resolvedHotspots = useResolvedHotspots(architecture?.diagramXml, hotspotsOf(architecture));

  const sections = deepDiveSections(architecture);
  const { availableTabs } = sections;

  const { deepDiveRef, resolvedActiveTab, setActiveTab, openDeepDiveTab } =
    useDeepDiveTabs(availableTabs);

  if (loading && !staticData && !architecture) {
    return (
      <div className="container mx-auto px-4 py-20 flex justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  // The site's own 404 page, the one every other unknown address shows, so the
  // page says "not found" the same way everywhere and the build's check for
  // `data-page="not-found"` recognises it.
  if (!architecture) {
    return <NotFoundPage />;
  }

  const handlePaneDeepDive = (paneId) => {
    const target = paneTab(paneId, sections);
    if (target) openDeepDiveTab(target);
  };

  const panes = landingPanes(architecture, sections.specComponents, sections.specPatterns);

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <ArchitectureHelmet
        architecture={architecture}
        canonicalUrl={`https://hybridcloudworks.com/${provider}/architecture-designs/${slug}`}
      />

      {/* Context Sidebar for Extras */}
      <ContextSidebar content={architecture.sidebarContent} />

      {/* Top Navigation & Share */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <Button variant="ghost" asChild>
          <Link to={`/${provider}/architecture-designs`}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Architectures
          </Link>
        </Button>
        <ShareVia
          title={architecture.title || 'Architecture'}
          summary={architectureSummary(architecture)}
        />
      </div>

      {/* One-Screen Mini Landing Page (#1084) */}
      <MiniLandingFrame
        eyebrow={`${String(provider).toUpperCase()} Architecture Blueprint`}
        title={architecture.title}
        promise={architecturePromise(architecture)}
        badges={landingBadges(architecture)}
        tags={architecture.tags || []}
        diagramUrl={architecture.diagramUrl}
        hotspots={resolvedHotspots}
        topology={architecture.topology}
        howItWorks={panes.howItWorks}
        keyServices={panes.keyServices}
        practices={panes.practices}
        outcome={architecture.outcome}
        onOpenDeepDive={availableTabs.length > 0 ? handlePaneDeepDive : null}
        actions={
          <LandingActions
            architecture={architecture}
            hasImplementation={sections.hasImplementation}
            onViewCode={() => openDeepDiveTab('implementation')}
          />
        }
      />

      {/* Deep Dive Tabs — only rendered when real deep-dive data exists (#1084 item 3) */}
      {availableTabs.length > 0 && (
        <div ref={deepDiveRef} id="architecture-deep-dive" className="scroll-mt-24">
          <Separator className="my-8" />

          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-bold tracking-tight">Architecture Deep Dive</h2>
            <span className="text-xs font-mono uppercase tracking-wider text-muted-foreground">
              Select a section or click any pane above
            </span>
          </div>

          <Tabs value={resolvedActiveTab} onValueChange={setActiveTab} className="mb-12">
            <TabsList
              className="flex flex-wrap w-full justify-start gap-1 h-auto p-1"
              aria-label="Architecture deep dive sections"
            >
              {availableTabs.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} className="flex-1 min-w-[130px]">
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>

            {sections.hasOverview && <OverviewTab sections={sections} />}
            {sections.hasWaf && <WafTab waf={architecture.waf} />}
            {sections.hasImplementation && (
              <ImplementationTab architecture={architecture} sections={sections} />
            )}
            {sections.hasCost && <CostTab sections={sections} />}
          </Tabs>
        </div>
      )}

      {/* Related Architectures */}
      <RelatedArchitectures related={architecture.relatedArchitectures} />
    </div>
  );
}

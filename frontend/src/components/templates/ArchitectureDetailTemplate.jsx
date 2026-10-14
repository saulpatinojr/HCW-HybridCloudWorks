/* eslint-disable complexity */
import React, { useState, useRef } from 'react';
import RichTextBody from '@/components/shared/RichTextBody';
// Lazy: WafAssessment pulls chart.js (vendor-charts) via FrameworkRadar.
const WafAssessment = React.lazy(() => import('@/components/architecture/WafAssessment'));
import { Helmet } from 'react-helmet-async';
import { useParams, Link } from 'react-router';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchPublicContentItem } from '@/lib/publicApi';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft,
  Download,
  ExternalLink,
  Code,
  Loader2,
  FlaskConical,
  Layers,
} from 'lucide-react';
import { architecturesByProvider, awsArchitectures } from '@/data/architectures';
import { useResolvedHotspots } from '@/hooks/useResolvedHotspots';
import ContextSidebar from '@/components/layout/ContextSidebar';
import ShareVia from '@/components/shared/ShareVia';
import MiniLandingFrame from '@/components/shared/MiniLandingFrame';

function hasNonEmptyList(list) {
  return Array.isArray(list) && list.some((item) => item && String(item).trim() !== '');
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
  const deepDiveRef = useRef(null);

  const { data: item, loading } = usePublicData(
    () => fetchPublicContentItem(slug),
    slug ? `architecture:${slug}` : ''
  );

  const providerKey = String(provider || 'aws').toLowerCase();
  const providerCatalog = architecturesByProvider[providerKey] || awsArchitectures;
  const staticData = providerCatalog?.[slug] || null;

  const itemProvider = String(item?.cloudProvider || item?.provider || '')
    .trim()
    .toLowerCase();
  const providerMatches = !itemProvider || itemProvider === providerKey;
  const dynamicArchitecture =
    item && String(item.type || '').toLowerCase() === 'architecture' && providerMatches
      ? item
      : null;
  const architecture = dynamicArchitecture ? { ...staticData, ...dynamicArchitecture } : staticData;

  // Before the early returns: hooks must run in the same order on every
  // render, and the loading branch below returns before the diagram exists.
  const resolvedHotspots = useResolvedHotspots(
    architecture?.diagramXml,
    architecture?.hotspots || []
  );

  const overviewContent = architecture?.overviewHtml || architecture?.overview || '';
  const specComponents = Array.isArray(architecture?.technicalSpecs?.components)
    ? architecture.technicalSpecs.components.filter(Boolean)
    : [];
  const specPatterns = Array.isArray(architecture?.technicalSpecs?.patterns)
    ? architecture.technicalSpecs.patterns.filter(Boolean)
    : [];
  const whenNotToUse = Array.isArray(architecture?.whenNotToUse)
    ? architecture.whenNotToUse.filter((item) => item && String(item).trim() !== '')
    : [];
  const hasWhenNotToUse = whenNotToUse.length > 0;

  const finopsCostTraps = Array.isArray(architecture?.finopsCostTraps)
    ? architecture.finopsCostTraps.filter(
        (trap) => trap && (trap.service || trap.trap || trap.mitigation)
      )
    : [];
  const hasFinopsCostTraps = finopsCostTraps.length > 0;

  const hasOverview = Boolean(
    String(overviewContent).trim() ||
    specComponents.length > 0 ||
    specPatterns.length > 0 ||
    hasWhenNotToUse
  );
  const hasWaf = Boolean(architecture?.waf);
  const deploymentSteps = Array.isArray(architecture?.deploymentSteps)
    ? architecture.deploymentSteps.filter((s) => s && String(s).trim() !== '')
    : [];
  const terraformCode =
    architecture?.terraformCode && String(architecture.terraformCode).trim() !== ''
      ? architecture.terraformCode
      : '';
  const hasLabVerification = Boolean(
    architecture?.interactiveLabId || architecture?.ecosystemPartnerValidation
  );
  const hasImplementation = Boolean(
    terraformCode || deploymentSteps.length > 0 || hasLabVerification
  );

  const estimatedMonthly =
    architecture?.costAnalysis?.estimatedMonthly || architecture?.estimatedCost || '';
  const costOptimizations = Array.isArray(architecture?.costAnalysis?.optimizations)
    ? architecture.costAnalysis.optimizations.filter(Boolean)
    : [];
  const costBreakdown = Array.isArray(architecture?.costAnalysis?.breakdown)
    ? architecture.costAnalysis.breakdown.filter(
        (row) => row && (row.item || row.label || row.category)
      )
    : [];
  const hasCost = Boolean(
    String(estimatedMonthly).trim() ||
    costOptimizations.length > 0 ||
    costBreakdown.length > 0 ||
    hasFinopsCostTraps
  );

  const availableTabs = [
    hasOverview && { value: 'overview', label: 'Overview' },
    hasWaf && { value: 'waf', label: 'Well-Architected' },
    hasImplementation && { value: 'implementation', label: 'Implementation' },
    hasCost && { value: 'cost', label: 'Cost Analysis' },
  ].filter(Boolean);

  const defaultTab = availableTabs[0]?.value || '';
  const [activeTab, setActiveTab] = useState(defaultTab);
  const resolvedActiveTab = availableTabs.some((t) => t.value === activeTab)
    ? activeTab
    : defaultTab;

  if (loading && !staticData && !architecture) {
    return (
      <div className="container mx-auto px-4 py-20 flex justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!architecture) {
    return (
      <div className="container mx-auto px-4 py-20 text-center">
        <h1 className="text-3xl font-bold mb-4">Architecture Not Found</h1>
        <p className="text-muted-foreground mb-6">
          The architecture you&apos;re looking for doesn&apos;t exist.
        </p>
        <Button asChild>
          <Link to={`/${provider}/architecture-designs`}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Architectures
          </Link>
        </Button>
      </div>
    );
  }

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

  const handlePaneDeepDive = (paneId) => {
    if (paneId === 'how-it-works') {
      openDeepDiveTab(hasOverview ? 'overview' : 'implementation');
      return;
    }
    if (paneId === 'key-services') {
      openDeepDiveTab(hasOverview ? 'overview' : 'implementation');
      return;
    }
    if (paneId === 'security') {
      openDeepDiveTab(hasWaf ? 'waf' : 'overview');
      return;
    }
    if (paneId === 'outcome') {
      if (hasCost) {
        openDeepDiveTab('cost');
      } else {
        openDeepDiveTab(hasImplementation ? 'implementation' : 'overview');
      }
    }
  };

  const badges = [
    architecture.category && { label: architecture.category, variant: 'default' },
    architecture.complexity && { label: architecture.complexity, variant: 'secondary' },
  ].filter(Boolean);

  let howItWorksFallback = [];
  if (hasNonEmptyList(architecture.howItWorks)) {
    howItWorksFallback = architecture.howItWorks;
  } else if (Array.isArray(architecture.topology?.stages)) {
    howItWorksFallback = architecture.topology.stages.map((s) => s.subtitle).filter(Boolean);
  }

  let keyServicesFallback = specComponents.map((name) => ({ name, role: '' }));
  if (Array.isArray(architecture.keyServices) && architecture.keyServices.length > 0) {
    keyServicesFallback = architecture.keyServices;
  } else if (Array.isArray(architecture.services) && architecture.services.length > 0) {
    keyServicesFallback = architecture.services;
  }

  const practicesFallback = hasNonEmptyList(architecture.practices)
    ? architecture.practices
    : specPatterns;

  return (
    <div className="container mx-auto px-4 py-8 max-w-6xl">
      <Helmet>
        <title>{`${architecture.title} | HCW`}</title>
        <meta
          name="description"
          content={architecture.promise || architecture.summary || architecture.description || ''}
        />
        <link
          rel="canonical"
          href={`https://hybridcloudworks.com/${provider}/architecture-designs/${slug}`}
        />
        {/* Open Graph */}
        <meta property="og:type" content="article" />
        <meta property="og:title" content={`${architecture.title} | HCW`} />
        <meta
          property="og:description"
          content={architecture.promise || architecture.summary || architecture.description || ''}
        />
        <meta
          property="og:url"
          content={`https://hybridcloudworks.com/${provider}/architecture-designs/${slug}`}
        />
        {architecture.diagramUrl && <meta property="og:image" content={architecture.diagramUrl} />}
        {/* Twitter Card */}
        <meta
          name="twitter:card"
          content={architecture.diagramUrl ? 'summary_large_image' : 'summary'}
        />
        <meta name="twitter:title" content={`${architecture.title} | HCW`} />
        <meta
          name="twitter:description"
          content={architecture.promise || architecture.summary || architecture.description || ''}
        />
        {architecture.diagramUrl && <meta name="twitter:image" content={architecture.diagramUrl} />}
      </Helmet>

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
          summary={architecture.promise || architecture.summary || architecture.description || ''}
        />
      </div>

      {/* One-Screen Mini Landing Page (#1084) */}
      <MiniLandingFrame
        eyebrow={`${String(provider).toUpperCase()} Architecture Blueprint`}
        title={architecture.title}
        promise={architecture.promise || architecture.summary || architecture.description}
        badges={badges}
        tags={architecture.tags || []}
        diagramUrl={architecture.diagramUrl}
        hotspots={resolvedHotspots}
        topology={architecture.topology}
        howItWorks={howItWorksFallback}
        keyServices={keyServicesFallback}
        practices={practicesFallback}
        outcome={architecture.outcome}
        onOpenDeepDive={availableTabs.length > 0 ? handlePaneDeepDive : null}
        actions={
          <>
            {architecture.diagramUrl && (
              <Button asChild>
                <a href={architecture.diagramUrl} download>
                  <Download className="h-4 w-4 mr-2" />
                  Download Diagram
                </a>
              </Button>
            )}
            {hasImplementation && (
              <Button variant="outline" onClick={() => openDeepDiveTab('implementation')}>
                <Code className="h-4 w-4 mr-2" />
                View IaC Code
              </Button>
            )}
            {architecture.landingZonePreset && (
              <Button variant="outline" asChild>
                <Link to={`/tools/landing-zone?preset=${architecture.landingZonePreset}`}>
                  <Layers className="h-4 w-4 mr-2" />
                  Landing Zone Builder
                </Link>
              </Button>
            )}
            {architecture.interactiveLabId && (
              <Button variant="outline" asChild>
                <Link to={`/education/labs/${architecture.interactiveLabId}`}>
                  <FlaskConical className="h-4 w-4 mr-2" />
                  Test in Browser Lab
                </Link>
              </Button>
            )}
            {architecture.demoUrl && (
              <Button variant="outline" asChild>
                <a href={architecture.demoUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Live Demo
                </a>
              </Button>
            )}
          </>
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

            {hasOverview && (
              <TabsContent value="overview" className="mt-6 space-y-6">
                {String(overviewContent).trim() && (
                  <div className="prose prose-invert max-w-none">
                    <RichTextBody value={overviewContent} />
                  </div>
                )}
                {(specComponents.length > 0 || specPatterns.length > 0) && (
                  <div className="grid md:grid-cols-2 gap-6">
                    {specComponents.length > 0 && (
                      <Card className="bg-card/40">
                        <CardHeader>
                          <CardTitle className="text-lg">Key Components</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1.5">
                            {specComponents.map((comp, idx) => (
                              <li key={idx}>{comp}</li>
                            ))}
                          </ul>
                        </CardContent>
                      </Card>
                    )}
                    {specPatterns.length > 0 && (
                      <Card className="bg-card/40">
                        <CardHeader>
                          <CardTitle className="text-lg">Architecture Patterns</CardTitle>
                        </CardHeader>
                        <CardContent>
                          <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1.5">
                            {specPatterns.map((pat, idx) => (
                              <li key={idx}>{pat}</li>
                            ))}
                          </ul>
                        </CardContent>
                      </Card>
                    )}
                  </div>
                )}
                {hasWhenNotToUse && (
                  <Card
                    className="border-amber-500/30 bg-amber-500/5 dark:bg-amber-950/15"
                    data-testid="blueprint-when-not-to-use"
                  >
                    <CardHeader className="pb-3">
                      <CardTitle className="text-lg text-amber-800 dark:text-amber-300 flex items-center gap-2">
                        <span className="w-1.5 h-4 bg-amber-500 rounded-full" aria-hidden="true" />
                        When NOT to Use This Architecture
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ul className="list-disc list-inside text-sm text-slate-700 dark:text-slate-300 space-y-2">
                        {whenNotToUse.map((reason, idx) => (
                          <li key={idx} className="leading-relaxed">
                            {reason}
                          </li>
                        ))}
                      </ul>
                    </CardContent>
                  </Card>
                )}
              </TabsContent>
            )}

            {hasWaf && (
              <TabsContent value="waf" className="mt-6">
                <React.Suspense
                  fallback={<p className="text-sm text-muted-foreground">Loading assessment…</p>}
                >
                  <WafAssessment waf={architecture.waf} />
                </React.Suspense>
              </TabsContent>
            )}

            {hasImplementation && (
              <TabsContent value="implementation" className="mt-6">
                <div className="space-y-6">
                  {hasLabVerification && (
                    <Card
                      className="border-primary/30 bg-primary/5 dark:bg-primary/10"
                      data-testid="blueprint-lab-verification"
                    >
                      <CardHeader className="pb-3">
                        <div className="flex items-center justify-between gap-4 flex-wrap">
                          <CardTitle className="text-lg flex items-center gap-2">
                            <FlaskConical className="h-5 w-5 text-primary" />
                            Verify Topology in Ephemeral Browser Lab
                          </CardTitle>
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-primary/10 text-primary border border-primary/20">
                            ~15 Min • Zero Local Setup
                          </span>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <p className="text-sm text-muted-foreground leading-relaxed">
                          {architecture.ecosystemPartnerValidation?.validated_with ||
                          architecture.ecosystemPartnerValidation?.validatedWith
                            ? `Co-engineered and validated with ${architecture.ecosystemPartnerValidation.validated_with || architecture.ecosystemPartnerValidation.validatedWith}. `
                            : 'Validated against multi-cloud production baselines. '}
                          Launch an ephemeral browser container workspace with pre-installed CLI
                          toolchains to inspect, lint, and dry-run this architecture without
                          installing local dependencies.
                        </p>
                        <div className="pt-1">
                          <Button asChild>
                            <Link
                              to={
                                architecture.ecosystemPartnerValidation?.cta_url ||
                                architecture.ecosystemPartnerValidation?.ctaUrl ||
                                `/education/labs/${architecture.interactiveLabId}`
                              }
                            >
                              <FlaskConical className="h-4 w-4 mr-2" />
                              {architecture.ecosystemPartnerValidation?.cta_label ||
                                architecture.ecosystemPartnerValidation?.ctaLabel ||
                                'Launch Verification Lab'}
                            </Link>
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {terraformCode && (
                    <Card className="bg-card/40">
                      <CardHeader>
                        <CardTitle>Terraform Configuration</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <pre className="bg-muted/20 p-4 rounded-lg overflow-x-auto">
                          <code className="text-sm">{terraformCode}</code>
                        </pre>
                      </CardContent>
                    </Card>
                  )}

                  {deploymentSteps.length > 0 && (
                    <Card className="bg-card/40">
                      <CardHeader>
                        <CardTitle>Deployment Steps</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ol className="list-decimal list-inside space-y-2 text-muted-foreground">
                          {deploymentSteps.map((step, idx) => (
                            <li key={idx}>{step}</li>
                          ))}
                        </ol>
                      </CardContent>
                    </Card>
                  )}
                </div>
              </TabsContent>
            )}

            {hasCost && (
              <TabsContent value="cost" className="mt-6">
                <div className="grid md:grid-cols-3 gap-6">
                  {String(estimatedMonthly).trim() && (
                    <Card className="bg-card/40">
                      <CardHeader>
                        <CardTitle className="text-lg">Estimated Monthly Cost</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-3xl font-bold text-primary">{estimatedMonthly}</p>
                        <p className="text-sm text-muted-foreground mt-2">
                          Baseline reference estimate
                        </p>
                      </CardContent>
                    </Card>
                  )}

                  {costOptimizations.length > 0 && (
                    <Card className="bg-card/40">
                      <CardHeader>
                        <CardTitle className="text-lg">Cost Optimization</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="text-sm text-muted-foreground space-y-2">
                          {costOptimizations.map((opt, idx) => (
                            <li key={idx}>• {opt}</li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  )}

                  {costBreakdown.length > 0 && (
                    <Card className="bg-card/40">
                      <CardHeader>
                        <CardTitle className="text-lg">Cost Breakdown</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2 text-sm">
                          {costBreakdown.map((row, idx) => (
                            <div key={idx} className="flex justify-between gap-2">
                              <span className="text-muted-foreground">
                                {row.item || row.label || row.category}
                              </span>
                              <span className="font-semibold">
                                {row.cost || row.share || row.percentage || row.value}
                              </span>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                  {hasFinopsCostTraps && (
                    <Card
                      className="border-emerald-500/30 bg-emerald-500/5 dark:bg-emerald-950/15 col-span-full"
                      data-testid="blueprint-finops-cost-traps"
                    >
                      <CardHeader className="pb-3">
                        <CardTitle className="text-lg text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
                          <span
                            className="w-1.5 h-4 bg-emerald-500 rounded-full"
                            aria-hidden="true"
                          />
                          FinOps Cost Traps (FOCUS 1.4 Specification)
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="grid md:grid-cols-2 gap-4">
                          {finopsCostTraps.map((trap, idx) => (
                            <div
                              key={idx}
                              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-background/80 p-3.5 flex flex-col gap-1.5"
                            >
                              <div className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
                                {trap.service}
                              </div>
                              <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                                <span className="font-semibold text-rose-600 dark:text-rose-400">
                                  Trap:{' '}
                                </span>
                                {trap.trap}
                              </p>
                              {trap.mitigation && (
                                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                                  <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                                    Mitigation:{' '}
                                  </span>
                                  {trap.mitigation}
                                </p>
                              )}
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>
              </TabsContent>
            )}
          </Tabs>
        </div>
      )}

      {/* Related Architectures */}
      {architecture.relatedArchitectures && architecture.relatedArchitectures.length > 0 && (
        <section>
          <h2 className="text-2xl font-bold mb-6">Related Architectures</h2>
          <div className="grid md:grid-cols-3 gap-4">
            {architecture.relatedArchitectures.map((related, i) => (
              <Card key={i} className="bg-card/40 hover:bg-card/60 transition-all">
                <CardContent className="p-4">
                  <h3 className="font-semibold mb-2">{related.title}</h3>
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {related.description}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

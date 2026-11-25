import React from 'react';
import { Link } from 'react-router';
import { FlaskConical } from 'lucide-react';
import RichTextBody from '@/components/shared/RichTextBody';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { TabsContent } from '@/components/ui/tabs';
// Lazy: WafAssessment pulls chart.js (vendor-charts) via FrameworkRadar.
const WafAssessment = React.lazy(() => import('@/components/architecture/WafAssessment'));

// The four deep-dive tabs of ArchitectureDetailTemplate. Each one renders
// only when its section has content; the flags come from architectureModel.

// A plain card holding a bulleted list (Key Components, Architecture Patterns).
function BulletListCard({ title, items }) {
  if (items.length === 0) return null;
  return (
    <Card className="bg-card/40">
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1.5">
          {items.map((entry, idx) => (
            <li key={idx}>{entry}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function WhenNotToUseCard({ reasons }) {
  return (
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
          {reasons.map((reason, idx) => (
            <li key={idx} className="leading-relaxed">
              {reason}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function OverviewTab({ sections }) {
  const { overviewContent, specComponents, specPatterns, whenNotToUse, hasWhenNotToUse } = sections;
  const hasSpecs = specComponents.length > 0 || specPatterns.length > 0;
  return (
    <TabsContent value="overview" className="mt-6 space-y-6">
      {String(overviewContent).trim() && (
        <div className="prose prose-invert max-w-none">
          <RichTextBody value={overviewContent} />
        </div>
      )}
      {hasSpecs && (
        <div className="grid md:grid-cols-2 gap-6">
          <BulletListCard title="Key Components" items={specComponents} />
          <BulletListCard title="Architecture Patterns" items={specPatterns} />
        </div>
      )}
      {hasWhenNotToUse && <WhenNotToUseCard reasons={whenNotToUse} />}
    </TabsContent>
  );
}

export function WafTab({ waf }) {
  return (
    <TabsContent value="waf" className="mt-6">
      <React.Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading assessment…</p>}
      >
        <WafAssessment waf={waf} />
      </React.Suspense>
    </TabsContent>
  );
}

// The partner-validation fields, in either spelling the content may use.
function partnerValidation(architecture) {
  const v = architecture.ecosystemPartnerValidation;
  return {
    validatedWith: v?.validated_with || v?.validatedWith,
    ctaUrl: v?.cta_url || v?.ctaUrl || `/education/labs/${architecture.interactiveLabId}`,
    ctaLabel: v?.cta_label || v?.ctaLabel || 'Launch Verification Lab',
  };
}

function LabVerificationCard({ architecture }) {
  const { validatedWith, ctaUrl, ctaLabel } = partnerValidation(architecture);
  return (
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
          {validatedWith
            ? `Co-engineered and validated with ${validatedWith}. `
            : 'Validated against multi-cloud production baselines. '}
          Launch an ephemeral browser container workspace with pre-installed CLI toolchains to
          inspect, lint, and dry-run this architecture without installing local dependencies.
        </p>
        <div className="pt-1">
          <Button asChild>
            <Link to={ctaUrl}>
              <FlaskConical className="h-4 w-4 mr-2" />
              {ctaLabel}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ImplementationTab({ architecture, sections }) {
  const { hasLabVerification, terraformCode, deploymentSteps } = sections;
  return (
    <TabsContent value="implementation" className="mt-6">
      <div className="space-y-6">
        {hasLabVerification && <LabVerificationCard architecture={architecture} />}

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
  );
}

function breakdownLabel(row) {
  return row.item || row.label || row.category;
}

function breakdownValue(row) {
  return row.cost || row.share || row.percentage || row.value;
}

function CostTrapCard({ trap }) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-background/80 p-3.5 flex flex-col gap-1.5">
      <div className="text-xs font-mono font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
        {trap.service}
      </div>
      <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
        <span className="font-semibold text-rose-600 dark:text-rose-400">Trap: </span>
        {trap.trap}
      </p>
      {trap.mitigation && (
        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
          <span className="font-semibold text-emerald-600 dark:text-emerald-400">Mitigation: </span>
          {trap.mitigation}
        </p>
      )}
    </div>
  );
}

function CostTrapsCard({ traps }) {
  return (
    <Card
      className="border-emerald-500/30 bg-emerald-500/5 dark:bg-emerald-950/15 col-span-full"
      data-testid="blueprint-finops-cost-traps"
    >
      <CardHeader className="pb-3">
        <CardTitle className="text-lg text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
          <span className="w-1.5 h-4 bg-emerald-500 rounded-full" aria-hidden="true" />
          FinOps Cost Traps (FOCUS 1.4 Specification)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid md:grid-cols-2 gap-4">
          {traps.map((trap, idx) => (
            <CostTrapCard key={idx} trap={trap} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function CostTab({ sections }) {
  const { estimatedMonthly, costOptimizations, costBreakdown, finopsCostTraps } = sections;
  return (
    <TabsContent value="cost" className="mt-6">
      <div className="grid md:grid-cols-3 gap-6">
        {String(estimatedMonthly).trim() && (
          <Card className="bg-card/40">
            <CardHeader>
              <CardTitle className="text-lg">Estimated Monthly Cost</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold text-primary">{estimatedMonthly}</p>
              <p className="text-sm text-muted-foreground mt-2">Baseline reference estimate</p>
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
                    <span className="text-muted-foreground">{breakdownLabel(row)}</span>
                    <span className="font-semibold">{breakdownValue(row)}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
        {finopsCostTraps.length > 0 && <CostTrapsCard traps={finopsCostTraps} />}
      </div>
    </TabsContent>
  );
}

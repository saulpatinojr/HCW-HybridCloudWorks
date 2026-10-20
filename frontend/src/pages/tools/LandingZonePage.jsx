/**
 * `/tools/landing-zone` — build an Azure landing zone component by component
 * and read the Terraform it becomes (#668, Phase 2 of epic #657).
 *
 * Upgraded to Split-Pane Engineering Workbench with Reference Blueprint presets,
 * live FinOps monthly cost calculation, and topology redraw.
 */
import React, { useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router';
import { AVM_MODULES, AVM_VERIFIED_ON, emitFiles } from '@/lib/landingZone';
import {
  LZ_PRESETS,
  MULTI_CLOUD_PACKS,
  activePresetForState,
  estimateMonthlyBaseline,
} from '@/lib/landingZone/presets';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LzControls } from './landingZone/LzControls';
import { LzDiagram } from './landingZone/LzDiagram';
import { LzExplainButton } from './landingZone/LzExplainButton';
import { LzFiles } from './landingZone/LzFiles';
import { LzTeaches } from './landingZone/LzTeaches';
import { MultiCloudPreview } from './landingZone/MultiCloudPreview';
import { useLzState } from './landingZone/useLzState';

const PAGE_TITLE = 'Landing Zone Builder';
const CANONICAL_URL = 'https://hybridcloudworks.com/tools/landing-zone';
const PATTERN_URL =
  'https://developer.hashicorp.com/validated-patterns/terraform/build-azure-lz-with-terraform';
// "Based on", the wording HashiCorp's trademark policy allows for work derived
// from its material (#1302); the page body links the pattern by its title.
const DESCRIPTION =
  'Assemble an Azure landing zone component by component, read what each part is for, watch the diagram redraw, and download the Terraform it becomes, based on HashiCorp’s validated pattern “Use Terraform to build an Azure landing zone” and the Azure Verified Modules it uses.';

/** Where the teaches panel starts: the component every other one hangs from. */
const INITIAL_FOCUS = 'management-groups';

export default function LandingZonePage() {
  const [state, write] = useLzState();
  const [focusedId, setFocusedId] = useState(INITIAL_FOCUS);
  const selectedCloud = state?.cloud || 'azure';

  const activePreset = useMemo(() => activePresetForState(state), [state]);
  const finops = useMemo(() => estimateMonthlyBaseline(state), [state]);
  const fileCount = useMemo(() => emitFiles(state).length, [state]);

  const handleCloudSelect = (cloud) => {
    write({
      ...state,
      cloud: cloud === 'azure' ? undefined : cloud,
    });
  };

  return (
    <>
      <Helmet>
        <title>{`${PAGE_TITLE} | Hybrid Cloud Works`}</title>
        <meta name="description" content={DESCRIPTION} />
        <link rel="canonical" href={CANONICAL_URL} />
      </Helmet>

      <div
        className="relative z-10 max-w-[1400px] mx-auto w-full px-4 md:px-8 py-8 flex flex-col gap-6"
        data-testid="landing-zone-page"
      >
        {/* Multi-Cloud Target Cloud Selector */}
        <div
          className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3"
          data-testid="lz-cloud-bar"
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Cloud Target:
            </span>
            <div
              className="flex rounded-lg border border-slate-300 dark:border-slate-700 p-0.5 bg-slate-100 dark:bg-slate-900"
              data-testid="lz-cloud-switcher"
            >
              <button
                type="button"
                onClick={() => handleCloudSelect('azure')}
                aria-pressed={selectedCloud === 'azure'}
                className={`rounded-md px-3 py-1 text-xs font-semibold transition-all ${
                  selectedCloud === 'azure'
                    ? 'bg-white dark:bg-slate-800 text-sky-600 dark:text-sky-400 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Azure (Active)
              </button>
              <button
                type="button"
                onClick={() => handleCloudSelect('aws')}
                aria-pressed={selectedCloud === 'aws'}
                className={`rounded-md px-3 py-1 text-xs font-semibold transition-all ${
                  selectedCloud === 'aws'
                    ? 'bg-white dark:bg-slate-800 text-amber-600 dark:text-amber-400 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                AWS (Preview)
              </button>
              <button
                type="button"
                onClick={() => handleCloudSelect('gcp')}
                aria-pressed={selectedCloud === 'gcp'}
                className={`rounded-md px-3 py-1 text-xs font-semibold transition-all ${
                  selectedCloud === 'gcp'
                    ? 'bg-white dark:bg-slate-800 text-emerald-600 dark:text-emerald-400 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                Google Cloud (Preview)
              </button>
            </div>
          </div>
          {selectedCloud !== 'azure' && (
            <button
              type="button"
              onClick={() => handleCloudSelect('azure')}
              className="text-xs font-medium text-sky-600 dark:text-sky-400 hover:underline"
            >
              ← Return to Azure Workbench
            </button>
          )}
        </div>

        {selectedCloud !== 'azure' ? (
          <MultiCloudPreview
            pack={MULTI_CLOUD_PACKS[selectedCloud]}
            onReturn={() => handleCloudSelect('azure')}
            state={state}
            write={write}
          />
        ) : (
          <>
            {/* Blueprint Context Banner when build matches a known preset */}
            {activePreset && (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-2.5 text-xs"
                data-testid="lz-preset-banner"
              >
                <div className="flex items-center gap-2 text-slate-800 dark:text-slate-200">
                  <span className="rounded bg-sky-600 px-2 py-0.5 font-mono text-[10px] font-bold uppercase text-white">
                    {activePreset.badge}
                  </span>
                  <span className="font-semibold">{activePreset.label}:</span>
                  <span className="text-slate-600 dark:text-slate-300">{activePreset.summary}</span>
                </div>
                <Link
                  to={activePreset.blueprintSlug}
                  className="font-semibold text-sky-700 underline underline-offset-2 hover:text-sky-900 dark:text-sky-300 dark:hover:text-white"
                >
                  {`Read Blueprint: ${activePreset.blueprintTitle} →`}
                </Link>
              </div>
            )}

            {/* Header + Live Telemetry Strip */}
            <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-6 border-b border-slate-200 dark:border-slate-800 pb-6">
              <div className="flex flex-col gap-2 max-w-3xl">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">
                  Azure · Terraform · Azure Verified Modules · FinOps Guardrails
                </p>
                <h1
                  id="landing-zone-heading"
                  className="display-heading text-3xl sm:text-4xl text-slate-950 dark:text-white"
                >
                  {PAGE_TITLE}
                </h1>
                <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400">
                  Assemble an Azure landing zone one component at a time. Tick a component to add it
                  and its dependencies come with it; untick one and everything that needs it leaves
                  too. Each component explains what it is for and what breaks without it, the
                  diagram redraws as you build, and the Terraform beneath is based on
                  HashiCorp&rsquo;s validated pattern{' '}
                  <a
                    href={PATTERN_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline decoration-dotted underline-offset-2"
                  >
                    &ldquo;Use Terraform to build an Azure landing zone&rdquo;
                  </a>{' '}
                  using the current Azure Verified Modules, pinned on {AVM_VERIFIED_ON}. The whole
                  build is in this page&rsquo;s address, so a landing zone is a link you can send.
                  Nothing here touches a tenant.
                </p>
              </div>

              {/* Live Workbench Telemetry Pill Bar */}
              <div
                className="grid grid-cols-3 gap-3 shrink-0 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-900/70 p-3"
                data-testid="lz-telemetry-strip"
              >
                <div className="px-2">
                  <div className="text-[10px] font-mono uppercase text-slate-500 dark:text-slate-400">
                    Standing Floor
                  </div>
                  <div className="text-lg font-bold font-mono text-emerald-700 dark:text-emerald-400">
                    {`$${finops.totalMonthlyUsd}/mo`}
                  </div>
                </div>
                <div className="border-x border-slate-200 dark:border-slate-800 px-3">
                  <div className="text-[10px] font-mono uppercase text-slate-500 dark:text-slate-400">
                    Emitted Files
                  </div>
                  <div className="text-lg font-bold font-mono text-slate-900 dark:text-white">
                    {`${fileCount} files`}
                  </div>
                </div>
                <div className="px-2">
                  <div className="text-[10px] font-mono uppercase text-slate-500 dark:text-slate-400">
                    Peered Spokes
                  </div>
                  <div className="text-lg font-bold font-mono text-slate-900 dark:text-white">
                    {finops.totalSpokes}
                  </div>
                </div>
              </div>
            </header>

            {/* 1-Click Architectural Preset Bar */}
            <section aria-label="Architecture presets" className="flex flex-col gap-2">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">
                Load a Reference Blueprint Preset
              </div>
              <div className="flex flex-wrap gap-2" data-testid="lz-preset-bar">
                {LZ_PRESETS.map((preset) => {
                  const isCurrent = activePreset?.id === preset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => write(preset.state)}
                      aria-pressed={isCurrent}
                      className={`rounded-lg border px-3 py-2 text-left text-xs transition-all ${
                        isCurrent
                          ? 'border-sky-500 bg-sky-500/15 text-slate-950 dark:text-white font-semibold shadow-sm'
                          : 'border-slate-300 dark:border-slate-700 bg-background text-slate-700 dark:text-slate-300 hover:border-slate-400 dark:hover:border-slate-500'
                      }`}
                    >
                      <div className="font-semibold">{preset.label}</div>
                      <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400">
                        {preset.badge}
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Main Split-Pane Workbench */}
            <div className="grid gap-8 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-start">
              <div className="flex flex-col gap-6">
                <LzControls
                  state={state}
                  write={write}
                  focusedId={focusedId}
                  onFocus={setFocusedId}
                />

                {/* FinOps Advisory Callout if triggered by current combination */}
                {finops.finopsAdvisories.length > 0 && (
                  <div
                    className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-950 dark:text-amber-200 flex flex-col gap-1"
                    data-testid="lz-finops-advisory"
                  >
                    {finops.finopsAdvisories.map((msg) => (
                      <p key={msg}>{msg}</p>
                    ))}
                  </div>
                )}

                {/* Live FinOps Cost Breakdown Card */}
                <Card data-testid="lz-finops-bom">
                  <CardHeader>
                    <CardTitle className="text-lg">
                      {`Estimated Standing Cost Floor: $${finops.totalMonthlyUsd}/month`}
                    </CardTitle>
                    <CardDescription>
                      Fixed hourly baseline before workload compute or per-GB data processing
                      charges.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ul className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                      {finops.items.map((item) => (
                        <li
                          key={item.label}
                          className="py-2.5 flex items-start justify-between gap-4"
                        >
                          <div>
                            <div className="font-semibold text-slate-900 dark:text-white">
                              {item.label}
                            </div>
                            <div className="text-slate-600 dark:text-slate-400">{item.note}</div>
                          </div>
                          <div className="font-mono font-bold text-slate-900 dark:text-white shrink-0">
                            {`$${item.monthlyUsd}/mo`}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              </div>

              <div className="flex flex-col gap-8 min-w-0">
                <LzTeaches
                  state={state}
                  componentId={focusedId}
                  explain={<LzExplainButton state={state} componentId={focusedId} />}
                />
                <LzDiagram state={state} focusedId={focusedId} onFocus={setFocusedId} />
              </div>
            </div>

            <LzFiles state={state} />

            <section aria-labelledby="landing-zone-modules" className="max-w-3xl">
              <h2
                id="landing-zone-modules"
                className="text-lg font-semibold text-slate-950 dark:text-white mb-2"
              >
                The modules behind the files
              </h2>
              <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
                Four Azure Verified Modules, each pinned to the latest release the Terraform
                Registry listed on {AVM_VERIFIED_ON}. The archived hub-networking pattern module is
                never emitted, and the application landing zone pattern module is not called because
                it had no published release on that date: a landing zone is a subscription placement
                plus a spoke from the virtual network module instead.
              </p>
              <ul className="flex flex-col gap-1 text-sm">
                {Object.values(AVM_MODULES).map((mod) => (
                  <li key={mod.name} className="flex flex-wrap gap-x-2">
                    <a
                      href={mod.registry}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-primary underline decoration-dotted underline-offset-2"
                    >
                      {mod.source}
                    </a>
                    <span className="text-slate-600 dark:text-slate-400">
                      version {mod.version}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </>
  );
}

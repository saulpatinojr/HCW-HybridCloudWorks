import React from 'react';
import { Link } from 'react-router';
import { ArrowRight, Terminal, Layers, ShieldCheck, Cpu, DollarSign } from 'lucide-react';

/**
 * Flagship Interactive Workbench Showcase (Audit P1-2).
 * Promotes the Multi-Cloud Landing Zone Builder and Ephemeral Container Browser Labs
 * out of buried hover paragraphs and into high-contrast, interactive workbench cards
 * directly below the homepage Hero section.
 */
export default function WorkbenchShowcase() {
  return (
    <section
      aria-labelledby="workbench-showcase-heading"
      data-testid="workbench-showcase"
      className="relative w-full flex flex-col gap-6"
    >
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-slate-200/60 dark:border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2 mb-1.5">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" aria-hidden="true" />
            <span className="text-[11px] font-mono font-bold uppercase tracking-widest text-cyan-500 dark:text-cyan-400">
              Interactive Architecture Workbenches
            </span>
          </div>
          <h2
            id="workbench-showcase-heading"
            className="text-2xl sm:text-3xl font-display font-bold text-slate-900 dark:text-white"
          >
            Engineered Workbenches. Zero Local Setup.
          </h2>
        </div>
        <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 max-w-md">
          Design production topologies with verified Infrastructure-as-Code modules or troubleshoot
          enterprise environments in isolated browser container labs.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Card 1: Multi-Cloud Landing Zone Builder */}
        <div
          data-testid="workbench-card-landing-zone"
          className="group relative rounded-2xl glass-panel p-6 sm:p-7 border border-slate-200 dark:border-slate-800 hover:border-azure/70 dark:hover:border-azure/70 transition-all duration-300 hover:shadow-xl hover:shadow-azure/5 flex flex-col justify-between overflow-hidden"
        >
          {/* Subtle decorative glow */}
          <div
            className="pointer-events-none absolute -top-24 -right-24 w-64 h-64 rounded-full bg-azure/10 blur-3xl group-hover:bg-azure/20 transition-all duration-500"
            aria-hidden="true"
          />

          <div className="relative z-10 flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono font-bold uppercase tracking-wider bg-azure/10 text-azure border border-azure/30">
                <Layers className="w-3.5 h-3.5" aria-hidden="true" />
                Terraform AVM Generator
              </span>
              <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                L300 · Production-Ready
              </span>
            </div>

            <div>
              <h3 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white mb-2 group-hover:text-azure transition-colors">
                Multi-Cloud Landing Zone Builder
              </h3>
              <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                Assemble enterprise hub-and-spoke landing zones component by component. Generate
                Azure Verified Modules (AVM) Terraform code with live topology visualization and
                real-time FOCUS 1.4 monthly standing cost estimates.
              </p>
            </div>

            {/* Visual Topology Simulator Preview */}
            <div className="my-2 rounded-xl bg-slate-950/80 border border-slate-800 p-4 font-mono text-xs text-slate-300 flex flex-col gap-2.5 shadow-inner">
              <div className="flex items-center justify-between pb-2 border-b border-slate-800 text-[11px]">
                <span className="text-cyan-400 font-semibold flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                  Topology Canvas: Hub &amp; Spoke
                </span>
                <span className="text-slate-400 text-[10px] bg-slate-800/80 px-2 py-0.5 rounded">
                  Terraform 1.9+
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                <div className="p-2 rounded bg-slate-900/90 border border-azure/30">
                  <span className="text-azure font-bold block mb-0.5">Hub VNet (10.0.0.0/16)</span>
                  <span className="text-slate-400 text-[10px] block">
                    Azure Firewall · Gateway Subnet
                  </span>
                </div>
                <div className="p-2 rounded bg-slate-900/90 border border-emerald-500/30">
                  <span className="text-emerald-400 font-bold block mb-0.5">Spoke Workload</span>
                  <span className="text-slate-400 text-[10px] block">
                    Private Endpoints · App Fleet
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between pt-1 text-[11px] text-slate-400">
                <span className="flex items-center gap-1 text-purple-400">
                  <DollarSign className="w-3.5 h-3.5 text-purple-400" />
                  FOCUS 1.4 Floor: ~$482/mo
                </span>
                <span className="text-slate-500 text-[10px]">main.tf ready</span>
              </div>
            </div>

            {/* Feature Pills */}
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-600 dark:text-slate-400">
              <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700">
                AVM Validated
              </span>
              <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700">
                Live Diagram
              </span>
              <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700">
                FOCUS 1.4 Cost
              </span>
              <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700">
                1-Click Export
              </span>
            </div>
          </div>

          <div className="relative z-10 mt-6 pt-4 border-t border-slate-200/60 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <Link
              to="/tools/landing-zone"
              className="inline-flex items-center gap-2 rounded-xl bg-azure text-white px-5 py-2.5 text-xs font-semibold tracking-wide hover:opacity-90 transition-all shadow-md shadow-azure/20"
            >
              Launch Landing Zone Builder
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </Link>
            <Link
              to="/azure/architecture-designs"
              className="text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
            >
              Browse Blueprints →
            </Link>
          </div>
        </div>

        {/* Card 2: Ephemeral Container Browser Labs */}
        <div
          data-testid="workbench-card-labs"
          className="group relative rounded-2xl glass-panel p-6 sm:p-7 border border-slate-200 dark:border-slate-800 hover:border-emerald-500/70 dark:hover:border-emerald-500/70 transition-all duration-300 hover:shadow-xl hover:shadow-emerald-500/5 flex flex-col justify-between overflow-hidden"
        >
          {/* Subtle decorative glow */}
          <div
            className="pointer-events-none absolute -top-24 -right-24 w-64 h-64 rounded-full bg-emerald-500/10 blur-3xl group-hover:bg-emerald-500/20 transition-all duration-500"
            aria-hidden="true"
          />

          <div className="relative z-10 flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-mono font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 border border-emerald-500/30">
                <Terminal className="w-3.5 h-3.5" aria-hidden="true" />
                Browser Sandbox
              </span>
              <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                ~15 Min · Zero Local Setup
              </span>
            </div>

            <div>
              <h3 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white mb-2 group-hover:text-emerald-500 dark:group-hover:text-emerald-400 transition-colors">
                Ephemeral Container Browser Labs
              </h3>
              <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                Validate enterprise Terraform modules and lint Ansible playbooks directly in your
                browser. Each lab spins up an isolated VS Code container with pre-installed CLI
                toolchains and zero cloud credential requirements.
              </p>
            </div>

            {/* Visual Terminal Simulator Preview */}
            <div className="my-2 rounded-xl bg-slate-950/90 border border-slate-800 p-4 font-mono text-xs text-slate-300 flex flex-col gap-2 shadow-inner">
              <div className="flex items-center justify-between pb-2 border-b border-slate-800 text-[11px]">
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
                    <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                  </div>
                  <span className="text-slate-400 text-[11px]">hcw-lab:~/workspace</span>
                </div>
                <span className="text-emerald-400 text-[10px] flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Active Session
                </span>
              </div>

              <div className="flex flex-col gap-1 text-[11px] text-slate-300 leading-relaxed">
                <div>
                  <span className="text-emerald-400">$ </span>
                  <span className="text-slate-100">terraform init &amp;&amp; tflint --module</span>
                </div>
                <div className="text-slate-400 text-[10px] pl-3">
                  ✓ Initialized providers: azurerm, aws, google
                  <br />✓ Linting complete: 0 issues found (AVM policy passed)
                </div>
                <div>
                  <span className="text-emerald-400">$ </span>
                  <span className="text-slate-100">ansible-playbook --syntax-check site.yml</span>
                </div>
                <div className="text-emerald-400 text-[10px] pl-3">
                  playbook: site.yml [PASS - syntax verified]
                </div>
              </div>
            </div>

            {/* Feature Pills */}
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-600 dark:text-slate-400">
              <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 flex items-center gap-1">
                <Cpu className="w-3 h-3 text-cyan-500" />
                az, terraform, tflint
              </span>
              <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700 flex items-center gap-1">
                <ShieldCheck className="w-3 h-3 text-emerald-500" />
                read:user Only
              </span>
              <span className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700">
                Zero Cloud Bill
              </span>
            </div>
          </div>

          <div className="relative z-10 mt-6 pt-4 border-t border-slate-200/60 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <Link
              to="/education/labs"
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 text-white px-5 py-2.5 text-xs font-semibold tracking-wide hover:opacity-90 transition-all shadow-md shadow-emerald-600/20"
            >
              Launch Browser Labs
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </Link>
            <Link
              to="/education/labs"
              className="text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors"
            >
              View Lab Pre-Flight →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

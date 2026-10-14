import React from 'react';
import { ShieldCheck, Clock, Terminal, Laptop, Cpu, CheckCircle2 } from 'lucide-react';

/**
 * Pre-Flight Toolchain specifications.
 */
export const PREFLIGHT_TOOLS = Object.freeze([
  {
    name: 'Terraform 1.9+',
    cmd: 'terraform',
    role: 'IaC Synthesis & Plan Validation',
  },
  {
    name: 'tflint',
    cmd: 'tflint',
    role: 'AVM Rules & Security Linting',
  },
  {
    name: 'ansible-lint',
    cmd: 'ansible-lint',
    role: 'Playbook Syntax & Hardening',
  },
  {
    name: 'Docker',
    cmd: 'docker',
    role: 'Multi-Stage Container Runtime',
  },
  {
    name: 'Azure CLI',
    cmd: 'az',
    role: 'Enterprise Cloud Management',
  },
]);

/**
 * Hybrid Lab Pre-Flight Card (Audit P2-2).
 * Displays time commitment (~15 mins), pre-installed toolchains, terminal simulator
 * preview, and explicit read:user identity scope guarantees before launching a lab.
 *
 * @param {object} props
 * @param {boolean} [props.compact=false] When true, renders compact format for sign-in flows.
 * @param {string} [props.headingLevel='h2'] Heading tag level.
 */
export default function LabPreflightCard({ compact = false, headingLevel = 'h2' }) {
  const Heading = headingLevel;

  return (
    <section
      data-testid="lab-preflight-card"
      aria-labelledby="preflight-card-heading"
      className={`glass rounded-2xl p-6 sm:p-7 border border-slate-200 dark:border-slate-800 flex flex-col gap-5 ${
        compact ? 'max-w-2xl' : 'w-full'
      }`}
    >
      <div className="flex flex-col gap-1.5 border-b border-slate-200/60 dark:border-slate-800 pb-4">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-500 dark:text-emerald-400">
            Pre-Flight Verification
          </span>
        </div>
        <Heading
          id="preflight-card-heading"
          className="text-lg sm:text-xl font-bold text-slate-950 dark:text-white flex items-center gap-2"
        >
          Hybrid Lab Pre-Flight Briefing
        </Heading>
        <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300">
          Every lab launches an isolated, sandboxed container workspace in your browser. Review
          duration, toolchains, and security guarantees below.
        </p>
      </div>

      {/* Trust Pills Strip */}
      <div
        data-testid="lab-preflight-trust"
        className="flex flex-wrap items-center gap-2.5 py-1"
        aria-label="Pre-flight trust specifications"
      >
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">
          <Clock className="w-3.5 h-3.5 text-emerald-500" aria-hidden="true" />
          15-Min Scenarios
        </span>
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">
          <Terminal className="w-3.5 h-3.5 text-cyan-500" aria-hidden="true" />
          Browser Terminal
        </span>
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700">
          <Laptop className="w-3.5 h-3.5 text-purple-500" aria-hidden="true" />
          Zero Cloud Account Required
        </span>
      </div>

      {/* Pre-installed Toolchains */}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-mono font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
          <Cpu className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
          Pre-Installed Toolchain (hcw-lab Image)
        </span>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {PREFLIGHT_TOOLS.map((tool) => (
            <div
              key={tool.cmd}
              className="p-2.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 flex flex-col gap-1"
            >
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" aria-hidden="true" />
                <span className="text-xs font-mono font-bold text-slate-900 dark:text-white truncate">
                  {tool.cmd}
                </span>
              </div>
              <span className="text-[10px] text-slate-500 dark:text-slate-400 leading-tight">
                {tool.role}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Terminal Simulator Preview */}
      <div
        className="rounded-xl bg-slate-950 p-4 font-mono text-xs text-slate-300 border border-slate-800 shadow-inner flex flex-col gap-2"
        aria-label="Pre-flight terminal simulator preview"
      >
        <div className="flex items-center justify-between pb-2 border-b border-slate-800 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
            <span className="text-slate-400 ml-1">learner@hcw-lab:~/workspace</span>
          </div>
          <span className="text-emerald-400 text-[10px] bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
            SANDBOX READY
          </span>
        </div>
        <div className="flex flex-col gap-1 text-[11px] leading-relaxed">
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

      {/* Privacy and Security Disclosure */}
      <div
        data-testid="lab-privacy-assurance"
        className="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-slate-300 flex flex-col gap-1.5"
      >
        <span className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-primary" aria-hidden="true" />
          Privacy &amp; Security Disclosure
        </span>
        <span className="leading-relaxed">
          Sign-in checks public GitHub organization membership only (read:user scope). We never
          request repository access, personal emails, or cloud subscription credentials. Container
          workspaces run isolated and stop automatically after 60 minutes of inactivity.
        </span>
      </div>
    </section>
  );
}

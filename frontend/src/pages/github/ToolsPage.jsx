import React from 'react';
import { Helmet } from 'react-helmet-async';

/**
 * The top of a tool card: a coloured icon tile, the tool's name and one line
 * under it, and an optional status pill on the right.
 */
function ToolCardHeader({ iconBox, icon, titleHover, title, subtitle, badge }) {
  return (
    <div className="flex justify-between items-start mb-4">
      <div className="flex items-center gap-3">
        <div className={`p-2 rounded-lg ${iconBox}`}>
          <span className="material-symbols-outlined">{icon}</span>
        </div>
        <div>
          <h3 className={`text-lg font-bold ${titleHover} transition-colors`}>{title}</h3>
          <p className="text-xs text-gh-text-gray">{subtitle}</p>
        </div>
      </div>
      {badge && (
        <span
          className={`px-2 py-0.5 rounded-full ${badge.className} text-[10px] font-bold uppercase tracking-wider`}
        >
          {badge.label}
        </span>
      )}
    </div>
  );
}

export default function GitHubToolsPage() {
  return (
    <>
      <Helmet>
        <title>GitHub Developer Tools Suite - Hybrid Cloud Works</title>
      </Helmet>
      <main className="flex-1 pb-20 relative z-10">
        <section className="relative px-6 py-16 md:py-24 overflow-hidden border-b border-gh-border bg-gradient-to-b from-gh-black to-[hsl(var(--background))]">
          <div className="absolute inset-0 octo-mesh opacity-60 pointer-events-none"></div>
          <div className="max-w-6xl mx-auto text-center relative z-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gh-blue/10 border border-gh-blue/30 text-gh-blue text-[11px] font-bold mb-6 tracking-widest uppercase shadow-[0_0_10px_rgba(88,166,255,0.2)]">
              Hybrid Cloud Works • Utilities v2.1
            </div>
            <h1 className="text-3xl sm:text-5xl md:text-6xl font-black leading-tight tracking-tight mb-6 text-gradient">
              GitHub Developer
              <br /> Tools Suite
            </h1>
            <p className="max-w-2xl mx-auto text-gh-text-gray text-base sm:text-lg leading-relaxed mb-8">
              A centralized dashboard of interactive utilities for modern DevOps. Validate
              workflows, scan for secrets, and visualize dependencies in real-time.
            </p>
          </div>
        </section>
        <section className="px-6 py-12 max-w-7xl mx-auto">
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-xl font-bold flex items-center gap-2">
              <span className="material-symbols-outlined text-gh-blue">dashboard_customize</span>
              Available Tools
            </h3>
            <div className="flex gap-2">
              <button className="px-4 h-11 text-sm font-medium bg-gh-blue text-white rounded-md">
                All
              </button>
              <button className="px-4 h-11 text-sm font-medium text-gh-text-gray hover:text-white rounded-md hover:bg-gh-dark-dim transition-colors">
                Security
              </button>
              <button className="px-4 h-11 text-sm font-medium text-gh-text-gray hover:text-white rounded-md hover:bg-gh-dark-dim transition-colors">
                CI/CD
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 gap-6">
            <div className="tool-card group">
              <ToolCardHeader
                iconBox="bg-blue-500/10 border border-blue-500/20 text-blue-400"
                icon="rule"
                titleHover="group-hover:text-blue-400"
                title="Workflow Linter"
                subtitle="YAML Validation & Best Practices"
                badge={{
                  label: 'Active',
                  className: 'bg-green-900/30 text-green-400 border border-green-900/50',
                }}
              />
              <div className="mb-6 flex-grow">
                <div className="code-preview relative">
                  <div className="absolute top-2 right-2 flex gap-1">
                    <div className="w-2 h-2 rounded-full bg-red-500"></div>
                    <div className="w-2 h-2 rounded-full bg-yellow-500"></div>
                    <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  </div>
                  <div className="text-green-400">name:</div>{' '}
                  <span className="text-white">CI Build</span>
                  <br />
                  <div className="text-green-400">on:</div>{' '}
                  <span className="text-white">[push]</span>
                  <br />
                  <div className="text-green-400">jobs:</div>
                  <br />
                  <div className="text-purple-400">build:</div>
                  <br />
                  <div className="text-blue-400">runs-on:</div>{' '}
                  <span className="text-white">ubuntu-latest</span>
                  <div className="mt-2 text-xs text-gh-text-gray italic border-t border-gh-border pt-2 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px] text-green-500">
                      check_circle
                    </span>{' '}
                    Syntax Validated
                  </div>
                </div>
              </div>
              <div className="flex gap-3 mt-auto">
                <button className="flex-1 h-11 bg-gh-blue text-white rounded-md text-sm font-bold hover:bg-blue-600 transition-all shadow-lg shadow-blue-900/20">
                  Launch Tool
                </button>
                <button className="px-4 h-11 border border-gh-border text-gh-text-gray rounded-md text-sm font-medium hover:text-white hover:bg-gh-border transition-colors">
                  Documentation
                </button>
              </div>
            </div>
            <div className="tool-card group">
              <ToolCardHeader
                iconBox="bg-red-500/10 border border-red-500/20 text-red-400"
                icon="security"
                titleHover="group-hover:text-red-400"
                title="Secret Scanner"
                subtitle="Repo Leak Simulation"
                badge={{
                  label: 'Beta',
                  className: 'bg-gh-border text-gh-text-gray border border-gh-border',
                }}
              />
              <div className="mb-6 flex-grow relative overflow-hidden rounded-md border border-gh-border bg-black/40 p-4">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-32 border border-red-500/20 rounded-full flex items-center justify-center">
                  <div className="w-20 h-20 border border-red-500/40 rounded-full flex items-center justify-center">
                    <div className="w-2 h-2 bg-red-500 rounded-full shadow-[0_0_10px_red]"></div>
                  </div>
                </div>
                <div className="relative z-10 flex flex-col gap-2">
                  <div className="flex justify-between text-xs text-gh-text-gray">
                    <span>Scanning...</span>
                    <span>78%</span>
                  </div>
                  <div className="w-full bg-gh-border h-1.5 rounded-full overflow-hidden">
                    <div className="bg-red-500 h-full w-[78%]"></div>
                  </div>
                  <div className="mt-2 text-[10px] text-red-300 font-mono">
                    &gt; Potential AWS Key found in line 42...
                  </div>
                </div>
              </div>
              <div className="flex gap-3 mt-auto">
                <button className="flex-1 h-11 bg-gh-border hover:bg-gh-border/80 text-white rounded-md text-sm font-bold transition-all border border-gh-border">
                  Launch Simulator
                </button>
                <button className="px-4 h-11 border border-gh-border text-gh-text-gray rounded-md text-sm font-medium hover:text-white hover:bg-gh-border transition-colors">
                  Documentation
                </button>
              </div>
            </div>
            <div className="tool-card group">
              <ToolCardHeader
                iconBox="bg-purple-500/10 border border-purple-500/20 text-purple-400"
                icon="timer"
                titleHover="group-hover:text-purple-400"
                title="Action Runner Estimator"
                subtitle="Cost & Time Prediction"
              />
              <div className="mb-6 flex-grow grid grid-cols-2 gap-3">
                <div className="bg-gh-black/50 p-3 rounded border border-gh-border flex flex-col items-center justify-center text-center">
                  <span className="text-[10px] uppercase text-gh-text-gray tracking-wider mb-1">
                    Estimated Cost
                  </span>
                  <span className="text-2xl font-bold text-white">
                    $42.50
                    <span className="text-xs text-gh-text-gray font-normal">/mo</span>
                  </span>
                </div>
                <div className="bg-gh-black/50 p-3 rounded border border-gh-border flex flex-col items-center justify-center text-center">
                  <span className="text-[10px] uppercase text-gh-text-gray tracking-wider mb-1">
                    Build Time
                  </span>
                  <span className="text-2xl font-bold text-white">4m 12s</span>
                </div>
                <div className="col-span-2 bg-gh-black/30 p-2 rounded text-xs text-gh-text-gray text-center border border-dashed border-gh-border">
                  Based on 200 monthly commits &amp; 4 parallel jobs
                </div>
              </div>
              <div className="flex gap-3 mt-auto">
                <button className="flex-1 h-11 bg-gh-border hover:bg-gh-border/80 text-white rounded-md text-sm font-bold transition-all border border-gh-border">
                  Calculate
                </button>
                <button className="px-4 h-11 border border-gh-border text-gh-text-gray rounded-md text-sm font-medium hover:text-white hover:bg-gh-border transition-colors">
                  Documentation
                </button>
              </div>
            </div>
            <div className="tool-card group">
              <ToolCardHeader
                iconBox="bg-orange-500/10 border border-orange-500/20 text-orange-400"
                icon="hub"
                titleHover="group-hover:text-orange-400"
                title="Dependency Graph"
                subtitle="Interactive Node Visualizer"
              />
              <div className="mb-6 flex-grow relative h-32 bg-gh-black/50 rounded-md border border-gh-border overflow-hidden">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full p-4">
                  <div className="relative w-full h-full">
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-blue-500 border-2 border-white z-20"></div>
                    <div className="absolute top-[20%] left-[20%] w-4 h-4 rounded-full bg-gh-border border border-gh-text-gray z-10"></div>
                    <div className="absolute bottom-[30%] right-[20%] w-5 h-5 rounded-full bg-orange-500/50 border border-orange-400 z-10"></div>
                    <div className="absolute top-[40%] right-[10%] w-3 h-3 rounded-full bg-gh-border border border-gh-text-gray z-10"></div>
                    <div className="absolute top-1/2 left-1/2 w-24 h-[1px] bg-gh-border -translate-y-1/2 -translate-x-full origin-right rotate-45"></div>
                    <div className="absolute top-1/2 left-1/2 w-16 h-[1px] bg-gh-border -translate-y-1/2 origin-left rotate-12"></div>
                  </div>
                </div>
              </div>
              <div className="flex gap-3 mt-auto">
                <button className="flex-1 h-11 bg-gh-border hover:bg-gh-border/80 text-white rounded-md text-sm font-bold transition-all border border-gh-border">
                  Visualize Repo
                </button>
                <button className="px-4 h-11 border border-gh-border text-gh-text-gray rounded-md text-sm font-medium hover:text-white hover:bg-gh-border transition-colors">
                  Documentation
                </button>
              </div>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}

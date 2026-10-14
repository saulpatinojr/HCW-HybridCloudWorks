import React from 'react';
import { Link } from 'react-router';
import { Helmet } from 'react-helmet-async';
import { routes } from '@/lib/routeFactory';

export default function ToolsPage() {
  return (
    <>
      <Helmet>
        <title>FinOps Technical Tools Suite - Hybrid Cloud Works</title>
      </Helmet>
      <main className="flex-1 pb-20 relative">
        <div className="absolute inset-0 tech-grid pointer-events-none opacity-50"></div>
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-primary/10 rounded-full blur-[100px] pointer-events-none"></div>
        <div className="max-w-7xl mx-auto px-6 pt-12">
          <div className="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-bold mb-4 tracking-wider uppercase shadow-glow">
                <span className="material-symbols-outlined text-[14px]">science</span>
                Beta Utilities Available
              </div>
              <h1 className="text-3xl sm:text-5xl md:text-5xl font-black text-slate-900 dark:text-white tracking-tight mb-3">
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-finops-primary via-slate-900 to-finops-primary dark:via-white">
                  Technical Tools Suite
                </span>
              </h1>
              <p className="text-slate-400 max-w-2xl text-base sm:text-lg">
                Backend-powered utilities for cloud cost analysis, anomaly detection, and FOCUS
                schema standardization.
              </p>
            </div>
            <div className="flex gap-3">
              <button className="px-4 h-11 bg-primary text-primary-foreground text-sm font-semibold rounded-lg border border-slate-700 hover:border-primary/50 transition-colors flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px]">history</span> Request
                History
              </button>
              <button className="px-4 h-11 bg-primary text-primary-foreground text-sm font-bold rounded-lg shadow-glow hover:bg-emerald-300 transition-colors flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px]">add</span> New Project
              </button>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="glass-panel rounded-2xl p-1 relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-50 group-hover:opacity-100 transition-opacity">
                <span className="material-symbols-outlined text-slate-500 text-[48px] group-hover:text-primary/20">
                  rule
                </span>
              </div>
              <div className="bg-slate-900/50 rounded-xl p-6 h-full flex flex-col">
                <div className="flex justify-between items-start mb-4">
                  <div className="p-3 bg-indigo-500/10 rounded-lg border border-indigo-500/20 text-indigo-400">
                    <span className="material-symbols-outlined text-[28px]">fact_check</span>
                  </div>
                  <div className="px-2 py-1 bg-primary/10 rounded text-[10px] font-mono text-foreground border border-slate-700 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span> Cloud Functions
                  </div>
                </div>
                <h3 className="text-lg sm:text-xl font-bold text-white mb-2 group-hover:text-primary transition-colors">
                  FOCUS 1.4 Schema Validator
                </h3>
                <p className="text-slate-400 text-sm mb-6 flex-1">
                  Validate your billing data against the FinOps Open Cost &amp; Usage Specification
                  (FOCUS) 1.4 schema. Detects type mismatches and missing mandatory columns.
                </p>
                <div className="bg-black/30 rounded-lg p-3 mb-6 font-mono text-xs text-foreground border border-slate-800">
                  <div className="flex justify-between mb-1">
                    <span>Last run: 2m ago</span>
                    <span className="text-green-500">Success (98.5%)</span>
                  </div>
                  <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-indigo-500 h-full w-[98%]"></div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button className="flex items-center justify-center gap-2 h-11 rounded-lg bg-primary hover:bg-primary-dark text-primary-foreground font-bold text-sm transition-all">
                    <span className="material-symbols-outlined text-[18px]">rocket_launch</span>{' '}
                    Launch Tool
                  </button>
                  <button className="flex items-center justify-center gap-2 h-11 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-sm transition-all border border-slate-700">
                    <span className="material-symbols-outlined text-[18px]">api</span> API Docs
                  </button>
                </div>
              </div>
            </div>
            <div className="glass-panel rounded-2xl p-1 relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-50 group-hover:opacity-100 transition-opacity">
                <span className="material-symbols-outlined text-slate-500 text-[48px] group-hover:text-primary/20">
                  pest_control
                </span>
              </div>
              <div className="bg-slate-900/50 rounded-xl p-6 h-full flex flex-col">
                <div className="flex justify-between items-start mb-4">
                  <div className="p-3 bg-rose-500/10 rounded-lg border border-rose-500/20 text-rose-400">
                    <span className="material-symbols-outlined text-[28px]">search_off</span>
                  </div>
                  <div className="px-2 py-1 bg-primary/10 rounded text-[10px] font-mono text-foreground border border-slate-700 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500"></span> K8s Microservice
                  </div>
                </div>
                <h3 className="text-lg sm:text-xl font-bold text-white mb-2 group-hover:text-primary transition-colors">
                  Zombie Resource Hunter
                </h3>
                <p className="text-slate-400 text-sm mb-6 flex-1">
                  Scan your connected cloud accounts for detached volumes, unassociated IPs, and
                  idle load balancers. Generates immediate remediation scripts.
                </p>
                <div className="bg-black/30 rounded-lg p-3 mb-6 font-mono text-xs text-foreground border border-slate-800">
                  <div className="flex justify-between mb-1">
                    <span>Resources Scanned</span>
                    <span className="text-rose-400">12 Idle Found</span>
                  </div>
                  <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-rose-500 h-full w-[35%]"></div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button className="flex items-center justify-center gap-2 h-11 rounded-lg bg-primary hover:bg-primary-dark text-primary-foreground font-bold text-sm transition-all">
                    <span className="material-symbols-outlined text-[18px]">rocket_launch</span>{' '}
                    Launch Tool
                  </button>
                  <button className="flex items-center justify-center gap-2 h-11 rounded-lg bg-primary text-primary-foreground hover:bg-primary-dark font-semibold text-sm transition-all border border-slate-700">
                    <span className="material-symbols-outlined text-[18px]">api</span> API Docs
                  </button>
                </div>
              </div>
            </div>
            <div className="glass-panel rounded-2xl p-1 relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-50 group-hover:opacity-100 transition-opacity">
                <span className="material-symbols-outlined text-slate-500 text-[48px] group-hover:text-primary/20">
                  calculate
                </span>
              </div>
              <div className="bg-slate-900/50 rounded-xl p-6 h-full flex flex-col">
                <div className="flex justify-between items-start mb-4">
                  <div className="p-3 bg-amber-500/10 rounded-lg border border-amber-500/20 text-amber-400">
                    <span className="material-symbols-outlined text-[28px]">show_chart</span>
                  </div>
                  <div className="px-2 py-1 bg-primary/10 rounded text-[10px] font-mono text-foreground border border-slate-700 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-purple-500"></span> PySpark Job
                  </div>
                </div>
                <h3 className="text-lg sm:text-xl font-bold text-white mb-2 group-hover:text-primary transition-colors">
                  Unit Economics Simulator
                </h3>
                <p className="text-slate-400 text-sm mb-6 flex-1">
                  Model future costs based on business metrics (e.g., cost per transaction, cost per
                  active user). Adjust sliders to simulate scaling scenarios.
                </p>
                <div className="bg-black/30 rounded-lg p-3 mb-6 font-mono text-xs text-foreground border border-slate-800">
                  <div className="flex justify-between mb-1">
                    <span>Simulation Accuracy</span>
                    <span className="text-amber-400">+/- 5% Variance</span>
                  </div>
                  <div className="flex gap-1 h-1.5 mt-2">
                    <div className="bg-slate-700 w-1/4 rounded-full"></div>
                    <div className="bg-slate-700 w-1/4 rounded-full"></div>
                    <div className="bg-amber-500 w-1/4 rounded-full"></div>
                    <div className="bg-slate-700 w-1/4 rounded-full"></div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button className="flex items-center justify-center gap-2 h-11 rounded-lg bg-primary hover:bg-primary-dark text-primary-foreground font-bold text-sm transition-all">
                    <span className="material-symbols-outlined text-[18px]">rocket_launch</span>{' '}
                    Launch Tool
                  </button>
                  <button className="flex items-center justify-center gap-2 h-11 rounded-lg bg-primary text-primary-foreground hover:bg-primary-dark font-semibold text-sm transition-all border border-slate-700">
                    <span className="material-symbols-outlined text-[18px]">api</span> API Docs
                  </button>
                </div>
              </div>
            </div>
            <div className="glass-panel rounded-2xl p-1 relative overflow-hidden group">
              <div className="absolute top-0 right-0 p-4 opacity-50 group-hover:opacity-100 transition-opacity">
                <span className="material-symbols-outlined text-slate-500 text-[48px] group-hover:text-primary/20">
                  receipt_long
                </span>
              </div>
              <div className="bg-slate-900/50 rounded-xl p-6 h-full flex flex-col">
                <div className="flex justify-between items-start mb-4">
                  <div className="p-3 bg-sky-500/10 rounded-lg border border-sky-500/20 text-sky-400">
                    <span className="material-symbols-outlined text-[28px]">translate</span>
                  </div>
                  <div className="px-2 py-1 bg-primary/10 rounded text-[10px] font-mono text-foreground border border-slate-700 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-orange-500"></span> AI Inference
                  </div>
                </div>
                <h3 className="text-xl font-bold text-white mb-2 group-hover:text-primary transition-colors">
                  Cloud Bill Decoder
                </h3>
                <p className="text-slate-400 text-sm mb-6 flex-1">
                  Upload complex CSV export files (CUR/Billing Export) and get a natural language
                  explanation of cost drivers, support charges, and mysterious SKUs.
                </p>
                <div className="bg-black/30 rounded-lg p-3 mb-6 font-mono text-xs text-foreground border border-slate-800">
                  <div className="flex justify-between mb-1">
                    <span>Processing Speed</span>
                    <span className="text-sky-400">~150MB/s</span>
                  </div>
                  <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
                    <div className="bg-sky-500 h-full w-[80%] animate-pulse"></div>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button className="flex items-center justify-center gap-2 py-2.5 rounded-lg bg-primary hover:bg-primary-dark text-primary-foreground font-bold text-sm transition-all">
                    <span className="material-symbols-outlined text-[18px]">rocket_launch</span>{' '}
                    Launch Tool
                  </button>
                  <button className="flex items-center justify-center gap-2 py-2.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary-dark font-semibold text-sm transition-all border border-slate-700">
                    <span className="material-symbols-outlined text-[18px]">api</span> API Docs
                  </button>
                </div>
              </div>
            </div>
          </div>
          <div className="mt-12 mb-12 p-6 rounded-2xl border border-slate-800 bg-slate-900/30">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold flex items-center gap-2">
                <span className="material-symbols-outlined text-slate-400">monitoring</span>
                Your API Usage
              </h3>
              <Link
                className="text-sm text-primary hover:text-emerald-300 transition-colors"
                to={routes.tools('finops')}
              >
                View Full Report &rarr;
              </Link>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div className="p-4 rounded-xl bg-slate-950/50 border border-slate-800">
                <div className="text-slate-500 text-xs font-mono mb-1">CALLS THIS MONTH</div>
                <div className="text-2xl font-bold text-white">45,231</div>
              </div>
              <div className="p-4 rounded-xl bg-slate-950/50 border border-slate-800">
                <div className="text-slate-500 text-xs font-mono mb-1">ERROR RATE</div>
                <div className="text-2xl font-bold text-emerald-400">0.02%</div>
              </div>
              <div className="p-4 rounded-xl bg-slate-950/50 border border-slate-800">
                <div className="text-slate-500 text-xs font-mono mb-1">AVG LATENCY</div>
                <div className="text-2xl font-bold text-white">124ms</div>
              </div>
              <div className="p-4 rounded-xl bg-slate-950/50 border border-slate-800">
                <div className="text-slate-500 text-xs font-mono mb-1">NEXT INVOICE</div>
                <div className="text-2xl font-bold text-white">$0.00</div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}

import React from 'react';
import { Helmet } from 'react-helmet-async';
import { routes } from '@/lib/routeFactory';

/** The three one-step workflow snippets under the featured card. */
const SNIPPETS = [
  {
    color: 'text-purple-400',
    icon: 'security',
    kind: 'Security',
    title: 'Trivy Container Scan',
    text: 'Vulnerability scanning for container images before pushing to registry.',
    uses: 'aquasecurity/trivy-action@0.16.1',
    block: 'with:',
    key: 'image-ref:',
    value: "'my-app:${{ github.sha }}'",
  },
  {
    color: 'text-orange-400',
    icon: 'rocket_launch',
    kind: 'CD / Release',
    title: 'Auto Semantic Release',
    text: 'Automated versioning and changelog generation based on conventional commits.',
    uses: 'cycjimmy/semantic-release-action@v4',
    block: 'env:',
    key: 'GITHUB_TOKEN:',
    value: '${{ secrets.GITHUB_TOKEN }}',
  },
  {
    color: 'text-green-400',
    icon: 'smart_toy',
    kind: 'Automation',
    title: 'Stale Issue Closer',
    text: 'Automatically identify and close stale issues and PRs to keep backlog clean.',
    uses: 'actions/stale@v9',
    block: 'with:',
    key: 'days-before-stale:',
    value: '30',
  },
];

/** One snippet: its kind, title and purpose, the YAML lines and a copy button. */
function SnippetCard({ snippet }) {
  return (
    <div className="bento-card col-span-1">
      <div className={`flex items-center gap-2 mb-3 ${snippet.color}`}>
        <span className="material-symbols-outlined text-[24px]">{snippet.icon}</span>
        <span className="font-bold uppercase tracking-widest text-xs">{snippet.kind}</span>
      </div>
      <h3 className="text-lg font-bold mb-2">{snippet.title}</h3>
      <p className="text-xs text-gh-text-gray mb-4">{snippet.text}</p>
      <div className="bg-gh-code-bg border border-gh-border rounded p-2 mb-4">
        <pre className="font-mono text-[10px] text-gh-text-gray overflow-hidden whitespace-nowrap">
          <code>
            <span className="token-key">uses:</span>{' '}
            <span className="token-val">{snippet.uses}</span>
            <span className="token-key">{snippet.block}</span>
            <span className="token-key">{snippet.key}</span>{' '}
            <span className="token-val">{snippet.value}</span>
          </code>
        </pre>
      </div>
      <button className="w-full py-1.5 bg-gh-border/50 hover:bg-gh-border text-white rounded text-xs font-bold transition-colors">
        Copy YAML
      </button>
    </div>
  );
}

export default function GitHubWorkflowsPage() {
  return (
    <>
      <Helmet>
        <title>GitHub Actions Catalog Hub - Hybrid Cloud Works</title>
      </Helmet>
      <main className="flex-1 pb-20">
        <section className="relative px-6 py-16 overflow-hidden bg-gh-black border-b border-gh-border">
          <div className="absolute inset-0 octo-mesh opacity-40 pointer-events-none"></div>
          <div className="max-w-6xl mx-auto text-center relative z-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-gh-border/30 border border-gh-border text-gh-text-gray text-[11px] font-bold mb-6 tracking-widest uppercase">
              Hybrid Cloud Works • Internal Catalog
            </div>
            <h1 className="text-3xl sm:text-5xl md:text-6xl font-black leading-tight tracking-tight mb-6 text-gradient">
              GitHub Actions <br /> Workflow Catalog
            </h1>
            <p className="max-w-2xl mx-auto text-gh-text-gray text-base sm:text-lg leading-relaxed mb-8">
              A centralized repository of proven CI/CD patterns, security scans, and automation
              workflows. Copy, paste, and ship faster.
            </p>
          </div>
        </section>
        <section className="px-6 py-12 max-w-[1400px] mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-6">
            <div className="hidden lg:flex flex-col gap-4 col-span-1">
              <div className="bento-card h-full !p-0 overflow-hidden">
                <div className="p-4 border-b border-gh-border bg-gh-dark">
                  <h3 className="font-bold text-sm flex items-center gap-2">
                    <span className="material-symbols-outlined text-gh-blue text-[18px]">
                      category
                    </span>{' '}
                    Categories
                  </h3>
                </div>
                <div className="p-2 space-y-1">
                  <button className="w-full text-left px-3 h-11 rounded-md bg-gh-blue/10 text-gh-blue text-sm font-medium flex items-center justify-between">
                    All Workflows <span className="text-xs opacity-70">24</span>
                  </button>
                  <button className="w-full text-left px-3 h-11 rounded-md hover:bg-gh-border/30 text-gh-text-gray hover:text-white transition-colors text-sm font-medium flex items-center justify-between">
                    CI Pipelines <span className="text-xs opacity-70">12</span>
                  </button>
                  <button className="w-full text-left px-3 h-11 rounded-md hover:bg-gh-border/30 text-gh-text-gray hover:text-white transition-colors text-sm font-medium flex items-center justify-between">
                    CD &amp; Releases <span className="text-xs opacity-70">8</span>
                  </button>
                  <button className="w-full text-left px-3 h-11 rounded-md hover:bg-gh-border/30 text-gh-text-gray hover:text-white transition-colors text-sm font-medium flex items-center justify-between">
                    Security <span className="text-xs opacity-70">4</span>
                  </button>
                  <button className="w-full text-left px-3 h-11 rounded-md hover:bg-gh-border/30 text-gh-text-gray hover:text-white transition-colors text-sm font-medium flex items-center justify-between">
                    Automation <span className="text-xs opacity-70">6</span>
                  </button>
                </div>
              </div>
              <div className="bento-card !bg-gradient-to-br from-gh-card to-gh-black border-l-4 !border-l-yellow-500">
                <div className="flex items-center gap-2 text-yellow-500 mb-2">
                  <span className="material-symbols-outlined text-[20px]">lightbulb</span>
                  <span className="font-bold uppercase tracking-widest text-[10px]">
                    DevOps Security Tip
                  </span>
                </div>
                <p className="text-sm text-white font-medium mb-2">Pin Your Actions</p>
                <p className="text-xs text-gh-text-gray leading-relaxed">
                  Always reference actions by commit SHA instead of tags (e.g.{' '}
                  <code className="bg-gh-border/50 px-1 rounded text-white">@v1</code>) to prevent
                  supply chain attacks from mutable refs.
                </p>
              </div>
            </div>
            <div className="col-span-1 md:col-span-3 lg:col-span-3 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <div className="bento-card col-span-1 md:col-span-2 lg:col-span-2 group">
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center gap-2">
                    <span className="w-8 h-8 rounded-md bg-blue-500/20 flex items-center justify-center text-blue-400">
                      <span className="material-symbols-outlined text-[20px]">build</span>
                    </span>
                    <div>
                      <h3 className="text-lg font-bold ">Node.js CI Matrix</h3>
                      <span className="text-xs text-gh-text-gray">CI • Testing</span>
                    </div>
                  </div>
                  <span className="px-2 py-0.5 rounded-full border border-green-500/30 bg-green-500/10 text-green-400 text-[10px] font-bold uppercase">
                    Verified
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 h-full">
                  <div className="flex flex-col justify-between">
                    <div>
                      <h4 className="text-xs font-bold text-gh-text-gray uppercase tracking-wider mb-2">
                        Why use this?
                      </h4>
                      <p className="text-sm text-gray-300 leading-relaxed mb-4">
                        Standardized parallel testing across multiple Node.js versions (16, 18, 20)
                        and OS environments. Includes caching for npm modules to speed up builds.
                      </p>
                      <div className="flex flex-wrap gap-2 mb-4">
                        <span className="text-[10px] px-2 py-1 rounded bg-gh-border text-gh-text-gray">
                          npm
                        </span>
                        <span className="text-[10px] px-2 py-1 rounded bg-gh-border text-gh-text-gray">
                          matrix
                        </span>
                        <span className="text-[10px] px-2 py-1 rounded bg-gh-border text-gh-text-gray">
                          caching
                        </span>
                      </div>
                    </div>
                    <button className="mt-auto w-full h-11 bg-gh-dark border border-gh-border hover:border-gh-blue hover:text-gh-blue text-white rounded-md text-sm font-bold transition-all flex items-center justify-center gap-2">
                      <span className="material-symbols-outlined text-[16px]">content_copy</span>{' '}
                      Copy YAML
                    </button>
                  </div>
                  <div className="bg-gh-code-bg border border-gh-border rounded-lg p-3 overflow-hidden relative group-hover:border-gh-blue/30 transition-colors">
                    <pre className="font-mono text-[11px] leading-5 overflow-x-auto">
                      <code>
                        <span className="token-key">name:</span>{' '}
                        <span className="token-val">Node CI</span>
                        <span className="token-key">on:</span>{' '}
                        <span className="token-val">[push]</span>
                        <span className="token-key">jobs:</span>
                        <span className="token-key">build:</span>
                        <span className="token-key">runs-on:</span>{' '}
                        <span className="token-val">ubuntu-latest</span>
                        <span className="token-key">strategy:</span>
                        <span className="token-key">matrix:</span>
                        <span className="token-key">node:</span>{' '}
                        <span className="token-val">[16, 18, 20]</span>
                        <span className="token-key">steps:</span>
                        <span className="token-comment"># Check out code</span>-{' '}
                        <span className="token-key">uses:</span>{' '}
                        <span className="token-val">actions/checkout@v4</span>-{' '}
                        <span className="token-key">uses:</span>{' '}
                        <span className="token-val">actions/setup-node@v4</span>
                      </code>
                    </pre>
                    <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-gh-code-bg to-transparent"></div>
                  </div>
                </div>
              </div>
              <div className="bento-card col-span-1 row-span-1">
                <div className="flex items-center justify-between mb-4 border-b border-gh-border pb-2">
                  <h3 className="text-sm font-bold flex items-center gap-2">
                    <span className="material-symbols-outlined text-gh-blue text-[18px]">
                      rss_feed
                    </span>{' '}
                    Latest Updates
                  </h3>
                  <a
                    className="inline-flex items-center h-8 px-2 text-xs text-gh-blue hover:underline"
                    href={routes.rss('github')}
                  >
                    View All
                  </a>
                </div>
                <ul className="space-y-3">
                  <li className="group/item">
                    <div className="flex justify-between items-start">
                      <h4 className="text-xs font-medium group-hover/item:text-gh-blue transition-colors cursor-pointer">
                        actions/checkout v4.1.2
                      </h4>
                      <span className="text-[10px] text-gh-text-gray">2h ago</span>
                    </div>
                    <p className="text-[11px] text-gh-text-gray mt-0.5">
                      Performance improvements for sparse checkouts.
                    </p>
                  </li>
                  <li className="group/item">
                    <div className="flex justify-between items-start">
                      <h4 className="text-xs font-medium group-hover/item:text-gh-blue transition-colors cursor-pointer">
                        docker/build-push v5.3
                      </h4>
                      <span className="text-[10px] text-gh-text-gray">1d ago</span>
                    </div>
                    <p className="text-[11px] text-gh-text-gray mt-0.5">
                      Added provenance generation support.
                    </p>
                  </li>
                  <li className="group/item">
                    <div className="flex justify-between items-start">
                      <h4 className="text-xs font-medium group-hover/item:text-gh-blue transition-colors cursor-pointer">
                        aws-actions/configure v4
                      </h4>
                      <span className="text-[10px] text-gh-text-gray">2d ago</span>
                    </div>
                    <p className="text-[11px] text-gh-text-gray mt-0.5">Node 20 runtime update.</p>
                  </li>
                </ul>
              </div>
              {SNIPPETS.map((snippet) => (
                <SnippetCard key={snippet.title} snippet={snippet} />
              ))}
              <div className="bento-card md:col-span-2 lg:col-span-3 flex flex-row items-center justify-between gap-6">
                <div>
                  <div className="flex items-center gap-2 text-gh-blue mb-2">
                    <span className="material-symbols-outlined text-[20px]">architecture</span>
                    <span className="font-bold uppercase tracking-widest text-[11px]">
                      Related Architecture
                    </span>
                  </div>
                  <h3 className="text-xl font-bold mb-2">Need a full architecture?</h3>
                  <p className="text-sm text-gh-text-gray max-w-xl">
                    Check out the Architecture Blueprints for complete reference implementations
                    combining Terraform, Kubernetes manifests, and these GitHub Actions.
                  </p>
                </div>
                <div className="flex gap-3">
                  <a
                    className="flex flex-col items-center justify-center w-24 h-20 bg-gh-black border border-gh-border rounded-lg hover:border-gh-blue hover:bg-gh-dark transition-all group cursor-pointer"
                    href={routes.landing('aws')}
                  >
                    <span className="material-symbols-outlined text-gh-text-gray group-hover:text-white mb-1">
                      cloud
                    </span>
                    <span className="text-[10px] font-bold text-gh-text-gray group-hover:text-white">
                      AWS EKS
                    </span>
                  </a>
                  <a
                    className="flex flex-col items-center justify-center w-24 h-20 bg-gh-black border border-gh-border rounded-lg hover:border-gh-blue hover:bg-gh-dark transition-all group cursor-pointer"
                    href={routes.landing('azure')}
                  >
                    <span className="material-symbols-outlined text-gh-text-gray group-hover:text-white mb-1">
                      dns
                    </span>
                    <span className="text-[10px] font-bold text-gh-text-gray group-hover:text-white">
                      Azure
                    </span>
                  </a>
                  <a
                    className="flex flex-col items-center justify-center w-24 h-20 bg-gh-black border border-gh-border rounded-lg hover:border-gh-blue hover:bg-gh-dark transition-all group cursor-pointer"
                    href={routes.landing('gcp')}
                  >
                    <span className="material-symbols-outlined text-gh-text-gray group-hover:text-white mb-1">
                      deployed_code
                    </span>
                    <span className="text-[10px] font-bold text-gh-text-gray group-hover:text-white">
                      GCP Cloud Run
                    </span>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}

/**
 * ServiceDocsPage — /admin/ai-engine/docs/:serviceId
 *
 * Displays validated setup documentation for every AI provider and MCP server
 * in the AI Engine. Content lives in src/data/serviceDocsData.js.
 *
 * Page sections (in order):
 *   1. Breadcrumb + hero
 *   2. Requirements
 *   3. HCW Uses (matrix)
 *   4. Install
 *   5. Use
 *   6. Uninstall
 *   7. Advanced
 *   8. References
 */

import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import {
  ArrowLeft,
  CheckCircle,
  ExternalLink,
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Bot,
  Server,
  AlertTriangle,
} from 'lucide-react';
import SERVICE_DOCS from '@/data/serviceDocsData';

// ─── Code Block ───────────────────────────────────────────────────────────────

function CodeBlock({ lang = 'bash', label, content }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // HTML-escape raw code BEFORE highlighting so dangerouslySetInnerHTML only
  // ever renders our own <span> wrappers, never markup from the doc content.
  const escapeHtml = (str) =>
    str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  // Simple token-based syntax highlighting (regexes match the escaped entities)
  const highlight = (rawCode, language) => {
    const code = escapeHtml(rawCode);
    if (language === 'json') {
      return code
        .replace(/(&quot;(?:\\.|(?!&quot;).)*?&quot;(\s*:)?)/g, (match) => {
          if (/:$/.test(match)) return `<span class="text-sky-300">${match}</span>`;
          return `<span class="text-amber-300">${match}</span>`;
        })
        .replace(/\b(true|false|null)\b/g, '<span class="text-violet-300">$1</span>')
        .replace(/\b(-?\d+\.?\d*)\b/g, '<span class="text-emerald-300">$1</span>');
    }
    if (language === 'bash') {
      return code
        .replace(/(#.*)$/gm, '<span class="text-slate-500 italic">$1</span>')
        .replace(
          /\b(npm|npx|node|az|openssl|plaud|rm|cat|mkdir)\b/g,
          '<span class="text-sky-300">$1</span>'
        );
    }
    if (language === 'js') {
      return code
        .replace(/(\/\/.*)$/gm, '<span class="text-slate-500 italic">$1</span>')
        .replace(/(&#39;.*?&#39;|&quot;.*?&quot;)/g, '<span class="text-amber-300">$1</span>')
        .replace(
          /\b(const|let|var|async|await|return|function|import|require|from|export)\b/g,
          '<span class="text-violet-300">$1</span>'
        )
        .replace(/\b(true|false|null|undefined)\b/g, '<span class="text-sky-300">$1</span>');
    }
    return code;
  };

  const highlighted = highlight(content, lang);

  return (
    <div className="rounded-lg overflow-hidden border border-slate-700 my-3">
      <div className="flex items-center justify-between px-3 py-1.5 bg-slate-800 border-b border-slate-700">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-slate-400 uppercase tracking-wide">{lang}</span>
          {label && <span className="text-xs text-slate-500">— {label}</span>}
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors px-1.5 py-0.5 rounded hover:bg-slate-700"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="p-4 overflow-x-auto text-xs leading-relaxed bg-slate-900 text-slate-200">
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

// ─── Section component ────────────────────────────────────────────────────────

function DocSection({ id, title, icon: Icon, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section
      id={id}
      className="border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden"
    >
      <button
        className="w-full flex items-center justify-between px-5 py-4 bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        onClick={() => setOpen((p) => !p)}
        aria-expanded={open}
      >
        <div className="flex items-center gap-2.5">
          {Icon && <Icon className="h-4 w-4 text-indigo-500" />}
          <span className="font-semibold text-sm">{title}</span>
        </div>
        {open ? (
          <ChevronDown className="h-4 w-4 text-slate-400" />
        ) : (
          <ChevronRight className="h-4 w-4 text-slate-400" />
        )}
      </button>
      {open && <div className="px-5 py-5 space-y-6 bg-white dark:bg-slate-900">{children}</div>}
    </section>
  );
}

// ─── Step renderer ────────────────────────────────────────────────────────────

function DocStep({ step }) {
  return (
    <div className="space-y-1">
      {step.heading && (
        <h4 className="font-semibold text-sm text-slate-800 dark:text-slate-100">{step.heading}</h4>
      )}
      {step.body && (
        <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">{step.body}</p>
      )}
      {step.codes?.map((c, i) => (
        <CodeBlock key={i} lang={c.lang} label={c.label} content={c.content} />
      ))}
    </div>
  );
}

// ─── HCW Uses matrix ─────────────────────────────────────────────────────────

const STATUS_STYLE = {
  active: {
    label: 'Active',
    cls: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400',
  },
  available: {
    label: 'Available',
    cls: 'bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400',
  },
  planned: {
    label: 'Planned',
    cls: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400',
  },
};

function UsesMatrix({ uses }) {
  if (!uses?.length)
    return <p className="text-sm text-slate-400 italic">No HCW uses documented yet.</p>;

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
            <th className="text-left px-4 py-2.5 font-semibold text-slate-600 dark:text-slate-300">
              HCW Feature
            </th>
            <th className="text-left px-4 py-2.5 font-semibold text-slate-600 dark:text-slate-300">
              How It&apos;s Used
            </th>
            <th className="text-left px-4 py-2.5 font-semibold text-slate-600 dark:text-slate-300 hidden sm:table-cell">
              Files
            </th>
            <th className="text-left px-4 py-2.5 font-semibold text-slate-600 dark:text-slate-300">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {uses.map((row, i) => {
            const s = STATUS_STYLE[row.status] || STATUS_STYLE.available;
            return (
              <tr
                key={i}
                className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors"
              >
                <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-100 align-top">
                  {row.feature}
                </td>
                <td className="px-4 py-3 text-slate-600 dark:text-slate-300 align-top leading-relaxed">
                  {row.usage}
                </td>
                <td className="px-4 py-3 text-slate-400 align-top hidden sm:table-cell">
                  {row.files?.map((f, fi) => (
                    <div key={fi} className="font-mono text-slate-500 dark:text-slate-400">
                      {f}
                    </div>
                  ))}
                </td>
                <td className="px-4 py-3 align-top">
                  <span
                    className={`text-xs font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${s.cls}`}
                  >
                    {s.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Requirements list ────────────────────────────────────────────────────────

function RequirementsList({ requirements }) {
  if (!requirements?.length) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
      {requirements.map((req, i) => (
        <div
          key={i}
          className={`flex items-start gap-2.5 p-3 rounded-lg border ${
            req.required
              ? 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900'
              : 'border-dashed border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-800/30'
          }`}
        >
          {req.required ? (
            <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
          ) : (
            <span className="h-4 w-4 rounded-full border-2 border-slate-300 dark:border-slate-600 shrink-0 mt-0.5" />
          )}
          <div>
            <span className="font-semibold text-sm text-slate-800 dark:text-slate-100">
              {req.label}
            </span>
            {req.required && (
              <span className="ml-1.5 text-xs text-red-500 font-medium">required</span>
            )}
            {!req.required && <span className="ml-1.5 text-xs text-slate-400">optional</span>}
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{req.detail}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── In-page nav ─────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { id: 'requirements', label: 'Requirements' },
  { id: 'hcw-uses', label: 'HCW Uses' },
  { id: 'install', label: 'Install' },
  { id: 'use', label: 'Use' },
  { id: 'uninstall', label: 'Uninstall' },
  { id: 'advanced', label: 'Advanced' },
  { id: 'references', label: 'References' },
];

/**
 * A section made of numbered steps (install, use, uninstall, advanced), or
 * null when the document has no steps for it. `fallbackTitle` is used when
 * the section names no title of its own.
 */
function buildStepsSection(doc, id, fallbackTitle, defaultOpen) {
  const section = doc.sections?.[id];
  if (!section?.steps?.length) return null;
  return {
    id,
    title: section.title || fallbackTitle,
    defaultOpen,
    content: (
      <div className="space-y-6">
        {section.steps.map((step, i) => (
          <DocStep key={i} step={step} />
        ))}
      </div>
    ),
  };
}

const buildInstallSection = (doc) => buildStepsSection(doc, 'install', 'Install', true);
const buildUseSection = (doc) => buildStepsSection(doc, 'use', 'Use', true);
const buildUninstallSection = (doc) =>
  buildStepsSection(doc, 'uninstall', 'Uninstall / Disconnect', false);
const buildAdvancedSection = (doc) => buildStepsSection(doc, 'advanced', 'Advanced', false);

function buildReferencesSection(doc) {
  if (!doc.references?.length) return null;
  return {
    id: 'references',
    title: 'References',
    defaultOpen: false,
    content: (
      <ul className="space-y-2">
        {doc.references.map((ref, i) => (
          <li key={i}>
            <a
              href={ref.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
              {ref.label}
            </a>
            <span className="ml-2 text-xs text-slate-400 font-mono">{ref.url}</span>
          </li>
        ))}
      </ul>
    ),
  };
}

function InPageNav() {
  const scrollTo = (id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <nav className="hidden xl:flex flex-col gap-1 sticky top-6 w-40 shrink-0">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
        On this page
      </p>
      {NAV_ITEMS.map(({ id, label }) => (
        <button
          key={id}
          onClick={() => scrollTo(id)}
          className="text-left text-xs text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors py-0.5"
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function ServiceDocsNotFound({ serviceId, onBack }) {
  return (
    <div className="max-w-2xl mx-auto px-4 py-12 text-center space-y-4">
      <AlertTriangle className="h-10 w-10 text-amber-400 mx-auto" />
      <h1 className="text-xl font-bold">Documentation not found</h1>
      <p className="text-slate-500">
        No docs found for service ID: <code className="bg-slate-100 px-1 rounded">{serviceId}</code>
      </p>
      <button
        onClick={onBack}
        className="inline-flex items-center gap-2 text-indigo-600 hover:underline text-sm"
      >
        <ArrowLeft className="h-4 w-4" /> Back to AI Engine
      </button>
    </div>
  );
}

function getSectionConfigs(doc) {
  return [
    buildInstallSection(doc),
    buildUseSection(doc),
    buildUninstallSection(doc),
    buildAdvancedSection(doc),
    buildReferencesSection(doc),
  ].filter(Boolean);
}

function ServiceDocsContent({ doc, onBack }) {
  const TypeIcon = doc.type === 'mcp_server' ? Server : Bot;
  const typeLabel = doc.type === 'mcp_server' ? 'MCP Server' : 'AI Provider';
  const sectionConfigs = getSectionConfigs(doc);

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <nav className="flex items-center gap-2 text-xs text-slate-400 mb-6">
        <Link to="/admin/ai-engine" className="hover:text-indigo-600 transition-colors">
          AI Engine
        </Link>
        <span>/</span>
        <span className="text-slate-600 dark:text-slate-200">{doc.name}</span>
      </nav>

      <div className="flex items-start gap-4 mb-8 pb-6 border-b border-slate-200 dark:border-slate-700">
        <div className="p-3 rounded-xl bg-indigo-100 dark:bg-indigo-900/40 shrink-0">
          <TypeIcon className="h-7 w-7 text-indigo-600 dark:text-indigo-400" />
        </div>
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold">{doc.name}</h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 border border-slate-200 dark:border-slate-700">
              {typeLabel}
            </span>
          </div>
          <p className="text-slate-500 mt-1">{doc.tagline}</p>
          <button
            onClick={onBack}
            className="mt-3 inline-flex items-center gap-1.5 text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to AI Engine
          </button>
        </div>
      </div>

      <div className="flex gap-8">
        <div className="flex-1 space-y-4 min-w-0">
          <DocSection id="requirements" title="Requirements" defaultOpen={true}>
            <RequirementsList requirements={doc.requirements} />
          </DocSection>

          <DocSection id="hcw-uses" title="HCW Uses" defaultOpen={true}>
            <UsesMatrix uses={doc.hcwUses} />
          </DocSection>

          {sectionConfigs.map(({ id, title, defaultOpen, content }) => (
            <DocSection key={id} id={id} title={title} defaultOpen={defaultOpen}>
              {content}
            </DocSection>
          ))}
        </div>

        <InPageNav />
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ServiceDocsPage() {
  const { serviceId } = useParams();
  const navigate = useNavigate();

  const doc = SERVICE_DOCS[serviceId];

  if (!doc) {
    return (
      <ServiceDocsNotFound serviceId={serviceId} onBack={() => navigate('/admin/ai-engine')} />
    );
  }

  return <ServiceDocsContent doc={doc} onBack={() => navigate('/admin/ai-engine')} />;
}

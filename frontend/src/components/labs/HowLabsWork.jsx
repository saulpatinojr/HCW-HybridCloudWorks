/**
 * "How labs work": the three things a learner meets, each defined in one
 * sentence (ADR 0033 §8, "Labs appear under each provider's Learn section
 * with Agent, Desktop and Lab explained").
 *
 *   Lab      the structured exercise on this site: objectives, steps, checks
 *   Desktop  the workspace the lab opens, VS Code in the browser on the
 *            Hybrid Lab host
 *   Agent    the job runner on the same host that checks work with fixed,
 *            sandboxed commands
 *
 * Visitor words only: the panel renders on the pane page, which
 * LabPanePage.test.jsx holds to naming nothing behind the site, and in
 * `components/`, which public-copy.test.js scans. The same three
 * definitions, with the operator's names for each, are on the admin Labs
 * Hub's Dashboard (components/admin/labs/ConceptsPanel.jsx).
 */
import React from 'react';
import { FlaskConical, Monitor, Bot } from 'lucide-react';

export const LAB_CONCEPTS = Object.freeze([
  Object.freeze({
    id: 'lab',
    icon: FlaskConical,
    title: 'Lab',
    body: 'A structured exercise on this site: what you will learn, what to have ready, the steps in order, and where a check can confirm your work. Each lab is listed under the provider it teaches.',
  }),
  Object.freeze({
    id: 'desktop',
    icon: Monitor,
    title: 'Desktop',
    body: 'The workspace a lab opens in: VS Code in your browser, running in a container on the Hybrid Lab host with the lab’s tools installed and its folder open. You sign in with GitHub, and the workspace stops on its own after an hour of inactivity.',
  }),
  Object.freeze({
    id: 'agent',
    icon: Bot,
    title: 'Agent',
    body: 'The job runner on the same host. It takes a file or folder you submit, runs one fixed check on it (a Terraform validate, an Ansible syntax check) in a sandbox with no network, and returns what the tool printed. Nothing you submit is executed against anything.',
  }),
]);

const MUTED = 'text-slate-600 dark:text-slate-400';

/**
 * @param {object} props
 * @param {'h2'|'h3'} [props.headingLevel] the heading the panel uses, so
 *   the outline stays in order wherever it sits
 * @param {string} [props.id] prefix for the heading id (`<id>-heading`)
 */
export default function HowLabsWork({ headingLevel = 'h2', id = 'how-labs-work' }) {
  const Heading = headingLevel;
  return (
    <section
      aria-labelledby={`${id}-heading`}
      data-testid="how-labs-work"
      className="glass rounded-xl p-5 flex flex-col gap-4"
    >
      <Heading
        id={`${id}-heading`}
        className="text-base font-bold text-slate-950 dark:text-white flex items-center gap-2"
      >
        <span className="w-1 h-5 bg-primary rounded-full" aria-hidden="true"></span>
        How labs work
      </Heading>
      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {LAB_CONCEPTS.map(({ id: conceptId, icon: Icon, title, body }) => (
          <div key={conceptId} className="flex flex-col gap-1.5" data-concept={conceptId}>
            <dt className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
              <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
              {title}
            </dt>
            <dd className={`text-xs leading-relaxed ${MUTED}`}>{body}</dd>
          </div>
        ))}
      </dl>
      <div
        data-testid="lab-trust-guarantees"
        className="mt-2 pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-300">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
            15-Min Scenarios
          </span>
          <span className="inline-flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-300">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-500" aria-hidden="true" />
            Browser Terminal
          </span>
          <span className="inline-flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-300">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-500" aria-hidden="true" />
            Zero Cloud Account Required
          </span>
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          GitHub public identity check only (read:user scope). No repository write access.
        </p>
      </div>
    </section>
  );
}

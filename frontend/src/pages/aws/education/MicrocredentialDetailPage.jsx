import React from 'react';
import { useParams, Link } from 'react-router';
import { Helmet } from 'react-helmet-async';
import { getProviderPath, routes } from '@/lib/routeFactory';

const ALL_MICROCREDENTIALS = [
  {
    slug: 'aws-serverless-demonstrated',
    code: 'Serverless',
    title: 'AWS Serverless Demonstrated',
    tagline: 'Hands-on serverless proficiency credential from AWS Skill Builder.',
    description:
      'Validates your ability to configure and connect core AWS serverless services in real-world hands-on scenarios.',
    longDescription:
      'The AWS Serverless Demonstrated microcredential is a 90-minute proctored, hands-on assessment that validates your practical ability to build serverless applications on AWS. You will work in a live AWS environment to configure Lambda, deploy APIs with API Gateway, orchestrate workflows with Step Functions, and wire up event-driven architectures — proving real-world proficiency beyond multiple-choice exams.',
    topics: [
      'Lambda configuration & optimization',
      'REST API deployment with API Gateway',
      'Step Functions state machine orchestration',
      'Event-driven architecture patterns',
      'CI/CD pipelines for serverless apps',
    ],
    duration: '90 minutes',
    format: 'Proctored hands-on lab',
    relatedCerts: ['dva-c02', 'saa-c03'],
    skillBuilderUrl:
      'https://skillbuilder.aws/learn/XV3B4RGA8Q/aws-serverless-demonstrated/BYD5SH8R5C',
    icon: 'bolt',
    color: 'amber',
  },
  {
    slug: 'aws-agentic-ai-demonstrated',
    code: 'Agentic AI',
    title: 'AWS Agentic AI Demonstrated',
    tagline: 'Hands-on agentic AI proficiency credential from AWS Skill Builder.',
    description:
      'Validates your ability to develop and troubleshoot agentic AI solutions using Amazon Bedrock Agents.',
    longDescription:
      'The AWS Agentic AI Demonstrated microcredential is a 90-minute proctored, hands-on assessment that validates your practical ability to build, configure, and troubleshoot agentic AI applications using Amazon Bedrock. You will work in a live AWS environment to set up Bedrock Agents, connect knowledge bases, implement Guardrails, and integrate agents into a web application — proving real-world generative AI proficiency.',
    topics: [
      'Amazon Bedrock Agents configuration & deployment',
      'Knowledge bases setup and management',
      'Bedrock Guardrails implementation',
      'Web application integration with Bedrock Agents',
      'Troubleshooting AI agents and knowledge bases',
    ],
    duration: '90 minutes',
    format: 'Proctored hands-on lab',
    relatedCerts: ['aip-c01', 'aif-c01'],
    skillBuilderUrl:
      'https://skillbuilder.aws/learn/32Y249P272/aws-agentic-ai-demonstrated/TTAJ5WKYTS',
    icon: 'smart_toy',
    color: 'violet',
  },
  {
    slug: 'aws-incident-response-demonstrated',
    code: 'Incident Response',
    title: 'AWS Incident Response Demonstrated',
    tagline: 'Hands-on security incident response credential from AWS Skill Builder.',
    description:
      'Validates your ability to identify, contain, and remediate common AWS security incidents in real-world scenarios.',
    longDescription:
      'The AWS Incident Response Demonstrated microcredential is a 90-minute proctored, hands-on assessment that validates your practical ability to handle security incidents on AWS. You will work in a live AWS environment to detect active threats, apply containment procedures, and carry out remediation — proving hands-on security response skills that go beyond theoretical knowledge.',
    topics: [
      'Security incident identification & detection',
      'Containment procedures for AWS incidents',
      'Remediation and response strategies',
      'Threat analysis in live AWS environments',
      'Post-incident review and reporting',
    ],
    duration: '90 minutes',
    format: 'Proctored hands-on lab',
    relatedCerts: ['scs-c03'],
    skillBuilderUrl:
      'https://skillbuilder.aws/learn/UQWKF19DT7/aws-incident-response-demonstrated/VH96JY5RJZ',
    icon: 'security',
    color: 'red',
  },
  {
    slug: 'aws-application-networking-demonstrated',
    code: 'App Networking',
    title: 'AWS Application Networking Demonstrated',
    tagline: 'Hands-on application networking proficiency credential from AWS Skill Builder.',
    description:
      'Validates your ability to configure application delivery, optimize performance, and implement modern application architectures on AWS.',
    longDescription:
      'The AWS Application Networking Demonstrated microcredential is a 90-minute proctored, hands-on assessment that validates your practical ability to design and configure application networking on AWS. You will work in a live AWS environment to configure load balancers, optimize application delivery performance, and implement networking patterns for modern microservices architectures.',
    topics: [
      'Application delivery & load balancing',
      'Performance optimization for AWS networking',
      'Modern application architecture patterns',
      'Networking for microservices',
      'AWS networking services configuration',
    ],
    duration: '90 minutes',
    format: 'Proctored hands-on lab',
    relatedCerts: ['ans-c01'],
    skillBuilderUrl: 'https://skillbuilder.aws/category/type/microcredentials',
    icon: 'network_node',
    color: 'sky',
  },
];

const CERT_META = {
  'dva-c02': { code: 'DVA-C02', title: 'AWS Certified Developer – Associate' },
  'saa-c03': { code: 'SAA-C03', title: 'AWS Certified Solutions Architect – Associate' },
  'aip-c01': { code: 'AIP-C01', title: 'AWS Certified Generative AI Developer – Professional' },
  'aif-c01': { code: 'AIF-C01', title: 'AWS Certified AI Practitioner' },
  'scs-c03': { code: 'SCS-C03', title: 'AWS Certified Security – Specialty' },
  'ans-c01': { code: 'ANS-C01', title: 'AWS Certified Advanced Networking – Specialty' },
};

const COLOR = {
  amber: {
    badge: 'bg-amber-500/20 border-amber-500/40 text-amber-300',
    accent: 'from-amber-900/30',
    glow: 'rgba(245,158,11,0.15)',
    icon: 'text-amber-400',
    btn: 'bg-amber-500 hover:bg-amber-400 text-slate-950',
    hover: 'hover:border-amber-400/30',
    num: 'bg-amber-500/20 text-amber-300',
    link: 'hover:text-amber-400',
    back: 'hover:text-amber-400',
  },
  violet: {
    badge: 'bg-violet-500/20 border-violet-500/40 text-violet-300',
    accent: 'from-violet-900/30',
    glow: 'rgba(139,92,246,0.15)',
    icon: 'text-violet-400',
    btn: 'bg-violet-500 hover:bg-violet-400 text-white',
    hover: 'hover:border-violet-400/30',
    num: 'bg-violet-500/20 text-violet-300',
    link: 'hover:text-violet-400',
    back: 'hover:text-violet-400',
  },
  red: {
    badge: 'bg-red-500/20 border-red-500/40 text-red-300',
    accent: 'from-red-900/30',
    glow: 'rgba(239,68,68,0.15)',
    icon: 'text-red-400',
    btn: 'bg-red-500 hover:bg-red-400 text-white',
    hover: 'hover:border-red-400/30',
    num: 'bg-red-500/20 text-red-300',
    link: 'hover:text-red-400',
    back: 'hover:text-red-400',
  },
  sky: {
    badge: 'bg-sky-500/20 border-sky-500/40 text-sky-300',
    accent: 'from-sky-900/30',
    glow: 'rgba(14,165,233,0.15)',
    icon: 'text-sky-400',
    btn: 'bg-sky-500 hover:bg-sky-400 text-slate-950',
    hover: 'hover:border-sky-400/30',
    num: 'bg-sky-500/20 text-sky-300',
    link: 'hover:text-sky-400',
    back: 'hover:text-sky-400',
  },
};

export default function MicrocredentialDetailPage() {
  const { mcSlug } = useParams();
  const mc = ALL_MICROCREDENTIALS.find((m) => m.slug === mcSlug);

  if (!mc) {
    return (
      <main className="flex-grow pt-28 pb-20 px-4 md:px-8 max-w-[1440px] mx-auto w-full">
        <div className="text-center py-20">
          <span
            className="text-amber-400 text-[64px] material-symbols-outlined mb-4 block"
            aria-hidden="true"
          >
            search_off
          </span>
          <h1 className="text-3xl font-bold text-slate-950 dark:text-white mb-4">
            Microcredential Not Found
          </h1>
          <p className="text-foreground mb-8">
            The microcredential <code className="font-mono text-amber-400">{mcSlug}</code> was not
            found.
          </p>
          <Link
            to={routes.education('aws')}
            className="px-6 h-11 bg-amber-500 hover:bg-amber-400 text-slate-950 font-bold rounded-lg transition-colors inline-flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
              arrow_back
            </span>
            Back to AWS Education
          </Link>
        </div>
      </main>
    );
  }

  const c = COLOR[mc.color];
  const relatedCerts = mc.relatedCerts.map((slug) => CERT_META[slug]).filter(Boolean);

  return (
    <>
      <Helmet>
        <title>{`${mc.title} | AWS Microcredentials | HCW`}</title>
        <meta name="description" content={mc.description} />
        <meta property="og:title" content={mc.title} />
        <meta property="og:description" content={mc.longDescription} />
      </Helmet>

      <main className="flex-grow pt-28 pb-20 px-4 md:px-8 max-w-[1440px] mx-auto w-full">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-2 text-sm text-foreground/60 mb-8">
          <Link to={routes.education('aws')} className="hover:text-amber-400 transition-colors">
            AWS Education
          </Link>
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
            chevron_right
          </span>
          <span className="text-foreground/60">Microcredentials</span>
          <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
            chevron_right
          </span>
          <span className="text-foreground">{mc.code}</span>
        </nav>

        {/* Hero */}
        <section
          className={`mb-10 bg-gradient-to-br ${c.accent} to-card/20 backdrop-blur-md border border-card/40 rounded-2xl p-8 relative overflow-hidden`}
        >
          <div
            className="absolute -top-10 -right-10 w-64 h-64 rounded-full blur-3xl pointer-events-none"
            style={{ background: `radial-gradient(circle, ${c.glow} 0%, transparent 70%)` }}
          />
          <div className="relative z-10">
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <span className={`px-3 py-1 border text-xs font-bold rounded ${c.badge}`}>
                Microcredential
              </span>
              <span className="px-3 py-1 border border-card/50 text-foreground/60 text-xs font-bold rounded">
                Hands-On Assessment
              </span>
            </div>
            <div className="flex items-center gap-4 mb-3">
              <div
                className={`w-14 h-14 rounded-2xl bg-card/40 flex items-center justify-center shrink-0`}
              >
                <span
                  className={`material-symbols-outlined text-[32px] ${c.icon}`}
                  aria-hidden="true"
                >
                  {mc.icon}
                </span>
              </div>
              <h1 className="text-3xl sm:text-4xl font-bold text-slate-950 dark:text-white">
                {mc.title}
              </h1>
            </div>
            <p className="text-foreground text-lg max-w-3xl mb-6">{mc.longDescription}</p>
            <div className="flex flex-wrap gap-6 text-sm">
              <div>
                <div className="text-foreground/60 mb-0.5">Duration</div>
                <div className="text-2xl font-bold text-slate-950 dark:text-white">
                  {mc.duration}
                </div>
              </div>
              <div>
                <div className="text-foreground/60 mb-0.5">Format</div>
                <div className="text-2xl font-bold text-slate-950 dark:text-white">{mc.format}</div>
              </div>
            </div>
          </div>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-8">
          <div className="space-y-8">
            {/* Skills Validated */}
            <section className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6">
              <h2 className="text-xl font-bold text-slate-950 dark:text-white mb-4 flex items-center gap-2">
                <span
                  className={`material-symbols-outlined text-[20px] ${c.icon}`}
                  aria-hidden="true"
                >
                  check_circle
                </span>
                Skills Validated
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {mc.topics.map((topic, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 bg-card/50 rounded-xl px-3 py-2.5"
                  >
                    <span
                      className={`material-symbols-outlined text-[16px] ${c.icon}`}
                      aria-hidden="true"
                    >
                      verified
                    </span>
                    <span className="text-foreground text-sm">{topic}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* What to Expect */}
            <section className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6">
              <h2 className="text-xl font-bold text-slate-950 dark:text-white mb-4 flex items-center gap-2">
                <span
                  className={`material-symbols-outlined text-[20px] ${c.icon}`}
                  aria-hidden="true"
                >
                  menu_book
                </span>
                What to Expect
              </h2>
              <div className="space-y-3">
                {[
                  {
                    step: 1,
                    title: 'Live AWS Environment',
                    body: 'You work inside a real AWS sandbox account — no simulation. Every action you take is against live AWS services.',
                  },
                  {
                    step: 2,
                    title: 'Scenario-Based Tasks',
                    body: 'You receive a real-world scenario and a set of tasks to complete. There are no multiple-choice questions.',
                  },
                  {
                    step: 3,
                    title: 'Automated Scoring',
                    body: 'Your environment is evaluated automatically against expected outcomes. Results are available immediately after submission.',
                  },
                  {
                    step: 4,
                    title: 'Digital Badge',
                    body: 'Earners receive a verifiable digital badge from AWS that can be shared on LinkedIn and other professional networks.',
                  },
                ].map(({ step, title, body }) => (
                  <div
                    key={step}
                    className="flex items-start gap-3 bg-card/40 border border-card/30 rounded-xl px-4 py-3"
                  >
                    <span
                      className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${c.num}`}
                    >
                      {step}
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-slate-950 dark:text-white mb-0.5">
                        {title}
                      </div>
                      <div className="text-xs text-foreground/70">{body}</div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Related Certifications */}
            {relatedCerts.length > 0 && (
              <section className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6">
                <h2 className="text-xl font-bold text-slate-950 dark:text-white mb-4 flex items-center gap-2">
                  <span
                    className={`material-symbols-outlined text-[20px] ${c.icon}`}
                    aria-hidden="true"
                  >
                    trending_up
                  </span>
                  Related Certifications
                </h2>
                <p className="text-sm text-foreground/60 mb-4">
                  This microcredential complements the following AWS certifications.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {relatedCerts.map((cert) => (
                    <Link
                      key={cert.code}
                      to={getProviderPath('aws', `education/${cert.code.toLowerCase()}`)}
                      className={`group flex items-center gap-3 bg-card/40 hover:bg-card/60 border border-card/30 ${c.hover} rounded-xl px-4 py-3 transition-all`}
                    >
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${c.icon.replace('text-', 'bg-')}`}
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-mono text-foreground/50">{cert.code}</div>
                        <div
                          className={`text-sm font-semibold text-foreground group-${c.link} transition-colors line-clamp-1`}
                        >
                          {cert.title.replace(/AWS Certified\s+/i, '')}
                        </div>
                      </div>
                      <span
                        className="material-symbols-outlined text-[16px] text-foreground/40 ml-auto shrink-0"
                        aria-hidden="true"
                      >
                        arrow_forward
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* Sidebar */}
          <aside className="space-y-6 h-fit sticky top-28">
            {/* CTA */}
            <div className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6 space-y-3">
              <a
                href={mc.skillBuilderUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`flex items-center justify-center gap-2 w-full h-11 ${c.btn} font-bold rounded-lg transition-colors`}
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  open_in_new
                </span>
                Earn on AWS Skill Builder
              </a>
              <a
                href="https://skillbuilder.aws/category/type/microcredentials"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full h-11 bg-card/50 hover:bg-card/70 text-foreground font-semibold rounded-lg transition-colors text-sm"
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                  grid_view
                </span>
                Browse All Microcredentials
              </a>
            </div>

            {/* Quick Facts */}
            <div className="bg-card/40 backdrop-blur-md border border-card/50 rounded-2xl p-6 space-y-4">
              <h3 className="text-base font-bold text-slate-950 dark:text-white">Quick Facts</h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-foreground/60">Type</span>
                  <span className="font-bold text-slate-950 dark:text-white">Microcredential</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-foreground/60">Format</span>
                  <span className="font-bold text-slate-950 dark:text-white">Hands-On Lab</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-foreground/60">Duration</span>
                  <span className="font-bold text-slate-950 dark:text-white">{mc.duration}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-foreground/60">Proctored</span>
                  <span className="font-bold text-slate-950 dark:text-white">Yes</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-foreground/60">Platform</span>
                  <span className="font-bold text-slate-950 dark:text-white">
                    AWS Skill Builder
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-foreground/60">Badge</span>
                  <span className="font-bold text-slate-950 dark:text-white">
                    Digital (verifiable)
                  </span>
                </div>
              </div>
            </div>

            <Link
              to={routes.education('aws')}
              className="flex items-center gap-2 text-sm text-foreground/60 hover:text-amber-400 transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                arrow_back
              </span>
              Back to AWS Education
            </Link>
          </aside>
        </div>
      </main>
    </>
  );
}

import React from 'react';
import { Link } from 'react-router';
import { routes } from '@/lib/routeFactory';
import ProviderLandingTemplate from '@/components/shared/ProviderLandingTemplate';
import HeroImageCarousel from '@/components/landing/HeroImageCarousel';
import useAudioEpisodes from '@/hooks/useAudioEpisodes';
import { hasInterviews } from '@/data/interviews/available';

const AZURE_HERO_IMAGES = [
  '/images/azure-hero/1.png',
  '/images/azure-hero/2.png',
  '/images/azure-hero/3.png',
  '/images/azure-hero/4.png',
  '/images/azure-hero/5.png',
];

const ARCHITECTURE_CARDS = [
  {
    label: 'Networking',
    meta: 'Hub-Spoke',
    title: 'Hub-and-Spoke Network',
    text: 'ExpressRoute gateway, Azure Firewall, shared services VNet with spoke isolation and route tables.',
    tags: ['ExpressRoute', 'Firewall', 'VNet'],
  },
  {
    label: 'Containers',
    meta: 'Production AKS',
    title: 'AKS Landing Zone',
    text: 'Private AKS cluster with Azure CNI, Defender, workload identity, and integrated Container Registry.',
    tags: ['AKS', 'Workload Identity', 'Defender'],
  },
];

const FRAMEWORKS = [
  {
    abbr: 'CAF',
    name: 'Cloud Adoption Framework',
    description:
      'Microsoft guidance for end-to-end Azure adoption — strategy, planning, readiness, and governance at enterprise scale.',
  },
  {
    abbr: 'WAF',
    name: 'Well-Architected Framework',
    description:
      'Five pillars for building reliable, secure, cost-efficient, and operationally excellent Azure workloads.',
  },
  {
    abbr: 'ALZ',
    name: 'Azure Landing Zones',
    description:
      'Prescriptive architecture and platform accelerators for deploying governed Azure environments at scale.',
  },
];

const CERTS = [
  {
    code: 'AZ-104',
    slug: 'az-104',
    title: 'Azure Administrator Associate',
    difficulty: 'Associate',
    duration: '~3 months',
    skills: ['Entra ID', 'Networking', 'Storage'],
  },
  {
    code: 'AZ-305',
    slug: 'az-305',
    title: 'Azure Solutions Architect Expert',
    difficulty: 'Expert',
    duration: '~6 months',
    skills: ['Landing Zones', 'Hybrid', 'Cost'],
  },
  {
    code: 'AZ-400',
    slug: 'az-400',
    title: 'Azure DevOps Engineer Expert',
    difficulty: 'Expert',
    duration: '~6 months',
    skills: ['Pipelines', 'GitHub', 'IaC'],
  },
  {
    code: 'AI-103',
    slug: 'ai-103',
    title: 'Azure AI Apps & Agents Developer',
    difficulty: 'Associate',
    duration: '~3 months',
    skills: ['Azure AI', 'OpenAI', 'Agents'],
    isBeta: true,
  },
];

function ArchitectureCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {ARCHITECTURE_CARDS.map((card) => (
        <Link
          key={card.title}
          to={routes.architectureDesigns('azure')}
          className="glass glass-hover rounded-xl overflow-hidden flex flex-col"
        >
          <div className="h-2 w-full bg-primary/60" aria-hidden="true" />
          <div className="p-5 flex flex-col gap-2 flex-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] bg-primary/15 text-primary px-2 py-0.5 rounded font-bold uppercase tracking-wide">
                {card.label}
              </span>
              <span className="text-[10px] text-slate-500">{card.meta}</span>
            </div>
            <h3 className="font-bold text-foreground">{card.title}</h3>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              {card.text}
            </p>
            <div className="flex gap-1 flex-wrap mt-auto pt-2">
              {card.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded"
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

function FrameworkCards() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {FRAMEWORKS.map(({ abbr, name, description }) => (
        <div key={abbr} className="glass rounded-xl p-5 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="size-10 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
              <span className="material-symbols-outlined text-primary text-base" aria-hidden="true">
                account_tree
              </span>
            </div>
            <div>
              <div className="text-[10px] font-black text-primary/80 tracking-widest uppercase">
                {abbr}
              </div>
              <h3 className="text-sm font-bold text-foreground leading-snug">{name}</h3>
            </div>
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
            {description}
          </p>
        </div>
      ))}
    </div>
  );
}

// Azure's interviews, linked from here and not from the header: the header's
// toolbar is a fixed grid of nine slots and a tenth link overflowed it.
// Carries no interview text, so this page's bundle stays as it was.
function InterviewsCard() {
  return (
    <div className="glass rounded-xl p-5 max-w-2xl">
      <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
        Conversations with people building and running Microsoft Azure, written up in full. Read
        them as an article, or turn the pages of a book.
      </p>
    </div>
  );
}

function PodcastList() {
  // Both audio sources, newest first (#349); the card shows the latest three.
  const { episodes } = useAudioEpisodes('azure');
  if (!episodes || episodes.length === 0) {
    return <p className="text-sm text-slate-500 py-2">No episodes available yet.</p>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {episodes.slice(0, 3).map((ep, i) => {
        const mins = ep.durationSeconds ? Math.floor(ep.durationSeconds / 60) : null;
        return (
          <Link
            key={ep.id}
            to={routes.audio('azure')}
            className="glass glass-hover rounded-xl flex items-start gap-3 p-4"
          >
            <div className="size-9 shrink-0 rounded-full bg-primary/10 flex items-center justify-center text-primary">
              <span className="material-symbols-outlined text-base" aria-hidden="true">
                play_circle
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-[10px] bg-primary/15 text-primary px-1.5 py-0.5 rounded font-bold">
                  EP {i + 1}
                </span>
                {mins ? <span className="text-[10px] text-slate-500">{mins} min</span> : null}
              </div>
              <h3 className="text-sm font-semibold text-foreground leading-snug line-clamp-2">
                {ep.title}
              </h3>
              {ep.publishedAtString && (
                <p className="text-[10px] text-slate-500 mt-0.5">{ep.publishedAtString}</p>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function CertList() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {CERTS.map(({ code, slug, title, difficulty, duration, skills, isBeta }) => (
        <Link
          key={code}
          to={`/azure/education/${slug}`}
          className="glass glass-hover rounded-xl flex items-start gap-3 p-4"
        >
          <div className="size-10 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
            <span className="material-symbols-outlined text-primary text-base" aria-hidden="true">
              workspace_premium
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              <span className="text-[10px] font-black text-primary">{code}</span>
              {isBeta && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 bg-amber-500/20 text-amber-600 dark:text-amber-400 rounded">
                  BETA
                </span>
              )}
              <span className="text-[10px] text-slate-500">
                {difficulty} · {duration}
              </span>
            </div>
            <h3 className="text-sm font-bold text-foreground leading-snug">{title}</h3>
            <div className="flex gap-1 flex-wrap mt-1">
              {skills.map((s) => (
                <span
                  key={s}
                  className="text-[10px] bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 px-1.5 py-0.5 rounded"
                >
                  {s}
                </span>
              ))}
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}

export default function LandingPage() {
  return (
    <ProviderLandingTemplate
      provider="azure"
      hero={{
        eyebrow: 'ENTERPRISE CLOUD SOLUTIONS',
        title: (
          <>
            Architecture intelligence for <span className="display-accent">Azure</span>
          </>
        ),
        description:
          'Deploy enterprise-grade Azure landing zones with Bicep-driven infrastructure as code, hub-spoke networks with ExpressRoute connectivity, private AKS clusters, and battle-tested security patterns.',
        media: (
          <HeroImageCarousel
            images={AZURE_HERO_IMAGES}
            intervalMs={3000}
            fadeMs={800}
            alt="Azure cloud architecture imagery"
          />
        ),
        cta: { label: 'Explore Architectures', to: routes.architectureDesigns('azure') },
        stats: [
          { value: '5', label: 'WAF Pillars' },
          { value: '2', suffix: '+', label: 'Reference Designs' },
          { value: '4', label: 'Cert Tracks' },
        ],
      }}
      sections={[
        {
          eyebrow: 'REFERENCE DESIGNS',
          title: 'Azure Reference Architectures',
          action: { label: 'All designs', to: routes.architectureDesigns('azure') },
          content: <ArchitectureCards />,
        },
        {
          eyebrow: 'GUIDANCE',
          title: 'Frameworks',
          action: { label: 'All frameworks', to: routes.frameworks('azure') },
          content: <FrameworkCards />,
        },
        {
          eyebrow: 'ON AIR',
          title: 'Azure Podcasts',
          action: { label: 'All episodes', to: routes.audio('azure') },
          content: <PodcastList />,
        },
        // Only once there is an interview file (data/interviews/available.js).
        ...(hasInterviews
          ? [
              {
                eyebrow: 'IN CONVERSATION',
                title: 'Interviews',
                action: { label: 'All interviews', to: routes.interviews('azure') },
                content: <InterviewsCard />,
              },
            ]
          : []),
        {
          eyebrow: 'LEARNING CENTER',
          title: 'Certification Tracks',
          action: { label: 'All certifications', to: routes.education('azure') },
          content: <CertList />,
        },
      ]}
    />
  );
}

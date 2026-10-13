import React, { createContext, lazy, useContext } from 'react';
import { useParams, Outlet } from 'react-router';
import { PROVIDER_FEEDS } from '@/data/providerFeeds';

const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'));

/**
 * Valid cloud providers supported by the application
 */
export const VALID_PROVIDERS = [
  'azure',
  'aws',
  'gcp',
  'github',
  'terraform',
  'finops',
  'vmware',
  'ansible',
  'docker',
];

/**
 * Provider Context - provides the current cloud provider throughout the app
 */
const ProviderContext = createContext(null);

/**
 * Hook to access the current provider from any component
 * @returns {string|null} The current provider ('azure', 'aws', 'gcp', 'github', 'terraform', 'finops') or null
 */
export function useProvider() {
  const context = useContext(ProviderContext);
  return context;
}

/**
 * Default podcast subscription metadata for the site's main show (ADR 0029 §1a).
 * Every provider's /:provider/audio page leads with the main show, so every
 * provider inherits these subscribe links unless overridden.
 */
export const MAIN_PODCAST_CONFIG = {
  // The RSS feed URL is not configured here (issue #349): the podcast
  // page reads it from `admin_config/podcast_feeds` through
  // `GET public/podcasts`, the same document the ingest timer uses, so
  // the button and the ingest cannot name two different feeds. This
  // stays null and is only a fallback. The Apple link was the creator
  // dashboard (podcastsconnect), not a listener page, so it is gone
  // until the show is resubmitted; Spotify and Amazon are the listener
  // pages that existed on 2026-09-06.
  feedUrl: null,
  subscribeLinks: {
    spotify: 'https://open.spotify.com/show/66tno2OzalMJZOvSDqM77Y',
    amazon:
      'https://music.amazon.com/podcasts/d139c50a-8163-425c-8315-4e19cc9370ee/hybrid-cloud-works',
    youtube: 'https://www.youtube.com/channel/UCI8e-UAXgefLDN-Ztq-qXHA/podcasts',
  },
};

/**
 * Hook to get provider-specific configuration
 * @returns {object} Provider configuration including name, theme, blog path, etc.
 */
export function useProviderConfig() {
  const provider = useProvider();

  const configs = {
    azure: {
      name: 'Azure',
      displayName: 'Microsoft Azure',
      theme: 'theme-azure',
      blogPath: 'blog',
      color: 'hsl(var(--primary))',
      // The feeds the news pages show; data/providerFeeds.js says why the
      // list lives there and what holds it to the server's.
      rssFeeds: PROVIDER_FEEDS.azure,
      blogSource: 'https://azure.microsoft.com/en-us/blog/',
      podcast: MAIN_PODCAST_CONFIG,
    },
    aws: {
      name: 'AWS',
      displayName: 'Amazon Web Services',
      theme: 'theme-aws',
      blogPath: 'foundational-posts',
      color: 'hsl(var(--primary))',
      rssFeeds: PROVIDER_FEEDS.aws,
      blogSource: 'https://aws.amazon.com/blogs/aws/',
      podcast: MAIN_PODCAST_CONFIG,
    },
    gcp: {
      name: 'Google Cloud',
      displayName: 'Google Cloud Platform',
      theme: 'theme-gcp',
      blogPath: 'foundational-posts',
      color: 'hsl(var(--primary))',
      rssFeeds: PROVIDER_FEEDS.gcp,
      blogSource: 'https://cloud.google.com/blog/',
      podcast: MAIN_PODCAST_CONFIG,
    },
    github: {
      name: 'GitHub',
      displayName: 'GitHub',
      theme: 'theme-github',
      blogPath: 'foundational-posts',
      color: 'hsl(var(--primary))',
      rssFeeds: PROVIDER_FEEDS.github,
      blogSource: 'https://github.blog/',
      podcast: MAIN_PODCAST_CONFIG,
    },
    terraform: {
      name: 'Terraform',
      displayName: 'HashiCorp Terraform',
      theme: 'theme-terraform',
      blogPath: 'foundational-posts',
      color: 'hsl(var(--primary))',
      rssFeeds: PROVIDER_FEEDS.terraform,
      blogSource: 'https://www.hashicorp.com/blog/',
      podcast: MAIN_PODCAST_CONFIG,
    },
    finops: {
      name: 'FinOps',
      displayName: 'FinOps Foundation',
      theme: 'theme-finops',
      blogPath: 'foundational-posts',
      color: 'hsl(var(--primary))',
      rssFeeds: PROVIDER_FEEDS.finops,
      blogSource: 'https://www.finops.org/',
      podcast: MAIN_PODCAST_CONFIG,
    },
    vmware: {
      name: 'VMware',
      displayName: 'VMware by Broadcom',
      theme: 'theme-vmware',
      blogPath: 'foundational-posts',
      color: 'hsl(var(--primary))',
      rssFeeds: PROVIDER_FEEDS.vmware,
      blogSource: 'https://blogs.vmware.com/',
      podcast: MAIN_PODCAST_CONFIG,
    },
    ansible: {
      name: 'Ansible',
      displayName: 'Red Hat Ansible',
      theme: 'theme-ansible',
      blogPath: 'foundational-posts',
      color: 'hsl(var(--primary))',
      rssFeeds: PROVIDER_FEEDS.ansible,
      blogSource: 'https://www.ansible.com/blog',
      podcast: MAIN_PODCAST_CONFIG,
    },
    docker: {
      name: 'Docker',
      // Not plain 'Docker': the landing template titles a page "<displayName>
      // Hub", and "Docker Hub" is the name of Docker's own image registry.
      displayName: 'Docker Containers',
      theme: 'theme-docker',
      blogPath: 'foundational-posts',
      color: 'hsl(var(--primary))',
      // The feed the news timer reads for Docker (#777). docker.com/blog/feed/
      // redirects to the address it names.
      rssFeeds: PROVIDER_FEEDS.docker,
      blogSource: 'https://www.docker.com/blog/',
      podcast: MAIN_PODCAST_CONFIG,
    },
  };

  return provider ? configs[provider] : null;
}

/**
 * ProviderLayout - Validates provider param and provides context to child routes
 * Wraps all provider-specific routes with validation and context
 */
export function ProviderLayout() {
  const { provider } = useParams();

  // Validate provider is one of our supported providers
  if (!provider || !VALID_PROVIDERS.includes(provider)) {
    return <NotFoundPage />;
  }

  return (
    <ProviderContext.Provider value={provider}>
      <Outlet />
    </ProviderContext.Provider>
  );
}

export default ProviderContext;

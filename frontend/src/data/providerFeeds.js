/**
 * The default official RSS feeds for each provider, feed for feed.
 *
 * A COPY OF THE SERVER'S LIST, HELD TO IT BY A TEST. The seed list is
 * `PROVIDER_FEEDS` in functions/src/lib/rss/feeds.js: the ingest timer fetches
 * those seeds plus saved source overrides; `GET public/feed` serves the cache to
 * every `/<provider>/news` and `/<provider>/rss` page. The browser cannot
 * import that module (it pulls in a server-only HTML parser), so the list is
 * repeated here, and `providerFeeds.test.js` reads the server file and fails
 * if the two differ by a single feed, name or address.
 *
 * WHY IT EXISTS. The home page's "Quick Access Hubs" printed a feed count per
 * provider that nothing derived: Azure said 24 when the server read seven,
 * AWS 32 against three. The counts now come from here, and the test above
 * means they can only be as wrong as the server's own list.
 *
 * `ProviderContext`'s `rssFeeds` reads the same object, so the frontend has
 * one list rather than two that drift apart. Until this file existed that one
 * still named Azure Updates' retired CDN address and Ansible's old feed.
 *
 * Plain data, no JSX and no `@/` imports, so a Node script can import it too.
 */
export const PROVIDER_FEEDS = Object.freeze({
  azure: Object.freeze([
    { name: 'Azure Blog', url: 'https://azure.microsoft.com/en-us/blog/feed/' },
    {
      name: 'Microsoft Azure Updates API',
      url: 'https://www.microsoft.com/releasecommunications/api/v2/azure/rss',
    },
    {
      name: 'Microsoft 365 Roadmap',
      url: 'https://www.microsoft.com/releasecommunications/api/v2/m365/rss',
    },
    {
      name: 'Azure Migration Blog',
      url: 'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=AzureMigrationBlog',
    },
    {
      name: 'Azure Arc Blog',
      url: 'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=AzureArcBlog',
    },
    { name: 'Microsoft Foundry Blog', url: 'https://devblogs.microsoft.com/foundry/feed/' },
    {
      name: 'Microsoft Learn Skills Hub',
      url: 'https://techcommunity.microsoft.com/t5/s/gxcuf89792/rss/board?board.id=skills-hub-blog',
    },
  ]),
  aws: Object.freeze([
    { name: 'AWS Blog', url: 'https://aws.amazon.com/blogs/aws/feed/' },
    { name: 'Kiro Blog', url: 'https://kiro.dev/blog/feed.rss' },
    { name: 'AWS Whats New', url: 'https://aws.amazon.com/about-aws/whats-new/recent/feed/' },
    { name: 'AWS APN Partner Network', url: 'https://aws.amazon.com/blogs/apn/feed/' },
  ]),
  gcp: Object.freeze([
    { name: 'Google Cloud Blog', url: 'https://cloudblog.withgoogle.com/rss/' },
    { name: 'GCP Release Notes', url: 'https://cloud.google.com/feeds/gcp-release-notes.xml' },
    { name: 'Google Cloud Partners', url: 'https://cloudblog.withgoogle.com/topics/partners/rss/' },
  ]),
  github: Object.freeze([
    { name: 'GitHub Blog', url: 'https://github.blog/feed/' },
    { name: 'GitHub Changelog', url: 'https://github.blog/changelog/feed/' },
    { name: 'GitHub Developer Skills', url: 'https://github.blog/developer-skills/github/feed/' },
    { name: 'GitHub Copilot', url: 'https://github.blog/ai-and-ml/github-copilot/feed/' },
  ]),
  terraform: Object.freeze([
    { name: 'HashiCorp Blog', url: 'https://www.hashicorp.com/blog/feed.xml' },
  ]),
  ansible: Object.freeze([
    {
      name: 'Ansible Blog',
      url: 'https://www.redhat.com/en/rss/blog/channel/red-hat-ansible-automation',
    },
  ]),
  vmware: Object.freeze([{ name: 'VMware Blogs', url: 'https://blogs.vmware.com/feed/' }]),
  finops: Object.freeze([{ name: 'FinOps Foundation', url: 'https://www.finops.org/feed/' }]),
  docker: Object.freeze([{ name: 'Docker Blog', url: 'https://www.docker.com/feed/' }]),
});

/** How many feeds the site reads for a provider; 0 for one it reads none for. */
export function feedCount(provider) {
  return PROVIDER_FEEDS[provider]?.length ?? 0;
}

/** "7 FEEDS", "1 FEED": the hub's note, in the hub's own capitals. */
export function feedCountLabel(provider) {
  const count = feedCount(provider);
  return `${count} ${count === 1 ? 'FEED' : 'FEEDS'}`;
}

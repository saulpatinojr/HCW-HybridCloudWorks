/** The Creative hub's probes (ADR 0033 §1 Platform, §8): the models, image generation, the forge. */
import { AI_ENGINE, FORGE, GALLERY, fromService, liveProbe, snapshotProbe } from '../probeKit';
import { evaluateForge, evaluateOrphanedImages } from '../probeEvaluators';
import { runAiProviders, runMcpServers } from '../probeRunners';

export const CREATIVE_PROBES = [
  liveProbe({
    id: 'ai-providers',
    label: 'AI providers',
    hub: 'creative',
    costNote: 'One short prompt per enabled provider, the same as the AI Engine Test button.',
    covers: 'Every provider enabled on the AI Engine page, asked one word.',
    impact: 'Drafts, summaries, inspection and scripts fail or fall to a backup.',
    action: 'Reorder or disable a provider on AI Engine; rotate a rejected key on Keys.',
    href: AI_ENGINE,
    run: runAiProviders,
  }),
  liveProbe({
    id: 'mcp-servers',
    label: 'MCP servers',
    hub: 'creative',
    covers: 'Every MCP server switched on in the AI Engine, by its last tool sync.',
    impact: 'Tools called through MCP fail, and the Recording Hub loses Plaud.',
    action: 'Sync the server’s tools on AI Engine; reconnect its sign-in if it was refused.',
    href: AI_ENGINE,
    run: runMcpServers,
  }),
  fromService('replicate', {
    hub: 'creative',
    covers: 'Cover image generation.',
    impact: 'New posts fall back to a stock cover.',
    action: 'Rotate the key on the Keys tab if the account is refused.',
  }),
  fromService('firecrawl', {
    hub: 'creative',
    covers: 'Finding new articles on blog listing pages.',
    impact: 'Blog pages that have no feed bring in no new drafts.',
    action: 'Top up credits or rotate the key.',
  }),
  snapshotProbe({
    id: 'forge',
    label: 'Scheduled forge',
    hub: 'creative',
    covers: 'The autonomous forge timer and its daily budget.',
    impact: 'Nothing is drafted overnight.',
    action: 'Check the forge schedule and daily limit in Forge Studio.',
    href: FORGE,
    evaluate: evaluateForge,
  }),
  snapshotProbe({
    id: 'orphaned-images',
    label: 'Orphaned generated images',
    hub: 'creative',
    covers: 'Generated image rows whose content document no longer exists.',
    impact: 'Blob storage holds images nothing shows.',
    action: 'Archive or delete them from the Image Gallery.',
    href: GALLERY,
    evaluate: evaluateOrphanedImages,
  }),
];

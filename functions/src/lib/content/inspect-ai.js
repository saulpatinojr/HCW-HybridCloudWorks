/**
 * inspect-ai.js — the two model calls of an inspection: the article's
 * analysis, and alt text for its images. Split out of inspect.js (which
 * re-exports the prompt and its builder) to keep each file short. Each
 * function takes the inspector's deps first.
 */
import { buildVoiceAndFormatBlock } from './voice.js';
import { errorCode } from '../http/error-response.js';

/** The provider values the analysis prompt allows; only these are logged (#1635). */
const LOGGABLE_PROVIDERS = new Set(['Azure', 'AWS', 'GCP', 'VMware', 'Ansible', 'GitHub', 'Terraform', 'FinOps', 'Docker', 'Multi']);

// The static system prompt — kept ≥1,024 tokens so Anthropic caches it.
export const ANALYSIS_SYSTEM_PROMPT = `You are a technical content analyst for Hybrid Cloud Works (HCW), a publication targeting senior cloud practitioners — architects, DevOps leads, FinOps analysts, and platform engineers — at enterprises operating multi-cloud or hybrid environments. Every article you produce must be technical, concrete, and actionable. Do not write introductory-level content.

Output schema (return ONLY valid JSON, no markdown fences, no prose):
{
  "title": "Article headline, max 100 chars. Be specific and search-optimised: prefer 'How to Optimize EKS Node Groups for Cost' over 'AWS Kubernetes Cost Tips'. Include the primary technology and action or outcome.",
  "summary": "Detailed overview, minimum 5-6 sentences (~600 characters). Identify: (1) the specific problem or trend the article addresses, (2) the primary technology or service discussed, (3) the key insight or takeaway, (4) who this is most relevant for, and (5) any important caveats or prerequisites. Do NOT repeat the title verbatim. Do NOT end with ellipsis (...).",
  "cloudProvider": "Primary provider. MUST be exactly one of: Azure, AWS, GCP, VMware, Ansible, GitHub, Terraform, FinOps, Docker, Multi. Azure, AWS, and GCP are cloud providers. VMware, Ansible, Terraform, and Docker are service providers. GitHub and FinOps are platform providers. Use 'Multi' only when the article explicitly compares two or more providers with roughly equal coverage. If primarily AWS but mentions Azure once, it is 'AWS'. GitHub Actions, Copilot, and GitHub-native CI/CD are 'GitHub'. Ansible Automation Platform, playbooks, and configuration automation are 'Ansible'. VMware Cloud Foundation, vSphere, NSX, and VMware by Broadcom are 'VMware'. Pulumi and CDK are 'Terraform' (IaC category). Docker is chosen only when Docker itself is the subject: Dockerfiles and image builds, Docker Desktop, Docker Compose, Docker Hub, Docker Scout, and Docker Sandboxes are 'Docker'. Containers that run on, or are deployed by, another provider belong to that provider: Docker images on Azure Container Apps are 'Azure', a GitHub Actions workflow that builds an image is 'GitHub', and a Terraform module that deploys containers is 'Terraform'.",
  "keyTopics": ["Array of 3-5 specific technology tags. Use precise names: 'AWS EKS' not 'Kubernetes'; 'Azure Cost Management' not 'cloud cost'; 'Terraform modules' not 'IaC'. Each tag should be independently searchable and usable as an article label."],
  "targetAudience": "Primary reader persona. MUST be exactly one of: Cloud Architect, DevOps Engineer, FinOps Analyst, Platform Engineer, Developer.",
  "visualTheme": "Describe a specific, concrete Lego-character scene in 20-30 words for the cover image. Good: 'A Lego cloud architect connecting modular database and compute blocks on a rack server with AWS orange accents'. Bad: 'cloud infrastructure concepts'. The description drives the image generation prompt, so specificity directly improves output quality.",
  "postContent": "A technical blog post formatted in clean Markdown, following the Voice and Format instructions provided separately below for structure, length, and tone — do not default to a generic open/three-sections/conclusion shape. Do NOT pad with generic cloud explanations. Write as if the reader is already a practitioner."
}

Classification rules:
- cloudProvider: see schema above. When in doubt between two providers, pick the one with more service-specific mentions.
- keyTopics: avoid generic terms. 'Cost optimisation' is too broad; 'Reserved Instances rightsizing' is correct. Cap at 5 topics.
- targetAudience: pick the role that benefits most from the article's primary action or insight, not the broadest possible audience.
- postContent: must be ready-to-publish Markdown with no placeholder text, no [INSERT X HERE] markers, and no incomplete sections.`;

export function buildAnalysisPrompt(url, markdownContent, metadataOnly) {
  const schemaForMode = metadataOnly
    ? `Extract the following fields and return ONLY valid JSON:
title, summary, cloudProvider, keyTopics, targetAudience, visualTheme.
Do NOT include a postContent field.`
    : `Extract all fields including postContent and return ONLY valid JSON.`;
  return `${schemaForMode}

Article URL: ${url}
Article Content:
${String(markdownContent || '').substring(0, 15000)}`;
}

/** The critique's issues as a clause for the system prompt; '' for a first draft. */
function revisionClauseOf(revisionIssues) {
  if (!Array.isArray(revisionIssues) || revisionIssues.length === 0) return '';
  return `\n\nThis is a revision of a draft an editorial critique pass rejected. Fix every issue below — do not just paraphrase around them:\n${revisionIssues.map((issue) => `- ${issue}`).join('\n')}`;
}

const loggableProvider = (metadata) =>
  LOGGABLE_PROVIDERS.has(metadata?.cloudProvider) ? metadata.cloudProvider : 'other';
const postContentChars = (metadata) =>
  typeof metadata?.postContent === 'string' ? metadata.postContent.length : undefined;

/**
 * The model's analysis of one article: its metadata and, unless the site is
 * set to metadata only, the post itself. `ctx` is the inspector's own deps.
 */
export async function analyzeArticle({ ai, env, log }, { url, markdownContent, cloudProvider, format, revisionIssues, signal }) {
  const only = env.CONTENTFORGE_METADATA_ONLY === 'true';
  const modelOverride = env.CONTENTFORGE_ANALYSIS_MODEL || null;
  // Recorded on the article and shown in the portal, so it has to be the
  // provider that actually served the call. Now that the portal can reorder
  // providers, a guess taken before the call can name a different one.
  const usage = [];
  const revisionClause = revisionClauseOf(revisionIssues);
  const systemPrompt = only
    ? ANALYSIS_SYSTEM_PROMPT
    : `${ANALYSIS_SYSTEM_PROMPT}\n\n${buildVoiceAndFormatBlock(cloudProvider, format)}${revisionClause}`;
  const prompt = buildAnalysisPrompt(url, markdownContent, only);

  log.log?.('[ai-model] article analysis starting', {
    metadataOnly: only,
    format: format?.key,
  });
  const metadata = await ai.generateJsonResponse({
    prompt,
    systemPrompt,
    model: modelOverride,
    purpose: 'analysis',
    usageOut: usage,
    feature: 'inspector',
    signal,
  });
  const aiProvider = usage.at(-1)?.provider || ai.getActiveAiProvider();
  log.log?.(`[ai-model] article analysis via ${aiProvider}`);
  // Fingerprint only — never the payload.
  log.log?.('[ai-model] analysis complete', {
    // No title: an article's words never reach a log line (#1635).
    hasTitle: typeof metadata?.title === 'string' && metadata.title.length > 0,
    // The model's answer, logged only when it is one of the values the
    // prompt allows; anything else is 'other' (#1635).
    cloudProvider: loggableProvider(metadata),
    postContentChars: postContentChars(metadata),
  });
  return {
    metadata,
    prompt,
    model: modelOverride || `${aiProvider}:default`,
    aiProvider,
    format: format?.key || null,
  };
}

/** Alt text for up to five images, only when CONTENTFORGE_ALT_TEXT_ENABLED=true. */
export async function generateAltTexts({ ai, env, log, fetchImpl, fetchImageImpl }, imageUrls, signal) {
  if (env.CONTENTFORGE_ALT_TEXT_ENABLED !== 'true') return {};
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) return {};
  const results = {};
  for (const url of imageUrls.slice(0, 5)) {
    if (signal?.aborted) throw signal.reason || new Error('aborted');
    try {
      // These URLs come from `scraped.images` — whatever page sourceUrl
      // pointed at — so they are attacker-influenced. Bare fetch performed no
      // protocol check, no private-range refusal, no timeout and no size cap,
      // while the repository already contained exactly the right primitive:
      // fetch-image.js validates the protocol, refuses localhost, resolves
      // the host to IPv4, refuses private ranges, and re-checks on every
      // redirect hop (T-734).
      const fetched = await fetchImageImpl(url, { fetch: fetchImpl });
      // A scraped `<img src>` that turns out to be a video gets no alt text
      // rather than being posted to a vision model as an image (#415). One
      // image skipped, the other four still described.
      if (fetched.refused) {
        // The refusal's code, never the image's address or the sentence (#1642).
        log.warn?.(`[alt-text] image skipped: ${fetched.refused}`);
        continue;
      }
      // The fetcher's gate guarantees a mapped `image/*` type, so this is
      // the measured type and there is no extension guess left to make.
      const { buffer, contentType: mimeType } = fetched;
      const altText = await ai.generateTextResponse({
        parts: [
          {
            text: 'Describe this image in one concise sentence suitable for an HTML alt attribute (max 125 characters). Focus on the visible subject and context. Do not start with "Image of" or "A photo of". Return only the description text, no quotes.',
          },
          { inlineData: { mimeType, data: buffer.toString('base64') } },
        ],
        purpose: 'multimodal',
        feature: 'altText',
        signal,
      });
      if (altText && altText.trim()) results[url] = altText.trim().slice(0, 125);
    } catch (error) {
      log.warn?.(`[alt-text] image failed: ${errorCode(error)}`);
    }
  }
  return results;
}

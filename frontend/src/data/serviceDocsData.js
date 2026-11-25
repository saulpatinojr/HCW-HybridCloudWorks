/**
 * serviceDocsData.js
 *
 * Documentation content for every AI provider and MCP server in the AI Engine.
 * Content is sourced from official documentation pages.
 *
 * Sources:
 *  Plaud MCP   — https://docs.plaud.ai/documentation/plaud_app/mcp
 *  Plaud CLI   — https://docs.plaud.ai/documentation/plaud_app/cli
 *  Anthropic   — https://docs.anthropic.com
 *  OpenAI      — https://platform.openai.com/docs
 *  NVIDIA API  — https://build.nvidia.com/models
 *  Foundry     — https://learn.microsoft.com/azure/foundry/
 *  Gemini API   — https://ai.google.dev/gemini-api/docs
 *  Azure OAI   — https://learn.microsoft.com/en-us/azure/ai-services/openai
 *  AWS Bedrock — https://docs.aws.amazon.com/bedrock/latest/userguide
 *  Firecrawl   — https://docs.firecrawl.dev
 *  Brave Search— https://api.search.brave.com/app/documentation
 *  Context7    — https://context7.com / https://github.com/upstash/context7
 *
 * Structure per entry:
 *  requirements  — prerequisites before starting
 *  hcwUses       — how HybridCloudWorks uses this service (matrix rows)
 *  sections      — install / use / uninstall / advanced (each has steps)
 *  references    — official source links at the bottom
 *
 * Each `step` in a section:
 *  { heading, body, codes: [{ lang, label, content }] }
 */

// ─── Shared helpers ───────────────────────────────────────────────────────────
const HCW_STATUS = { ACTIVE: 'active', AVAILABLE: 'available', PLANNED: 'planned' };

// ═════════════════════════════════════════════════════════════════════════════
export const SERVICE_DOCS = {
  // ── Claude (Anthropic) ───────────────────────────────────────────────────
  anthropic: {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    type: 'ai_provider',
    tagline: 'State-of-the-art AI by Anthropic — Opus, Sonnet, Haiku.',
    requirements: [
      {
        label: 'Anthropic account',
        detail: 'console.anthropic.com — free to create',
        required: true,
      },
      { label: 'API Key', detail: 'Generated in the Console → API Keys', required: true },
      {
        label: 'Billing enabled',
        detail: 'A payment method is required for API access',
        required: true,
      },
      {
        label: 'Node.js ≥ 18',
        detail: 'Only needed if using the Node SDK directly',
        required: false,
      },
    ],
    hcwUses: [
      {
        feature: 'ContentForge Pipeline',
        usage:
          'Draft generation, content analysis, and structured JSON extraction when CONTENTFORGE_AI_PROVIDER=anthropic',
        files: ['functions/lib/ai-model-router.js'],
        status: HCW_STATUS.AVAILABLE,
      },
      {
        feature: 'AI Engine Playground',
        usage: 'Interactive testing of all Claude models',
        files: ['src/pages/admin/AIEnginePage.jsx', 'functions/index.js (aiProxy)'],
        status: HCW_STATUS.AVAILABLE,
      },
      {
        feature: 'Social Caption Generation',
        usage:
          'AI-generated social media captions via generateSocialCaption (backend function, to be implemented)',
        files: ['src/components/admin/social/ComposeTab.jsx'],
        status: HCW_STATUS.PLANNED,
      },
    ],
    sections: {
      install: {
        title: 'Install & Configure',
        steps: [
          {
            heading: '1. Create an Anthropic account',
            body: 'Sign up at console.anthropic.com. Billing must be enabled before any API calls will succeed — add a payment method under Billing → Payment methods.',
            codes: [],
          },
          {
            heading: '2. Generate an API key',
            body: 'In the Anthropic Console go to API Keys → Create Key. Give it a descriptive name (e.g. "HCW Production"). Copy the key — it is only shown once.',
            codes: [],
          },
          {
            heading: '3. Configure the provider key',
            body: 'For local Azure Functions development, add the key to functions/.env. Production uses an Azure Function App setting backed by Key Vault. Never commit the local file or expose the key to the browser.',
            codes: [
              {
                lang: 'bash',
                label: 'functions/.env',
                content: 'ANTHROPIC_API_KEY=sk-ant-api03-...',
              },
            ],
          },
          {
            heading: '4. (Optional) Make Anthropic the default ContentForge provider',
            body: 'The project defaults to Gemini (Google AI). To switch, change the provider env var and restart your Azure Functions emulator.',
            codes: [
              {
                lang: 'bash',
                label: 'functions/.env',
                content:
                  'CONTENTFORGE_AI_PROVIDER=anthropic\nCONTENTFORGE_ANTHROPIC_DRAFT_MODEL=claude-sonnet-4-6\nCONTENTFORGE_ANTHROPIC_ANALYSIS_MODEL=claude-sonnet-4-6',
              },
            ],
          },
          {
            heading: '5. Enable in AI Engine',
            body: 'Go to /admin/ai-engine → AI Services → Claude (Anthropic) → toggle On → click Test. A green "Connected" badge confirms the key works.',
            codes: [],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Available models',
            body: 'Choose based on your cost/quality trade-off. Sonnet is the recommended default for most HCW tasks.',
            codes: [
              {
                lang: 'text',
                label: 'Model reference',
                content:
                  'claude-opus-4-6          — Most capable. Best for complex analysis. ~$15/1M in, $75/1M out\n' +
                  'claude-sonnet-4-6        — Balanced speed/quality. Recommended default. ~$3/1M in, $15/1M out\n' +
                  'claude-haiku-4-5-20251001— Fastest and cheapest. Good for short tasks. ~$0.80/1M in, $4/1M out',
              },
            ],
          },
          {
            heading: 'Via the AI Engine Playground',
            body: 'Navigate to /admin/ai-engine → Playground → select "Claude (Anthropic)" and your model. Write a system prompt and user message, then click Send. Token counts and estimated cost are shown after each response.',
            codes: [],
          },
          {
            heading: 'Direct API call (for custom Functions)',
            body: 'Use the existing callProvider() helper from the AI router inside any Azure Function.',
            codes: [
              {
                lang: 'js',
                label: 'functions/index.js (example)',
                content:
                  "const { callProvider } = require('./lib/ai-model-router');\n\n" +
                  'const result = await callProvider({\n' +
                  "  provider: 'anthropic',\n" +
                  "  model: 'claude-sonnet-4-6',\n" +
                  "  prompt: 'Summarize this article in 3 bullet points.',\n" +
                  "  systemPrompt: 'You are a helpful content editor.',\n" +
                  '});\n\n' +
                  'console.log(result.text);',
              },
            ],
          },
          {
            heading: 'Prompt caching (automatic)',
            body: 'The callAnthropic() implementation in ai-model-router.js automatically applies Anthropic prompt caching to large system prompts using the ephemeral cache_control type. Cached tokens cost 10% of the normal input price.',
            codes: [],
          },
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          {
            heading: 'Disable in AI Engine',
            body: 'Go to /admin/ai-engine → AI Services → Claude (Anthropic) → toggle Off. This prevents the provider from being used in the Playground.',
            codes: [],
          },
          {
            heading: 'Remove the API key',
            body: 'Remove the ANTHROPIC_API_KEY local setting and its Azure Function App setting / Key Vault reference, then restart the Function App and revoke the key in the Anthropic Console.',
            codes: [
              {
                lang: 'bash',
                label: 'functions/.env — remove this line',
                content: '# ANTHROPIC_API_KEY=sk-ant-...',
              },
            ],
          },
          {
            heading: 'Revoke the key in Console',
            body: 'For security, also revoke the key in the Anthropic Console → API Keys → Delete.',
            codes: [],
          },
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          {
            heading: 'Extended context (200K tokens)',
            body: 'All Claude 3+ models support 200K token context windows. The current callAnthropic() implementation sets max_tokens: 4096 for output — increase this for longer completions.',
            codes: [
              {
                lang: 'js',
                label: 'functions/lib/ai-model-router.js — adjust max_tokens',
                content: "max_tokens: 8192,  // increase up to model's output limit",
              },
            ],
          },
          {
            heading: 'Streaming responses',
            body: "The current implementation uses non-streaming mode. For real-time output in the UI, implement streaming using the Anthropic SDK's stream() method.",
            codes: [
              {
                lang: 'js',
                label: 'Streaming example (SDK)',
                content:
                  "import Anthropic from '@anthropic-ai/sdk';\n\n" +
                  'const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });\n\n' +
                  'const stream = client.messages.stream({\n' +
                  "  model: 'claude-sonnet-4-6',\n" +
                  '  max_tokens: 1024,\n' +
                  "  messages: [{ role: 'user', content: 'Hello' }],\n" +
                  '});\n\n' +
                  'for await (const chunk of stream) {\n' +
                  "  process.stdout.write(chunk.delta?.text ?? '');\n" +
                  '}',
              },
            ],
          },
          {
            heading: 'Rate limits',
            body: 'Anthropic rate limits are per API key and scale with your usage tier. Tier 1 (new accounts) starts at 50,000 TPM (tokens per minute). The ai-model-router.js withRetry() function handles 429 rate-limit errors automatically with exponential backoff.',
            codes: [],
          },
        ],
      },
    },
    references: [
      { label: 'Anthropic API Documentation', url: 'https://docs.anthropic.com' },
      {
        label: 'Claude Models Overview',
        url: 'https://docs.anthropic.com/en/docs/about-claude/models/overview',
      },
      { label: 'Anthropic Console', url: 'https://console.anthropic.com' },
      {
        label: 'Prompt Caching Guide',
        url: 'https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching',
      },
    ],
  },

  // ── Gemini (Google AI) ───────────────────────────────────────────────────
  gemini: {
    id: 'gemini',
    name: 'Gemini (Google AI)',
    type: 'ai_provider',
    tagline: "Google's Gemini models through the public Generative Language API.",
    requirements: [
      {
        label: 'Google AI Studio API key',
        detail: 'Create a key at aistudio.google.com/app/apikey',
        required: true,
      },
      {
        label: 'Azure Function App setting',
        detail: 'Production uses a Key Vault reference for GEMINI_API_KEY',
        required: true,
      },
      {
        label: 'Entra admin access',
        detail: 'Required to use the authenticated AI Engine routes',
        required: true,
      },
      {
        label: 'Local Azure Functions environment',
        detail: 'Use functions/.env for local development only',
        required: true,
      },
    ],
    hcwUses: [
      {
        feature: 'ContentForge Pipeline',
        usage:
          'Primary text provider for draft, analysis, and multimodal operations when enabled (CONTENTFORGE_AI_PROVIDER=gemini)',
        files: ['functions/src/lib/ai/router.js'],
        status: HCW_STATUS.ACTIVE,
      },
      {
        feature: 'Cover Image Generation',
        usage: 'Imagen 4 (google/imagen-4-fast) generates article cover images via Replicate',
        files: ['functions/src/lib/triggers/ai-cover.js'],
        status: HCW_STATUS.ACTIVE,
      },
      {
        feature: 'AI Engine Playground',
        usage: 'Available through the authenticated Azure aiProxy route',
        files: ['functions/src/lib/ai/proxy.js'],
        status: HCW_STATUS.ACTIVE,
      },
      {
        feature: 'createContentFromRecording',
        usage:
          'Turns a Plaud transcript into a ContentForge draft through the shared drafter and the createContentItem write path, then marks the recording routed (issue #180).',
        files: [
          'functions/src/lib/content/draft-from-recording.js',
          'frontend/src/components/admin/recording-hub/RecordingsTab.jsx',
        ],
        status: HCW_STATUS.ACTIVE,
      },
    ],
    sections: {
      install: {
        title: 'Configure',
        steps: [
          {
            heading: 'Create the API key',
            body: 'Create a Google AI Studio API key. Do not put it in browser code, source control, or the Admin Portal configuration document.',
            codes: [],
          },
          {
            heading: 'Configure local development',
            body: 'For local Azure Functions development only, add the key to functions/.env. This file is ignored by git and is not a production secret store.',
            codes: [
              {
                lang: 'bash',
                label: 'functions/.env',
                content: 'GEMINI_API_KEY=replace-with-your-key\nCONTENTFORGE_AI_PROVIDER=gemini',
              },
            ],
          },
          {
            heading: 'Configure production',
            body: 'Set GEMINI_API_KEY as an Azure Function App setting backed by Azure Key Vault, then restart the Function App. The browser calls Azure Functions and never receives the key.',
            codes: [
              {
                lang: 'bash',
                label: 'Azure CLI pattern',
                content:
                  'az functionapp config appsettings set \\\n  --name <function-app> \\\n  --resource-group <resource-group> \\\n  --settings GEMINI_API_KEY="@Microsoft.KeyVault(SecretUri=<secret-uri>)"',
              },
            ],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Available models',
            body: 'The Admin Portal seeds the current Gemini model list. Select a model in AI Engine, or let the router use its purpose-specific defaults.',
            codes: [
              {
                lang: 'text',
                label: 'Model reference',
                content:
                  'gemini-3.5-flash-lite — default low-cost model\n' +
                  'gemini-3.6-flash      — default analysis and multimodal model\n' +
                  'gemini-2.5-pro        — higher-quality reasoning option',
              },
            ],
          },
          {
            heading: 'Use the AI Engine Playground',
            body: 'Navigate to /admin/ai-engine → AI Services or Playground → select "Gemini (Google AI)" → choose a model → click Test or Send. Requests are authenticated with Entra and proxied by Azure Functions.',
            codes: [
              {
                lang: 'bash',
                label: 'Routing note',
                content:
                  'The browser calls Azure Functions; provider credentials and usage logging remain server-side.',
              },
            ],
          },
          {
            heading: 'Route a recording',
            body: 'Pick a content type and send. The transcript goes through the same drafter as Generate Article Draft, with instructions for the chosen type; the draft lands in the editor as a recording-sourced item and the recording is marked routed with its content id. The provider shown in the request is a hint only: the AI router picks by configured order and the draft records which provider ran.',
            codes: [],
          },
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          {
            heading: 'Disable in AI Engine',
            body: 'Turn Gemini off or change the provider order in /admin/ai-engine. The Azure API honors the stored provider configuration on every request.',
            codes: [],
          },
          {
            heading: 'Remove the production secret',
            body: 'Remove the GEMINI_API_KEY Function App setting or Key Vault reference, then restart the Function App and revoke the key in Google AI Studio.',
            codes: [],
          },
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          {
            heading: 'Multimodal input (images in prompts)',
            body: 'Use the shared Azure Function AI router with the parts parameter for image or other supported inline content. This keeps retries, usage logging, and provider errors consistent.',
            codes: [
              {
                lang: 'js',
                label: 'Multimodal call via generateJsonResponse()',
                content:
                  'const result = await generateJsonResponse({\n' +
                  "  prompt: 'Describe this image.',\n" +
                  "  parts: [{ inlineData: { mimeType: 'image/jpeg', data: base64String } }],\n" +
                  "  purpose: 'multimodal',\n" +
                  '});',
              },
            ],
          },
          {
            heading: 'Provider safety and limits',
            body: 'The public Gemini API applies provider safety controls. Use the shared Azure Function router so authentication, retries, usage logging, and error handling remain centralized.',
            codes: [],
          },
          {
            heading: 'Safety settings',
            body: 'Adjust safety thresholds if the model blocks legitimate content. Use with caution in production.',
            codes: [],
          },
        ],
      },
    },
    references: [
      {
        label: 'Gemini API Documentation',
        url: 'https://ai.google.dev/gemini-api/docs',
      },
      {
        label: 'Google AI Studio',
        url: 'https://aistudio.google.com/app/apikey',
      },
    ],
  },

  // ── OpenAI ───────────────────────────────────────────────────────────────
  openai: {
    id: 'openai',
    name: 'OpenAI',
    type: 'ai_provider',
    tagline: 'GPT-5 mini and nano through the OpenAI Platform API.',
    requirements: [
      {
        label: 'OpenAI API key',
        detail: 'Create a key at platform.openai.com/api-keys',
        required: true,
      },
      {
        label: 'Azure Function App setting',
        detail: 'Production uses a Key Vault reference for OPENAI_API_KEY (secret OPENAI-API-KEY)',
        required: true,
      },
      {
        label: 'Entra admin access',
        detail: 'Required to use the authenticated AI Engine routes',
        required: true,
      },
      {
        label: 'Local Azure Functions environment',
        detail: 'Use functions/.env for local development only',
        required: true,
      },
    ],
    hcwUses: [
      {
        feature: 'ContentForge Pipeline',
        usage:
          'Second provider in the default order (Gemini, OpenAI, Anthropic, then NVIDIA as the content backup): serves a call when the provider before it cannot, or first where Routing or Where AI is used places it first.',
        files: ['functions/src/lib/ai/router.js', 'functions/src/lib/ai/ai-config.js'],
        status: HCW_STATUS.ACTIVE,
      },
      {
        feature: 'AI Engine Playground and Test',
        usage:
          'Available through the authenticated Azure aiProxy and testAiProvider routes; the weekly probe runs the Test every Monday at 06:15 UTC and records the latency on the card.',
        files: ['functions/src/lib/ai/proxy.js', 'functions/src/lib/timers/ai-provider-probe.js'],
        status: HCW_STATUS.ACTIVE,
      },
    ],
    sections: {
      install: {
        title: 'Configure',
        steps: [
          {
            heading: 'Create the API key',
            body: 'Create a key at platform.openai.com/api-keys. Do not put it in browser code, source control, or the Admin Portal configuration document.',
            codes: [],
          },
          {
            heading: 'Configure local development',
            body: 'For local Azure Functions development only, add the key to functions/.env. This file is ignored by git and is not a production secret store. The command prompts for the key and never shows it.',
            codes: [
              {
                lang: 'powershell',
                label: 'Append to functions/.env (repository root)',
                content:
                  '$k = Read-Host -AsSecureString "OpenAI key"; Add-Content -Path functions/.env -Value ("OPENAI_API_KEY=" + [System.Net.NetworkCredential]::new("", $k).Password)',
              },
            ],
          },
          {
            heading: 'Configure production',
            body: 'Seed OPENAI-API-KEY in Key Vault with the seeding script; the Function App setting OPENAI_API_KEY is a Key Vault reference Terraform manages. Restart the Function App to pick the value up at once. The browser calls Azure Functions and never receives the key.',
            codes: [
              {
                lang: 'powershell',
                label: 'Seed the secret (repository root)',
                content: './scripts/cutover/06-seed-secret.ps1 -Name OPENAI-API-KEY',
              },
            ],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Available models',
            body: 'The Admin Portal seeds the current model list. Select a model on the card to pin it for every purpose, or leave Auto so the router uses its purpose defaults.',
            codes: [
              {
                lang: 'text',
                label: 'Model reference',
                content:
                  "gpt-5-mini  — the card's default\n" +
                  'gpt-5-nano  — lower cost, shorter answers\n' +
                  'gpt-4o      — the previous generation, still offered\n' +
                  'gpt-4o-mini — the previous generation, small',
              },
            ],
          },
          {
            heading: 'Use the AI Engine Playground',
            body: 'Navigate to /admin/ai-engine → AI Services or Playground → select "OpenAI" → choose a model → click Test or Send. Requests are authenticated with Entra and proxied by Azure Functions.',
            codes: [],
          },
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          {
            heading: 'Disable in AI Engine',
            body: 'Turn OpenAI off or change the provider order in /admin/ai-engine. The Azure API honors the stored provider configuration on every request.',
            codes: [],
          },
          {
            heading: 'Remove the production secret',
            body: 'Remove the OPENAI-API-KEY secret from Key Vault, restart the Function App, and revoke the key at platform.openai.com. With no key the router treats the provider as absent and the others serve as before.',
            codes: [],
          },
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          {
            heading: 'Reasoning models, max_tokens and temperature',
            body: "OpenAI's reasoning models refuse the max_tokens field and any temperature but the default, so the router sends neither to OpenAI; the per-call cap the portal's Test passes applies only to providers whose table row sends one.",
            codes: [],
          },
          {
            heading: 'JSON responses',
            body: 'JSON generation asks this provider for response_format json_object, with one repair round trip if the answer does not parse.',
            codes: [],
          },
        ],
      },
    },
    references: [
      {
        label: 'OpenAI Platform documentation',
        url: 'https://platform.openai.com/docs',
      },
      {
        label: 'API keys',
        url: 'https://platform.openai.com/api-keys',
      },
    ],
  },

  // ── NVIDIA API ───────────────────────────────────────────────────────────
  nvidia: {
    id: 'nvidia',
    name: 'NVIDIA API',
    type: 'ai_provider',
    tagline:
      'Open-weight models on the NVIDIA API Catalog: a free trial tier at about 40 requests a minute.',
    requirements: [
      {
        label: 'NVIDIA API Catalog key',
        detail:
          'An nvapi- key from build.nvidia.com/settings/api-keys; read the trial terms before seeding',
        required: true,
      },
      {
        label: 'Azure Function App setting',
        detail: 'Production uses a Key Vault reference for NVIDIA_API_KEY (secret NVIDIA-API-KEY)',
        required: true,
      },
      {
        label: 'Entra admin access',
        detail: 'Required to use the authenticated AI Engine routes',
        required: true,
      },
      {
        label: 'Local Azure Functions environment',
        detail: 'Use functions/.env for local development only',
        required: true,
      },
    ],
    hcwUses: [
      {
        feature: 'ContentForge Pipeline',
        usage:
          'The backup for owner-triggered content (drafting, grading, the inspector, captions, Listen & Learn and podcast scripts) after the paid providers, unless Routing or Where AI is used places it first. Never used for the anonymous public explain route, and a call that names no feature never uses it.',
        files: ['functions/src/lib/ai/router.js', 'functions/src/lib/ai/ai-config.js'],
        status: HCW_STATUS.ACTIVE,
      },
      {
        feature: 'AI Engine Test and the weekly probe',
        usage:
          "The card's Test and the Monday 06:15 UTC probe record its latency; the probe is the evidence for placing it first for a feature.",
        files: ['functions/src/lib/ai/proxy.js', 'functions/src/lib/timers/ai-provider-probe.js'],
        status: HCW_STATUS.ACTIVE,
      },
    ],
    sections: {
      install: {
        title: 'Configure',
        steps: [
          {
            heading: 'Create the API key',
            body: 'Generate one key at build.nvidia.com/settings/api-keys. Do not put it in browser code, source control, or the Admin Portal configuration document.',
            codes: [],
          },
          {
            heading: 'Configure local development',
            body: 'For local Azure Functions development only, add the key to functions/.env. This file is ignored by git and is not a production secret store. The command prompts for the key and never shows it.',
            codes: [
              {
                lang: 'powershell',
                label: 'Append to functions/.env (repository root)',
                content:
                  '$k = Read-Host -AsSecureString "NVIDIA key"; Add-Content -Path functions/.env -Value ("NVIDIA_API_KEY=" + [System.Net.NetworkCredential]::new("", $k).Password)',
              },
            ],
          },
          {
            heading: 'Configure production',
            body: 'Seed NVIDIA-API-KEY in Key Vault with the seeding script; the Function App setting NVIDIA_API_KEY is a Key Vault reference Terraform manages. Restart the Function App to pick the value up at once.',
            codes: [
              {
                lang: 'powershell',
                label: 'Seed the secret (repository root)',
                content: './scripts/cutover/06-seed-secret.ps1 -Name NVIDIA-API-KEY',
              },
            ],
          },
          {
            heading: 'Wait before judging a fresh key',
            body: 'A freshly seeded key can answer "403 Authorization failed" from the app for up to about 40 minutes, the same reply a wrong key gets. Measured 2026-10-04: the app refused a key at 1, 12 and 13 minutes after seeding and accepted it at 37; a workstation accepted that same key at about 23 minutes; a separate key seconds old passed at once from Azure Cloud Shell. Test again later before reseeding, and delete the previous key at NVIDIA only after the new one passes from here.',
            codes: [],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Available models',
            body: 'The router uses GLM-5.3 for every purpose. The two "flash" models stay priced for an override, but on the trial tier they were the slow ones: 70 s and more than 120 s to answer one line, against 2.6 s for GLM-5.3.',
            codes: [
              {
                lang: 'text',
                label: 'Model reference',
                content:
                  'z-ai/glm-5.3                     — the default for every purpose\n' +
                  'z-ai/glm-5.3-flash               — CONTENTFORGE_NVIDIA_*_MODEL override only\n' +
                  'deepseek-ai/deepseek-v4.1-flash  — CONTENTFORGE_NVIDIA_*_MODEL override only',
              },
            ],
          },
          {
            heading: 'Use the AI Engine Playground',
            body: 'Navigate to /admin/ai-engine → AI Services or Playground → select "NVIDIA API" → click Test or Send. The Test caps max_tokens and the timeout so a reasoning model proves it answers in seconds rather than thinking past the edge limit.',
            codes: [],
          },
          {
            heading: 'Pacing',
            body: 'The router keeps each instance under the account limit (36 requests a minute by default; NVIDIA_REQUESTS_PER_MINUTE overrides). A call the guard refuses is not sent and fails over to the next provider at once, so a burst of batch drafts degrades to the paid providers instead of failing.',
            codes: [],
          },
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          {
            heading: 'Disable in AI Engine',
            body: 'Turn NVIDIA off, or change its placement under Where AI is used, in /admin/ai-engine. The Azure API honors the stored configuration on every request.',
            codes: [],
          },
          {
            heading: 'Remove the production secret',
            body: 'Remove the NVIDIA-API-KEY secret from Key Vault, restart the Function App, and delete the key at build.nvidia.com. With no key the router treats the provider as absent and the paid providers serve as before.',
            codes: [],
          },
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          {
            heading: 'Text only',
            body: 'A call carrying an image is routed past this provider rather than refused by it; the next provider in the chain takes it.',
            codes: [],
          },
          {
            heading: 'Failover on 400 and 422',
            body: 'A bad request from this provider fails over, unlike the three frontier APIs: the catalogue models have their own context and parameter limits, and the next provider will very likely take the same request. A prompt part the router rejected locally before sending (AI_PART_REFUSED) does not fail over.',
            codes: [],
          },
          {
            heading: 'Cost and output',
            body: "Usage rows are priced at zero so the Usage tab shows the calls and the saving. A <think> block in an answer is stripped before the text reaches the caller. Model ids are the `model` value in each page's curl sample, which is not always the URL slug.",
            codes: [],
          },
        ],
      },
    },
    references: [
      {
        label: 'NVIDIA API Catalog models',
        url: 'https://build.nvidia.com/models',
      },
      {
        label: 'API keys',
        url: 'https://build.nvidia.com/settings/api-keys',
      },
    ],
  },

  // ── Microsoft Foundry ────────────────────────────────────────────────────
  foundry: {
    id: 'foundry',
    name: 'Microsoft Foundry',
    type: 'ai_provider',
    tagline: 'GPT-5 nano and mini on an Azure account the estate owns, paid, under its own budget.',
    requirements: [
      {
        label: 'Terraform applied',
        detail:
          'infra/foundry.tf creates the account, the two deployments, the role for the app and the budget; the owner applies it through TFC',
        required: true,
      },
      {
        label: 'Azure Function App setting',
        detail: 'FOUNDRY_ENDPOINT, written by Terraform from the account; nothing is seeded',
        required: true,
      },
      {
        label: 'Entra admin access',
        detail: 'Required to use the authenticated AI Engine routes',
        required: true,
      },
    ],
    hcwUses: [
      {
        feature: 'ContentForge Pipeline',
        usage:
          'First for the content features the owner triggers (drafting, grading, the inspector, captions, alt text, Listen & Learn and podcast scripts), unless Where AI is used places it otherwise. Locked off the anonymous public explain route and the grounded call.',
        files: ['functions/src/lib/ai/router.js', 'functions/src/lib/ai/features-catalogue.js'],
        status: HCW_STATUS.ACTIVE,
      },
      {
        feature: 'AI Engine Test and the weekly probe',
        usage:
          "The card's Test and the Monday 06:15 UTC probe record its latency; Usage & Cost prices every call at the Global Standard rates.",
        files: ['functions/src/lib/ai/proxy.js', 'functions/src/lib/timers/ai-provider-probe.js'],
        status: HCW_STATUS.ACTIVE,
      },
    ],
    sections: {
      install: {
        title: 'Configure',
        steps: [
          {
            heading: 'Apply the Terraform',
            body: "infra/foundry.tf declares the AIServices account (local authentication off), the gpt-5-nano and gpt-5-mini deployments, the Cognitive Services OpenAI User role for the Function App identity, and a USD 75 monthly budget on the ai resource group. The TFC run is the owner's; after it, FOUNDRY_ENDPOINT is on the Function App and the card reads Connected after Test.",
            codes: [],
          },
          {
            heading: 'Local development',
            body: 'With no FOUNDRY_API_KEY, the router asks @azure/identity for a token, which on a workstation is the az login session; that account needs Cognitive Services OpenAI User on the resource. A developer with a Foundry account of their own can set FOUNDRY_ENDPOINT and FOUNDRY_API_KEY in functions/.env instead. The command prompts for the key and never shows it.',
            codes: [
              {
                lang: 'powershell',
                label: 'Append to functions/.env (repository root)',
                content:
                  '$k = Read-Host -AsSecureString "Foundry key"; Add-Content -Path functions/.env -Value ("FOUNDRY_API_KEY=" + [System.Net.NetworkCredential]::new("", $k).Password)',
              },
            ],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Available models',
            body: 'The deployment names are the model names. Leave the card on Auto and the router uses mini for drafts and analysis and nano for short calls; pick one to pin it for every purpose.',
            codes: [
              {
                lang: 'text',
                label: 'Model reference (USD per 1M tokens, Global Standard, 2026-10-04)',
                content:
                  'gpt-5-nano — $0.05 in / $0.40 out; short calls and captions\n' +
                  'gpt-5-mini — $0.25 in / $2.00 out; drafts, grading, analysis',
              },
            ],
          },
          {
            heading: 'Use the AI Engine Playground',
            body: 'Navigate to /admin/ai-engine → AI Services or Playground → select "Microsoft Foundry" → click Test or Send. Requests are authenticated with Entra and proxied by Azure Functions, which signs in to Foundry with its own identity.',
            codes: [],
          },
          {
            heading: 'Watch the budget',
            body: 'The Foundry resource group has its own Cost Management budget of USD 75 a month, with alerts at 50, 90 and 100 % actual and 100 % forecast to the ops action group. A budget alerts; it does not stop spend, so the response to an alert is to turn the provider off here. The Usage & Cost tab prices each call from the same rates.',
            codes: [],
          },
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          {
            heading: 'Disable in AI Engine',
            body: 'Turn Foundry off, or change its placement under Where AI is used, in /admin/ai-engine. The Azure API honors the stored configuration on every request.',
            codes: [],
          },
          {
            heading: 'Remove the account',
            body: 'Remove foundry.tf and the FOUNDRY_ENDPOINT setting and apply; with no endpoint the router treats the provider as absent and the others serve as before. There is no key to revoke.',
            codes: [],
          },
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          {
            heading: 'Token, not key',
            body: 'The router fetches an Entra token for https://ai.azure.com/.default (the audience the Foundry v1 endpoint documents; the FOUNDRY_TOKEN_SCOPE app setting overrides it) through @azure/identity and reuses it until five minutes before expiry. A 401 or 403 from Foundry therefore means the role assignment or the audience, not a secret: check that the Function App identity holds Cognitive Services OpenAI User on the account.',
            codes: [],
          },
          {
            heading: 'Reasoning models, max_tokens and temperature',
            body: 'GPT-5 deployments refuse the max_tokens field and any temperature but the default (400, "Only the default (1) value is supported"), so the row sends neither, as for OpenAI; JSON generation asks for response_format json_object with one repair round trip.',
            codes: [],
          },
        ],
      },
    },
    references: [
      {
        label: 'Microsoft Foundry documentation',
        url: 'https://learn.microsoft.com/azure/foundry/',
      },
      {
        label: 'Azure OpenAI pricing',
        url: 'https://azure.microsoft.com/pricing/details/azure-openai/',
      },
    ],
  },

  // ── Azure OpenAI ─────────────────────────────────────────────────────────
  azure: {
    id: 'azure',
    name: 'Microsoft Azure OpenAI',
    type: 'ai_provider',
    tagline: 'GPT-4o via Azure — enterprise-grade with data residency and compliance.',
    requirements: [
      {
        label: 'Azure subscription',
        detail: 'azure.microsoft.com — free trial gives $200 credit',
        required: true,
      },
      {
        label: 'Azure OpenAI resource',
        detail: 'Created in Azure Portal → AI Services → Azure OpenAI',
        required: true,
      },
      {
        label: 'Model deployment',
        detail: 'Deploy gpt-4o in Azure OpenAI Studio → Deployments',
        required: true,
      },
      {
        label: 'API Key + Endpoint URL',
        detail: 'Both found in your Azure OpenAI resource → Keys and Endpoint',
        required: true,
      },
    ],
    hcwUses: [
      {
        feature: 'AI Engine Playground',
        usage:
          'GPT-4o via enterprise Azure endpoint — for testing Microsoft Copilot-equivalent capabilities',
        files: ['functions/index.js (aiProxy)'],
        status: HCW_STATUS.AVAILABLE,
      },
    ],
    sections: {
      install: {
        title: 'Install & Configure',
        steps: [
          {
            heading: '1. Create an Azure OpenAI resource',
            body: 'In the Azure Portal, go to Create a resource → AI + Machine Learning → Azure OpenAI. Select a region (East US or Sweden Central recommended for latest models). The resource creation takes a few minutes.',
            codes: [],
          },
          {
            heading: '2. Deploy a model',
            body: 'In Azure OpenAI Studio (oai.azure.com), go to Deployments → Create new deployment. Select gpt-4o and give it a deployment name (e.g. "gpt-4o-prod"). Note the deployment name — it is used in API calls.',
            codes: [],
          },
          {
            heading: '3. Get your endpoint and key',
            body: 'In the Azure Portal, open your Azure OpenAI resource → Keys and Endpoint. Copy Key 1 and the Endpoint URL.',
            codes: [],
          },
          {
            heading: '4. Configure the provider settings',
            body: 'For local Azure Functions development, set all three variables in functions/.env. Production uses Azure Function App settings / Key Vault. The AZURE_OPENAI_DEPLOYMENT value must exactly match the deployment name you created in step 2.',
            codes: [
              {
                lang: 'bash',
                label: 'functions/.env',
                content:
                  'AZURE_OPENAI_API_KEY=your_azure_key_here\n' +
                  'AZURE_OPENAI_ENDPOINT=https://your-resource-name.openai.azure.com\n' +
                  'AZURE_OPENAI_DEPLOYMENT=gpt-4o-prod',
              },
            ],
          },
          {
            heading: '5. Enable in AI Engine',
            body: 'Go to /admin/ai-engine → AI Services → Microsoft Azure OpenAI → toggle On → Test.',
            codes: [],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'API version',
            body: 'Azure OpenAI API versions are date-pinned. The current HCW implementation uses api-version=2024-02-01, which supports gpt-4o. Always pin to a stable version in production.',
            codes: [
              {
                lang: 'text',
                label: 'Endpoint format',
                content:
                  'https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version=2024-02-01',
              },
            ],
          },
          {
            heading: 'Via the AI Engine Playground',
            body: 'Select "Microsoft Azure OpenAI" — the model shown will be your configured deployment. The interface is identical to the OpenAI playground.',
            codes: [],
          },
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          {
            heading: 'Remove env vars and disable',
            body: 'Toggle off in AI Engine, remove the local AZURE_OPENAI_* settings and any Azure Function App / Key Vault settings, and optionally delete the Azure OpenAI resource in the Azure Portal to stop any charges.',
            codes: [],
          },
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          {
            heading: 'Content filtering policies',
            body: 'Azure applies content safety filters by default. Configure custom policies in Azure OpenAI Studio → Content filters if the defaults are too restrictive for technical content.',
            codes: [],
          },
          {
            heading: 'Managed identity (recommended for production)',
            body: 'Instead of an API key, use Azure Managed Identity to authenticate — no credentials in env vars.',
            codes: [
              {
                lang: 'js',
                label: 'Managed identity header',
                content:
                  "const { DefaultAzureCredential } = require('@azure/identity');\n" +
                  'const credential = new DefaultAzureCredential();\n' +
                  "const token = await credential.getToken('https://cognitiveservices.azure.com/.default');\n" +
                  "headers['Authorization'] = `Bearer ${token.token}`;\n" +
                  "// Remove 'api-key' header when using managed identity",
              },
            ],
          },
        ],
      },
    },
    references: [
      {
        label: 'Azure OpenAI Service Documentation',
        url: 'https://learn.microsoft.com/en-us/azure/ai-services/openai/',
      },
      { label: 'Azure OpenAI Studio', url: 'https://oai.azure.com' },
      {
        label: 'Supported Models by Region',
        url: 'https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models',
      },
    ],
  },

  // ── AWS Bedrock (Nova) ───────────────────────────────────────────────────
  bedrock: {
    id: 'bedrock',
    name: 'AWS Bedrock (Amazon Nova)',
    type: 'ai_provider',
    tagline: 'Amazon Nova models via Bedrock — extremely cost-effective inference.',
    requirements: [
      { label: 'AWS account', detail: 'aws.amazon.com — free tier available', required: true },
      {
        label: 'Bedrock model access',
        detail: 'Request access in AWS Console → Amazon Bedrock → Model access',
        required: true,
      },
      {
        label: 'IAM user with bedrock permission',
        detail: 'Policy: bedrock:InvokeModel on the Nova model ARNs',
        required: true,
      },
      {
        label: 'Access Key + Secret',
        detail: 'Generated in IAM → Users → Security credentials',
        required: true,
      },
    ],
    hcwUses: [
      {
        feature: 'AI Engine Playground',
        usage: 'Very low cost inference for bulk or experimental tasks — Nova Lite is near-free',
        files: ['functions/index.js (aiProxy)'],
        status: HCW_STATUS.AVAILABLE,
      },
    ],
    sections: {
      install: {
        title: 'Install & Configure',
        steps: [
          {
            heading: '1. Request model access in AWS Console',
            body: 'Amazon Nova models require explicit access requests. In the AWS Console go to Amazon Bedrock → Model access → Manage model access → check Amazon Nova Lite and Nova Pro → Save changes. Access is usually granted within minutes.',
            codes: [],
          },
          {
            heading: '2. Create an IAM user',
            body: 'In IAM → Users → Create user, attach the AmazonBedrockFullAccess policy or a scoped policy. Under Security credentials → Create access key, select "Application running outside AWS". Copy the Access Key ID and Secret.',
            codes: [],
          },
          {
            heading: '3. Create a scoped IAM policy (recommended)',
            body: 'For production, use a minimal policy rather than the full access policy.',
            codes: [
              {
                lang: 'json',
                label: 'IAM Policy (minimal)',
                content: JSON.stringify(
                  {
                    Version: '2012-10-17',
                    Statement: [
                      {
                        Effect: 'Allow',
                        Action: ['bedrock:InvokeModel'],
                        Resource: [
                          'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-micro-v1:0',
                          'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0',
                          'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0',
                        ],
                      },
                    ],
                  },
                  null,
                  2
                ),
              },
            ],
          },
          {
            heading: '4. Configure the provider credentials',
            body: 'For local Azure Functions development, use functions/.env. Production should use Azure Function App settings / Key Vault or the approved AWS credential federation path. Nova models are available in us-east-1 (and a few other regions).',
            codes: [
              {
                lang: 'bash',
                label: 'functions/.env',
                content:
                  'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n' +
                  'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n' +
                  'AWS_REGION=us-east-1',
              },
            ],
          },
          {
            heading: '5. Enable in AI Engine',
            body: 'Go to /admin/ai-engine → AI Services → AWS Bedrock (Nova) → toggle On → Test.',
            codes: [],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Available Nova models',
            body: 'All three Nova tiers are available. Nova Micro has no image understanding; Nova Lite and Pro support multimodal input.',
            codes: [
              {
                lang: 'text',
                label: 'Model reference',
                content:
                  'amazon.nova-micro-v1:0  — Text only. Cheapest. ~$0.035/1M in, $0.14/1M out\n' +
                  'amazon.nova-lite-v1:0   — Text + image. Fast. ~$0.06/1M in, $0.24/1M out\n' +
                  'amazon.nova-pro-v1:0    — Most capable Nova. ~$0.80/1M in, $3.20/1M out',
              },
            ],
          },
          {
            heading: 'No SDK required',
            body: "The SigV4 signing algorithm is implemented directly in ai-model-router.js using Node.js's built-in crypto module. No @aws-sdk packages are needed.",
            codes: [],
          },
          {
            heading: 'Nova message format',
            body: 'Nova uses a slightly different request body than OpenAI. The implementation in callAWSNova() handles this automatically.',
            codes: [
              {
                lang: 'json',
                label: 'Nova request body format',
                content: JSON.stringify(
                  {
                    messages: [{ role: 'user', content: [{ text: 'Hello!' }] }],
                    system: [{ text: 'You are a helpful assistant.' }],
                    inferenceConfig: { max_new_tokens: 2048, temperature: 0.2 },
                  },
                  null,
                  2
                ),
              },
            ],
          },
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          {
            heading: 'Remove credentials and disable',
            body: 'Toggle off in AI Engine, remove the local AWS settings and any production Function App / Key Vault configuration. In the AWS Console, deactivate or delete the IAM access key.',
            codes: [],
          },
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          {
            heading: 'Cross-region inference profiles',
            body: 'For higher throughput, use a cross-region inference profile instead of a direct model ID. This routes requests across multiple regions automatically.',
            codes: [
              {
                lang: 'bash',
                label: 'Cross-region profile ARN format',
                content:
                  'us.amazon.nova-lite-v1:0  # routes across US regions\neu.amazon.nova-lite-v1:0  # routes across EU regions',
              },
            ],
          },
          {
            heading: 'Bedrock Guardrails',
            body: 'Apply safety guardrails to all Nova calls via the GuardrailIdentifier and GuardrailVersion headers. Create guardrails in the Bedrock console.',
            codes: [],
          },
        ],
      },
    },
    references: [
      {
        label: 'Amazon Bedrock User Guide',
        url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/',
      },
      {
        label: 'Amazon Nova Model IDs',
        url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html',
      },
      {
        label: 'Bedrock InvokeModel API',
        url: 'https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html',
      },
    ],
  },

  // ── NotebookLM ───────────────────────────────────────────────────────────
  notebooklm: {
    id: 'notebooklm',
    name: 'NotebookLM (Google)',
    type: 'ai_provider',
    tagline: "Google's research assistant — no public API for the consumer product.",
    requirements: [
      { label: 'Google account', detail: 'notebooklm.google.com', required: true },
      {
        label: 'Public API',
        detail:
          'None for consumer NotebookLM (checked 2026-09-29). Gemini Notebook Enterprise has a v1alpha API that needs a Google Cloud project and a Gemini Enterprise licence',
        required: true,
      },
    ],
    hcwUses: [
      {
        feature: 'AI Engine',
        usage: 'Reserved slot — integration will be added when Google releases a public API',
        files: [],
        status: HCW_STATUS.PLANNED,
      },
    ],
    sections: {
      install: {
        title: 'Status',
        steps: [
          {
            heading: 'No public API',
            body: 'Checked 2026-09-29: consumer NotebookLM at notebooklm.google.com still has no public REST API or MCP server. Google’s enterprise edition, now called Gemini Notebook Enterprise, documents a v1alpha API for notebooks and their sources (docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/api-notebooks), which needs a Google Cloud project and a Gemini Enterprise licence. This slot stays reserved in the AI Engine until the consumer product opens programmatic access or HCW takes the enterprise licence.',
            codes: [],
          },
          {
            heading: 'Workaround — manual use',
            body: 'You can manually use NotebookLM by uploading HCW content (exported articles, transcripts) via the web interface. To connect it to HCW programmatically, check this page when a public API is announced.',
            codes: [],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Not yet available',
            body: 'No API integration possible until Google releases developer access.',
            codes: [],
          },
        ],
      },
      uninstall: { title: 'N/A', steps: [] },
      advanced: { title: 'N/A', steps: [] },
    },
    references: [
      { label: 'NotebookLM', url: 'https://notebooklm.google.com' },
      {
        label: 'NotebookLM Blog (stay updated)',
        url: 'https://blog.google/technology/ai/notebooklm-google-ai/',
      },
    ],
  },

  // ── Plaud MCP ────────────────────────────────────────────────────────────
  plaud: {
    id: 'plaud',
    name: 'Plaud (Voice Recordings)',
    type: 'mcp_server',
    tagline: 'Connect your Plaud recordings live — transcripts, AI notes, and search via MCP.',
    requirements: [
      { label: 'Plaud account', detail: 'plaud.ai — required for recordings', required: true },
      { label: 'Node.js ≥ 20', detail: 'For the MCP installer CLI', required: true },
      {
        label: 'OAuth token',
        detail: 'Generated via the MCP installer or Claude Web',
        required: true,
      },
    ],
    hcwUses: [
      {
        feature: 'Recording Hub — Plaud tab, Library',
        usage:
          'Live list of all recordings via list_files; load transcripts on demand via get_transcript',
        files: ['src/components/admin/recording-hub/RecordingsTab.jsx'],
        status: HCW_STATUS.ACTIVE,
      },
      {
        feature: 'Recording Hub — Plaud tab, Connect',
        usage: 'OAuth token setup and connection test',
        files: ['src/components/admin/recording-hub/RecordingsTab.jsx'],
        status: HCW_STATUS.ACTIVE,
      },
      {
        feature: 'ContentForge Pipeline',
        usage: 'Route a recording transcript into a content draft via createContentFromRecording',
        files: ['src/components/admin/recording-hub/RecordingsTab.jsx', 'functions/index.js'],
        status: HCW_STATUS.ACTIVE,
      },
      {
        feature: 'AI Engine Playground',
        usage:
          'Call Plaud tools (list_files, get_transcript, get_note) directly from the Playground',
        files: ['src/pages/admin/AIEnginePage.jsx'],
        status: HCW_STATUS.ACTIVE,
      },
    ],
    sections: {
      install: {
        title: 'Install & Connect',
        steps: [
          {
            heading: 'Option A — CLI installer (recommended)',
            body: 'Run the Plaud MCP installer. It auto-detects local AI clients (Claude Desktop, Cursor, VS Code), writes their MCP config, and opens your browser for OAuth authorization.',
            codes: [
              {
                lang: 'bash',
                label: 'Terminal (Node.js ≥ 20 required)',
                content: 'npx -y @plaud-ai/mcp@latest install',
              },
            ],
          },
          {
            heading: 'Option B — Claude Web connector',
            body: 'In Claude Web (claude.ai), go to Settings → Connectors → Add custom connector and fill in the form.',
            codes: [
              {
                lang: 'text',
                label: 'Claude Web connector settings',
                content:
                  'Name:                Plaud\nRemote MCP server URL: https://mcp.plaud.ai/mcp',
              },
            ],
          },
          {
            heading: 'Copy your OAuth access token',
            body: 'After the CLI install, your token is stored at ~/.plaud/tokens-mcp.json. Open the file and copy the access_token value.',
            codes: [
              {
                lang: 'bash',
                label: 'Terminal — view the token file',
                content: 'cat ~/.plaud/tokens-mcp.json',
              },
            ],
          },
          {
            heading: 'Paste the token in HCW',
            body: 'Go to /admin/recording-hub → Plaud tab → Connect → paste the token → Save & Test. The token is stored server-side in Cosmos DB and used by the Azure mcpProxy Function. It never returns to the browser after saving.',
            codes: [],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Available MCP tools',
            body: 'These tools are called by HCW via the Azure mcpProxy Function at https://mcp.plaud.ai/mcp.',
            codes: [
              {
                lang: 'text',
                label: 'Tool reference',
                content:
                  'list_files       — List recordings. Params: query, date_from (YYYY-MM-DD), date_to, page, page_size\n' +
                  'get_file         — Full recording details + 24h presigned audio URL. Params: id\n' +
                  'get_note         — AI summary, action items, key topics (Markdown). Params: id\n' +
                  'get_transcript   — Full transcript with timestamps and speaker labels. Params: id\n' +
                  'get_current_user — Your account details. No params.',
              },
            ],
          },
          {
            heading: 'Recording Hub — Plaud tab, Library',
            body: 'Once connected, navigate to /admin/recording-hub → Plaud tab → Library. Your recordings appear immediately. Search by keyword or date range, expand any card to read the transcript, click "Script this" to queue a podcast episode draft (it lands on the Podcast tab), or click "Create Content" to route a transcript through the ContentForge pipeline. The Upload sub-tab sends an audio file to the Plaud Embedded Transcription API — a separate key pair, seeded in Key Vault — and stores the transcript under Stored recordings.',
            codes: [],
          },
          {
            heading: 'Via the AI Engine Playground',
            body: 'Go to /admin/ai-engine → Playground → MCP Tool mode → select Plaud → list_files. Pass arguments as JSON.',
            codes: [
              {
                lang: 'json',
                label: 'list_files arguments example',
                content: JSON.stringify(
                  { query: 'standup', date_from: '2026-05-01', date_to: '2026-05-31' },
                  null,
                  2
                ),
              },
            ],
          },
          {
            heading: 'Plaud CLI (standalone terminal access)',
            body: 'You can also browse your recordings from the terminal without the HCW admin UI.',
            codes: [
              {
                lang: 'bash',
                label: 'Plaud CLI quick reference',
                content:
                  'npm install -g @plaud-ai/cli\n\n' +
                  'plaud login               # authorize via browser\n' +
                  'plaud files               # list recent recordings\n' +
                  'plaud search "Q2 review"  # search by keyword\n' +
                  'plaud transcript <id>     # read full transcript\n' +
                  'plaud summary <id>        # read AI summary\n' +
                  'plaud transcript <id> -o out.txt  # save to file',
              },
            ],
          },
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          {
            heading: 'Remove OAuth token from HCW',
            body: 'In /admin/ai-engine → MCP Servers → Plaud → toggle Off. To delete the stored token, clear the oauthToken field from the mcp_servers/plaud document in Cosmos DB.',
            codes: [],
          },
          {
            heading: 'Remove local CLI and token files',
            body: 'If you installed the CLI or MCP package, clean up with these commands.',
            codes: [
              {
                lang: 'bash',
                label: 'Full local cleanup',
                content:
                  '# Uninstall MCP package\nnpm uninstall -g @plaud-ai/mcp\n\n' +
                  '# Uninstall CLI package\nnpm uninstall -g @plaud-ai/cli\n\n' +
                  '# Remove local token files\nrm -rf ~/.plaud',
              },
            ],
          },
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          {
            heading: 'Token refresh',
            body: 'Plaud OAuth tokens expire. If the Library tab stops loading or you see 401 errors, re-run the installer (or re-authorize via Claude Web) and paste the new token in the Connect tab.',
            codes: [
              {
                lang: 'bash',
                label: 'Refresh MCP token',
                content:
                  'npx -y @plaud-ai/mcp@latest install\n# Re-authorize in browser, then copy the new access_token from ~/.plaud/tokens-mcp.json',
              },
            ],
          },
          {
            heading: 'Pagination for large libraries',
            body: 'list_files defaults to 20 recordings per page. Use page and page_size to navigate large libraries. Keyword search scans the 500 most recent recordings client-side.',
            codes: [
              {
                lang: 'json',
                label: 'Paginated list_files call',
                content: '{ "page": 2, "page_size": 50 }',
              },
            ],
          },
          {
            heading: 'Audio download',
            body: 'get_file returns a presigned_url for the audio file, valid for 24 hours. Use this to download recordings for external processing.',
            codes: [
              {
                lang: 'js',
                label: 'Download audio via presigned URL',
                content:
                  "const res = await aiEngine.mcpTool('plaud', 'get_file', { id: recordingId });\n" +
                  'const file = JSON.parse(res.result);\n' +
                  'const audioUrl = file.presigned_url;  // valid 24 hours\n' +
                  '// Use in an <audio> element or download with fetch()',
              },
            ],
          },
          {
            heading: 'Skills (pre-built prompt workflows)',
            body: 'The Plaud MCP includes built-in skills that trigger on natural language phrases inside AI clients like Claude Desktop.',
            codes: [
              {
                lang: 'text',
                label: 'Available skills',
                content:
                  'plaud-browse   → "list my recordings", "show recent files"\n' +
                  'plaud-find     → "find the Weekly Sync", "the meeting from Monday"\n' +
                  'plaud-read     → "show the transcript", "summarize this recording"\n' +
                  'plaud-digest   → "weekly report", "what meetings did I have this week"\n' +
                  'plaud-followup → "draft a follow-up email", "list the action items"\n' +
                  'plaud-export   → "save to Notion", "post to Slack"',
              },
            ],
          },
        ],
      },
    },
    references: [
      {
        label: 'Plaud MCP Documentation',
        url: 'https://docs.plaud.ai/documentation/plaud_app/mcp',
      },
      {
        label: 'Plaud CLI Documentation',
        url: 'https://docs.plaud.ai/documentation/plaud_app/cli',
      },
      { label: 'Plaud Developer Platform', url: 'https://docs.plaud.ai/documentation/index.md' },
      { label: 'Plaud App', url: 'https://plaud.ai' },
    ],
  },

  // ── Firecrawl ─────────────────────────────────────────────────────────────
  // Corrected 2026-11-25 (#1848): the site calls Firecrawl's REST API (plain
  // web requests) at version 2, with no SDK (a vendor's code library), and
  // the account is on a paid plan. No plan name or price is written here;
  // those are the owner's, on Cost → Services.
  firecrawl: {
    id: 'firecrawl',
    name: 'Firecrawl',
    type: 'mcp_server',
    tagline: 'Reads web pages for the site: it finds new articles on blog listing pages.',
    requirements: [
      {
        label: 'Firecrawl account',
        detail:
          'firecrawl.dev. The site’s account is on a paid plan; the plan and its price are kept on Admin → Cost → Services.',
        required: true,
      },
      {
        label: 'API key',
        detail: 'Made at firecrawl.dev/app/api-keys, pasted on Admin → Integrations → Keys',
        required: true,
      },
    ],
    hcwUses: [
      {
        feature: 'Blog listings',
        usage:
          'Every six hours, and when intake is run from the Blogs page, each blog listing page is sent to Firecrawl’s scrape API (version 2), which returns the articles on it as structured data. New ones become drafts.',
        files: ['functions/src/lib/timers/blog-listings.js'],
        status: HCW_STATUS.ACTIVE,
      },
      {
        feature: 'Connection test',
        usage:
          'The Test button on the Firecrawl card and the Health page read the credit balance (version 2 of the API). It reads no page and spends no credit.',
        files: ['functions/src/lib/integrations/connection-probe.js'],
        status: HCW_STATUS.ACTIVE,
      },
      {
        feature: 'AI Engine MCP',
        usage: 'Firecrawl’s tools, reached through mcpProxy for the Playground',
        files: ['src/pages/admin/AIEnginePage.jsx'],
        status: HCW_STATUS.AVAILABLE,
      },
    ],
    sections: {
      install: {
        title: 'Install & Configure',
        steps: [
          {
            heading: 'Store the API key',
            body: 'The key lives in Azure Key Vault as FIRECRAWL-API-KEY, and the Function App reads it as the setting FIRECRAWL_API_KEY. Paste a new value on Admin → Integrations → Keys. Never put it in functions/.env, in source control or in a web address.',
            codes: [
              {
                lang: 'text',
                label: 'Azure Function App setting (a Key Vault reference)',
                content: 'FIRECRAWL_API_KEY=fc-...',
              },
            ],
          },
          {
            heading: 'Enable via MCP (for Playground access)',
            body: 'On the AI Engine’s MCP Servers tab, switch Firecrawl on and press Sync Tools. The server sends the key as a bearer header (a line of the request), only to Firecrawl’s own addresses.',
            codes: [
              {
                lang: 'text',
                label: 'Firecrawl MCP server settings',
                content:
                  'Name:      Firecrawl\nURL:       https://mcp.firecrawl.dev/v2/mcp\nTransport: Streamable HTTP\nAuth:      FIRECRAWL_API_KEY (app setting, sent as a bearer header)',
              },
            ],
          },
          {
            heading: 'If you need a new API key',
            body: 'Make a key at firecrawl.dev/app/api-keys, paste it on Admin → Integrations → Keys, press Test on the Firecrawl card, then delete the old key at Firecrawl. Firecrawl’s keys carry no expiry date, so the site reminds you to replace it every 180 days.',
            codes: [],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Scrape a single URL',
            body: 'Returns clean Markdown from a web page, including pages that build themselves with JavaScript. This is version 2 of the API; version 1 stops answering on 10 December 2026.',
            codes: [
              {
                lang: 'js',
                label: 'A v2 scrape with fetch, on the server',
                content:
                  "const response = await fetch('https://api.firecrawl.dev/v2/scrape', {\n" +
                  "  method: 'POST',\n" +
                  '  headers: {\n' +
                  '    Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}`,\n' +
                  "    'Content-Type': 'application/json',\n" +
                  '  },\n' +
                  "  body: JSON.stringify({ url: 'https://example.com/article', formats: ['markdown'] }),\n" +
                  '});\n' +
                  'const result = await response.json();\n\nconsole.log(result.data.markdown);',
              },
            ],
          },
          {
            heading: 'MCP tool via Playground',
            body: 'In /admin/ai-engine → Playground → MCP Tool → Firecrawl, call the scrape tool.',
            codes: [
              {
                lang: 'json',
                label: 'scrape tool arguments',
                content: '{ "url": "https://example.com/article", "formats": ["markdown"] }',
              },
            ],
          },
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          {
            heading: 'Disable the MCP server',
            body: 'Toggle off in /admin/ai-engine → MCP Servers → Firecrawl. The blog listings timer calls the API directly, so it keeps working.',
            codes: [],
          },
          {
            heading: 'Remove the API key',
            body: 'Remove FIRECRAWL_API_KEY from the Azure Function App settings / Key Vault and delete the key in your Firecrawl dashboard. The blog listings timer then skips its runs.',
            codes: [],
          },
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          {
            heading: 'Structured data extraction',
            body: 'Ask for the json format with a JSON schema to pull structured data from a page, with no CSS selectors. In version 2 the schema goes inside formats, and the answer comes back under data.json. This is how the blog listings are read.',
            codes: [
              {
                lang: 'js',
                label: 'The request body, and where the answer is',
                content:
                  'const body = {\n' +
                  "  url: 'https://example.com/product',\n" +
                  '  formats: [\n' +
                  '    {\n' +
                  "      type: 'json',\n" +
                  '      schema: {\n' +
                  "        type: 'object',\n" +
                  '        properties: {\n' +
                  "          title: { type: 'string' },\n" +
                  "          price: { type: 'number' },\n" +
                  "          description: { type: 'string' },\n" +
                  '        },\n' +
                  '      },\n' +
                  '    },\n' +
                  '  ],\n' +
                  '};\n\n' +
                  '// After the POST to /v2/scrape:\n' +
                  'const product = result.data.json;',
              },
            ],
          },
          {
            heading: 'Credit usage',
            body: 'Each page read spends one or more credits; structured extraction spends more than plain text. The Test button on the Firecrawl card shows how many credits are left. The plan and its price are kept on Admin → Cost → Services.',
            codes: [],
          },
        ],
      },
    },
    references: [
      { label: 'Firecrawl Documentation', url: 'https://docs.firecrawl.dev' },
      { label: 'Moving from v1 to v2', url: 'https://docs.firecrawl.dev/migrate-to-v2' },
      {
        label: 'Scrape API reference (v2)',
        url: 'https://docs.firecrawl.dev/api-reference/endpoint/scrape',
      },
      { label: 'MCP server', url: 'https://docs.firecrawl.dev/mcp-server' },
      { label: 'Firecrawl API keys', url: 'https://www.firecrawl.dev/app/api-keys' },
    ],
  },

  // ── Brave Search ─────────────────────────────────────────────────────────
  'brave-search': {
    id: 'brave-search',
    name: 'Brave Search',
    type: 'mcp_server',
    tagline: 'Real-time, privacy-respecting web search — no tracking, independent index.',
    requirements: [
      {
        label: 'Brave Search API account',
        detail: 'api.search.brave.com — free tier: 2,000 req/month',
        required: true,
      },
      { label: 'API Key', detail: 'Dashboard → Applications → Create app', required: true },
    ],
    hcwUses: [
      {
        feature: 'AI Engine Playground',
        usage: 'Live web search results for research and fact-checking content',
        files: ['src/pages/admin/AIEnginePage.jsx (mcpProxy)'],
        status: HCW_STATUS.AVAILABLE,
      },
      {
        feature: 'Content Research',
        usage: 'Could be integrated into ContentForge to auto-research topics before AI drafting',
        files: [],
        status: HCW_STATUS.PLANNED,
      },
    ],
    sections: {
      install: {
        title: 'Install & Configure',
        steps: [
          {
            heading: '1. Create a Brave Search API account',
            body: 'Sign up at api.search.brave.com. The free tier gives 2,000 requests/month with no credit card required.',
            codes: [],
          },
          {
            heading: '2. Create an application and get an API key',
            body: 'In the Brave Search API Dashboard go to Applications → Create Application. Select the API plans you need (Web Search is sufficient). Copy the API key.',
            codes: [],
          },
          {
            heading: '3. Add the key to Azure Function App settings',
            body: 'The Azure mcpProxy Function reads this key when calling the Brave Search MCP server. Prefer a Key Vault reference for production.',
            codes: [
              {
                lang: 'text',
                label: 'Azure Function App setting',
                content: 'BRAVE_API_KEY=BSA...',
              },
            ],
          },
          {
            heading: '4. Enable in AI Engine',
            body: 'Go to /admin/ai-engine → MCP Servers → Brave Search → toggle On → Sync Tools.',
            codes: [],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Web search via Playground',
            body: 'Go to /admin/ai-engine → Playground → MCP Tool → Brave Search → select brave_web_search.',
            codes: [
              {
                lang: 'json',
                label: 'brave_web_search arguments',
                content: '{ "query": "AWS re:Invent 2026 announcements", "count": 10 }',
              },
            ],
          },
          {
            heading: 'Combine with AI — search then summarize',
            body: 'Use the Playground to first call Brave Search, then paste the results into an AI provider call to get a synthesized summary.',
            codes: [],
          },
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          {
            heading: 'Disable and remove key',
            body: 'Toggle off in AI Engine → MCP Servers → Brave Search. Remove BRAVE_API_KEY from the Azure Function App settings / Key Vault and revoke the application in the Brave Search API Dashboard.',
            codes: [],
          },
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          {
            heading: 'Search parameters',
            body: 'Brave Search supports country targeting, safe search, and freshness filtering.',
            codes: [
              {
                lang: 'json',
                label: 'Advanced search arguments',
                content: JSON.stringify(
                  {
                    query: 'cloud architecture trends',
                    count: 5,
                    country: 'US',
                    search_lang: 'en',
                    freshness: 'pw',
                    safesearch: 'moderate',
                  },
                  null,
                  2
                ),
              },
            ],
          },
        ],
      },
    },
    references: [
      {
        label: 'Brave Search API Documentation',
        url: 'https://api.search.brave.com/app/documentation/web-search/get-started',
      },
      { label: 'Brave Search API Dashboard', url: 'https://api.search.brave.com/app/dashboard' },
    ],
  },

  // ── Context7 ─────────────────────────────────────────────────────────────
  context7: {
    id: 'context7',
    name: 'Context7 (Library Docs)',
    type: 'mcp_server',
    tagline: 'Up-to-date documentation for any npm/PyPI/crates package — free, no API key.',
    requirements: [
      { label: 'No account required', detail: 'Free public MCP server', required: false },
      { label: 'No API key', detail: 'Unauthenticated access', required: false },
    ],
    hcwUses: [
      {
        feature: 'AI Engine Playground',
        usage:
          'Look up current docs for any library used in HCW (React, Azure Functions, Vite, Cosmos DB, etc.) without leaving the admin UI',
        files: ['src/pages/admin/AIEnginePage.jsx (mcpProxy)'],
        status: HCW_STATUS.AVAILABLE,
      },
      {
        feature: 'Development Assistance',
        usage:
          'Resolve version-specific API questions for packages in functions/package.json or package.json',
        files: [],
        status: HCW_STATUS.AVAILABLE,
      },
    ],
    sections: {
      install: {
        title: 'Enable (no credentials required)',
        steps: [
          {
            heading: 'Toggle on in AI Engine',
            body: "Go to /admin/ai-engine → MCP Servers → Context7 → toggle On → click Sync Tools. No API key or account is required — it's a free public server.",
            codes: [],
          },
          {
            heading: 'MCP server URL',
            body: 'The server is pre-configured with the correct URL.',
            codes: [
              {
                lang: 'text',
                label: 'MCP server details',
                content:
                  'URL:       https://mcp.context7.com/mcp\nTransport: HTTP (Streamable HTTP)\nAuth:      None',
              },
            ],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Step 1 — Resolve the library ID',
            body: 'First, resolve the exact library ID for the package you want docs for.',
            codes: [
              {
                lang: 'json',
                label: 'resolve-library-id arguments',
                content: '{ "libraryName": "vite" }',
              },
            ],
          },
          {
            heading: 'Step 2 — Get the docs',
            body: 'Use the resolved library ID (for example, "/vitejs/vite") to fetch documentation. Optionally specify a version and topic.',
            codes: [
              {
                lang: 'json',
                label: 'get-library-docs arguments',
                content: JSON.stringify(
                  {
                    context7CompatibleLibraryID: '/vitejs/vite',
                    topic: 'plugins',
                    tokens: 5000,
                  },
                  null,
                  2
                ),
              },
            ],
          },
          {
            heading: 'Common HCW library IDs',
            body: 'These are frequently useful when debugging HCW code.',
            codes: [
              {
                lang: 'text',
                label: 'Frequently used library IDs',
                content:
                  'React:              /facebook/react\n' +
                  'React Router:       /remix-run/react-router\n' +
                  'Vite:               /vitejs/vite\n' +
                  'Tailwind CSS:       /tailwindlabs/tailwindcss\n' +
                  'Axios:              /axios/axios',
              },
            ],
          },
        ],
      },
      uninstall: {
        title: 'Disable',
        steps: [
          {
            heading: 'Toggle off',
            body: 'Go to /admin/ai-engine → MCP Servers → Context7 → toggle Off. No credentials to revoke.',
            codes: [],
          },
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          {
            heading: 'Token budget',
            body: 'The tokens parameter controls how many tokens of documentation to return. Increase it for larger, more complete docs. The default is 5,000.',
            codes: [
              {
                lang: 'json',
                label: 'Large docs request',
                content: '{ "context7CompatibleLibraryID": "/vitejs/vite", "tokens": 15000 }',
              },
            ],
          },
          {
            heading: 'Version-specific docs',
            body: 'Use the version parameter to get docs for a specific release — critical when your project pins a non-latest version.',
            codes: [
              {
                lang: 'json',
                label: 'Version-pinned request',
                content:
                  '{ "context7CompatibleLibraryID": "/facebook/react", "version": "18.3.0", "topic": "hooks" }',
              },
            ],
          },
        ],
      },
    },
    references: [
      { label: 'Context7 Website', url: 'https://context7.com' },
      { label: 'Context7 GitHub', url: 'https://github.com/upstash/context7' },
    ],
  },

  // ── AWS Knowledge Base ───────────────────────────────────────────────────
  'aws-knowledge-mcp': {
    id: 'aws-knowledge-mcp',
    name: 'AWS Knowledge Base',
    type: 'mcp_server',
    tagline: 'Retrieve AWS documentation, architecture patterns, and knowledge base details.',
    requirements: [
      {
        label: 'Cluster Access',
        detail: 'Runs inside the virtual network/cluster',
        required: true,
      },
    ],
    hcwUses: [
      {
        feature: 'AI Engine Playground',
        usage:
          'Query and retrieve official AWS documentation and architecture patterns directly inside the playground',
        files: ['src/pages/admin/AIEnginePage.jsx'],
        status: HCW_STATUS.AVAILABLE,
      },
    ],
    sections: {
      install: {
        title: 'Status & Connection',
        steps: [
          {
            heading: 'Internal Cluster Service',
            body: 'The AWS Knowledge MCP server is deployed within the internal cluster network and exposes its JSON-RPC endpoint at http://aws-docs-mcp:8000. It requires no additional API keys or installation.',
            codes: [],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Via the AI Engine Playground',
            body: 'Go to /admin/ai-engine → Playground → MCP Tool → AWS Knowledge Base, select a tool and query.',
            codes: [
              {
                lang: 'json',
                label: 'Arguments example',
                content: '{ "query": "S3 bucket lifecycle rules configuration" }',
              },
            ],
          },
        ],
      },
      uninstall: {
        title: 'Disable',
        steps: [
          {
            heading: 'Toggle Off',
            body: 'Go to /admin/ai-engine → MCP Servers → AWS Knowledge Base → toggle Off.',
            codes: [],
          },
        ],
      },
    },
    references: [
      {
        label: 'AWS Knowledge MCP Server Repository',
        url: 'https://github.com/awslabs/mcp-servers/tree/main/src/aws-knowledge-mcp-server',
      },
    ],
  },

  // ── Microsoft Learn ──────────────────────────────────────────────────────
  'microsoftdocs-mcp': {
    id: 'microsoftdocs-mcp',
    name: 'Microsoft Learn / Docs',
    type: 'mcp_server',
    tagline: 'Retrieve Microsoft documentation, learning modules, and platform resources.',
    requirements: [
      {
        label: 'Cluster Access',
        detail: 'Runs inside the virtual network/cluster',
        required: true,
      },
    ],
    hcwUses: [
      {
        feature: 'AI Engine Playground',
        usage: 'Query Microsoft Learn modules and platform references directly from the playground',
        files: ['src/pages/admin/AIEnginePage.jsx'],
        status: HCW_STATUS.AVAILABLE,
      },
    ],
    sections: {
      install: {
        title: 'Status & Connection',
        steps: [
          {
            heading: 'Internal Cluster Service',
            body: 'The Microsoft Learn MCP server is deployed within the internal cluster network and exposes its JSON-RPC endpoint at http://ms-learn-mcp:8000. It requires no additional API keys or installation.',
            codes: [],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Via the AI Engine Playground',
            body: 'Go to /admin/ai-engine → Playground → MCP Tool → Microsoft Learn / Docs, select a tool and query.',
            codes: [
              {
                lang: 'json',
                label: 'Arguments example',
                content: '{ "query": "Azure Kubernetes Service ingress Traefik setup" }',
              },
            ],
          },
        ],
      },
      uninstall: {
        title: 'Disable',
        steps: [
          {
            heading: 'Toggle Off',
            body: 'Go to /admin/ai-engine → MCP Servers → Microsoft Learn / Docs → toggle Off.',
            codes: [],
          },
        ],
      },
    },
    references: [
      {
        label: 'Microsoft Docs MCP Server Repository',
        url: 'https://github.com/microsoftdocs/mcp',
      },
    ],
  },

  // ── Draw.io ──────────────────────────────────────────────────────────────
  'drawio-mcp': {
    id: 'drawio-mcp',
    name: 'Draw.io (Diagrams.net)',
    type: 'mcp_server',
    tagline:
      'Generate, edit, and analyze draw.io diagrams programmatically from chat prompt inputs.',
    requirements: [
      {
        label: 'No installation required',
        detail: 'Connects to the public Draw.io app server',
        required: false,
      },
    ],
    hcwUses: [
      {
        feature: 'AI Engine Playground',
        usage:
          'Create and update diagrams or generate diagram XML structures directly using MCP tools',
        files: ['src/pages/admin/AIEnginePage.jsx'],
        status: HCW_STATUS.AVAILABLE,
      },
    ],
    sections: {
      install: {
        title: 'Connection',
        steps: [
          {
            heading: 'Public App Server',
            body: 'The Draw.io MCP server connects directly to the public app bridge at https://mcp.draw.io/mcp. No local setup or installation is required.',
            codes: [],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Create diagrams via the Playground',
            body: 'Select "Draw.io (Diagrams.net)" from the MCP server dropdown in the Playground and run the creation tools.',
            codes: [
              {
                lang: 'json',
                label: 'Arguments example',
                content:
                  '{\n  "prompt": "Create a flowchart showing a git push triggering a webhook that calls an Azure Function"\n}',
              },
            ],
          },
        ],
      },
      uninstall: {
        title: 'Disable',
        steps: [
          {
            heading: 'Toggle Off',
            body: 'Go to /admin/ai-engine → MCP Servers → Draw.io (Diagrams.net) → toggle Off.',
            codes: [],
          },
        ],
      },
    },
    references: [{ label: 'Draw.io MCP Repository', url: 'https://github.com/jgraph/drawio-mcp' }],
  },

  // ── Hostinger ────────────────────────────────────────────────────────────
  // Hostinger's hosted MCP server, signed in with OAuth Connect (2026-10-08).
  // The localhost entry this replaced was never reachable from the API.
  'hostinger-mcp': {
    id: 'hostinger-mcp',
    name: 'Hostinger MCP',
    type: 'mcp_server',
    tagline:
      'Administer Hostinger resources (VPS, domains, DNS, and hosting) through Hostinger’s hosted MCP server.',
    requirements: [
      {
        label: 'Hostinger account',
        detail: 'The account whose resources the tools act on',
        required: true,
      },
      {
        label: 'Sign-in with Connect',
        detail:
          'No API key or app setting: press Connect on the card and sign in at Hostinger. The token is kept server-side and renewed automatically.',
        required: true,
      },
    ],
    hcwUses: [
      {
        feature: 'AI Engine Playground',
        usage:
          'Query VPS details and manage DNS zones and domains from the Playground. Nothing on this platform calls a Hostinger tool on its own.',
        files: ['src/pages/admin/AIEnginePage.jsx'],
        status: HCW_STATUS.AVAILABLE,
      },
    ],
    sections: {
      install: {
        title: 'Connect',
        steps: [
          {
            heading: '1. Connect',
            body: 'Go to /admin/ai-engine?tab=mcp → Hostinger MCP → Connect (super_admin). The browser goes to Hostinger; sign in and approve the “mcp:use” access. You return to the MCP Servers tab with “Hostinger MCP is connected. N tools synced.”',
            codes: [],
          },
          {
            heading: '2. Enable',
            body: 'Toggle Hostinger MCP on (super_admin, as is calling its tools: the token is your Hostinger account). Its tools can change VPS, DNS and domain settings, so it ships off; switch it on only while you need it.',
            codes: [],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Query VPS info',
            body: 'Playground → MCP Tool → Hostinger MCP → a VPS list tool. The tool list comes from Sync Tools after Connect.',
            codes: [{ lang: 'json', label: 'Arguments example', content: '{}' }],
          },
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          {
            heading: 'Disconnect and disable',
            body: 'Press Disconnect on the card (deletes the stored token) and toggle the server off. To revoke the access at Hostinger as well, remove HybridCloudWorks from the authorized apps in your Hostinger account.',
            codes: [],
          },
        ],
      },
    },
    references: [{ label: 'Hostinger API Repository', url: 'https://github.com/hostinger/api/' }],
  },

  // ── Replicate ────────────────────────────────────────────────────────────
  'replicate-mcp': {
    id: 'replicate-mcp',
    name: 'Replicate MCP',
    type: 'mcp_server',
    tagline:
      'Replicate’s hosted MCP server: search and run open-source models (images, audio, video, text) as tools.',
    requirements: [
      {
        label: 'Replicate account',
        detail: 'Runs are billed to the account that signs in',
        required: true,
      },
      {
        label: 'Sign-in with Connect',
        detail:
          'This server accepts only its own OAuth tokens, not REPLICATE_API_KEY. Press Connect on the card and sign in at Replicate.',
        required: true,
      },
    ],
    hcwUses: [
      {
        feature: 'AI Engine Playground',
        usage:
          'Search and run models from the Playground. Cover images do not use this server; they call Replicate’s REST API with REPLICATE_API_KEY.',
        files: ['src/pages/admin/AIEnginePage.jsx'],
        status: HCW_STATUS.AVAILABLE,
      },
    ],
    sections: {
      install: {
        title: 'Connect',
        steps: [
          {
            heading: '1. Connect',
            body: 'Go to /admin/ai-engine?tab=mcp → Replicate MCP → Connect (super_admin). Sign in at Replicate and approve. You return to the MCP Servers tab with “Replicate MCP is connected. N tools synced.”',
            codes: [],
          },
          {
            heading: '2. Enable',
            body: 'Toggle Replicate MCP on (super_admin, as is calling its tools). Model runs cost money on the signed-in account.',
            codes: [],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Search models',
            body: 'Playground → MCP Tool → Replicate MCP → a model search tool.',
            codes: [
              { lang: 'json', label: 'Arguments example', content: '{\n  "query": "flux"\n}' },
            ],
          },
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          {
            heading: 'Disconnect and disable',
            body: 'Press Disconnect on the card (deletes the stored token) and toggle the server off. REPLICATE_API_KEY is untouched: cover images still use it.',
            codes: [],
          },
        ],
      },
    },
    references: [
      { label: 'Replicate MCP documentation', url: 'https://replicate.com/docs/topics/mcp' },
    ],
  },

  // ── Publer ───────────────────────────────────────────────────────────────
  'publer-mcp': {
    id: 'publer-mcp',
    name: 'Publer MCP',
    type: 'mcp_server',
    tagline:
      'Publer’s own MCP server: accounts, drafts, posts, analytics and the Publer help corpus as tools.',
    requirements: [
      {
        label: 'Publer plan with MCP',
        detail: 'Settings → AI & Automations → MCP must be available on the account',
        required: true,
      },
      {
        label: 'PUBLER_API_KEY',
        detail: 'The Social Hub key, seeded on the Keys tab. The MCP reads it server-side.',
        required: true,
      },
    ],
    hcwUses: [
      {
        feature: 'AI Engine Playground',
        usage:
          'Read the Publer account, connected accounts, drafts and analytics. Nothing on this platform calls a Publer MCP tool on its own.',
        files: ['src/pages/admin/AIEnginePage.jsx'],
        status: HCW_STATUS.AVAILABLE,
      },
    ],
    sections: {
      install: {
        title: 'Configure & Setup',
        steps: [
          {
            heading: '1. Key',
            body: 'PUBLER_API_KEY is already the Social Hub key. Its light on Integrations → Keys must be green. Do not paste Publer’s “Server URL”: it carries the key as ?api_key=, and the URL field refuses a query string on mcp.publer.com.',
            codes: [],
          },
          {
            heading: '2. Sync',
            body: 'Go to /admin/ai-engine?tab=mcp → Publer MCP → Sync Tools. About 47 tools is right. Sync succeeds even with a bad key, so it proves the connection, not the key.',
            codes: [],
          },
          {
            heading: '3. Enable',
            body: 'Toggle Publer MCP on (super_admin only for this server). The Playground only lists enabled servers that have synced tools. The card reads “34 of 47 tools allowed”: the allowed list ships with the seed and only a super_admin can change it.',
            codes: [],
          },
        ],
      },
      use: {
        title: 'Use',
        steps: [
          {
            heading: 'Prove the key (read-only)',
            body: 'Playground → MCP Tool → Publer MCP → get_publer_user. Good: your Publer name and plan. PERMISSION_DENIED with “Invalid API key or not active for this account” means the key is wrong or the plan has no MCP.',
            codes: [{ lang: 'json', label: 'Arguments', content: '{}' }],
          },
          {
            heading: 'Never call from here',
            body: 'submit_publer_posts, publish_publer_draft, update_publer_post, reschedule_publer_post, change_publer_post_state, confirm_delete_publer_posts, create_publer_post_from_file, create_publer_photo_draft, create_publer_ideas and the upload_publer_* tools write to Publer. delete_publer_posts deletes nothing itself, but it opens the delete preview that confirm_delete_publer_posts completes, so it is out too. None of the 13 is in the server’s allowed tools, and the API refuses a call to any of them whatever the role.',
            codes: [],
          },
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          {
            heading: 'Disable',
            body: 'Toggle Publer MCP off in the AI Engine. The key stays: the Social Hub and the calendar sync still use it.',
            codes: [],
          },
        ],
      },
    },
    references: [
      {
        label: 'Publer: set up and use the MCP server',
        url: 'https://publer.com/help/en/article/how-to-set-up-and-use-publers-mcp-server-14orlq0/',
      },
      { label: 'Publer API documentation', url: 'https://publer.com/docs' },
    ],
  },
};

export default SERVICE_DOCS;

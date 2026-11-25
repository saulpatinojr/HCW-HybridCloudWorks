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

// Row builders: each returns the plain object described above, keys in the
// same order. A step with no code blocks gets an empty `codes` list.
const docStep = (heading, body, codes = []) => ({ heading, body, codes });
const snippet = (lang, label, content) => ({ lang, label, content });
const requirement = (label, detail, required) => ({ label, detail, required });
const reference = (label, url) => ({ label, url });

// ═════════════════════════════════════════════════════════════════════════════
export const SERVICE_DOCS = {
  // ── Claude (Anthropic) ───────────────────────────────────────────────────
  anthropic: {
    id: 'anthropic',
    name: 'Claude (Anthropic)',
    type: 'ai_provider',
    tagline: 'State-of-the-art AI by Anthropic — Opus, Sonnet, Haiku.',
    requirements: [
      requirement('Anthropic account', 'console.anthropic.com — free to create', true),
      requirement('API Key', 'Generated in the Console → API Keys', true),
      requirement('Billing enabled', 'A payment method is required for API access', true),
      requirement('Node.js ≥ 18', 'Only needed if using the Node SDK directly', false),
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
          docStep(
            '1. Create an Anthropic account',
            'Sign up at console.anthropic.com. Billing must be enabled before any API calls will succeed — add a payment method under Billing → Payment methods.'
          ),
          docStep(
            '2. Generate an API key',
            'In the Anthropic Console go to API Keys → Create Key. Give it a descriptive name (e.g. "HCW Production"). Copy the key — it is only shown once.'
          ),
          docStep(
            '3. Configure the provider key',
            'For local Azure Functions development, add the key to functions/.env. Production uses an Azure Function App setting backed by Key Vault. Never commit the local file or expose the key to the browser.',
            [snippet('bash', 'functions/.env', 'ANTHROPIC_API_KEY=sk-ant-api03-...')]
          ),
          docStep(
            '4. (Optional) Make Anthropic the default ContentForge provider',
            'The project defaults to Gemini (Google AI). To switch, change the provider env var and restart your Azure Functions emulator.',
            [
              snippet(
                'bash',
                'functions/.env',
                'CONTENTFORGE_AI_PROVIDER=anthropic\nCONTENTFORGE_ANTHROPIC_DRAFT_MODEL=claude-sonnet-4-6\nCONTENTFORGE_ANTHROPIC_ANALYSIS_MODEL=claude-sonnet-4-6'
              ),
            ]
          ),
          docStep(
            '5. Enable in AI Engine',
            'Go to /admin/ai-engine → AI Services → Claude (Anthropic) → toggle On → click Test. A green "Connected" badge confirms the key works.'
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Available models',
            'Choose based on your cost/quality trade-off. Sonnet is the recommended default for most HCW tasks.',
            [
              snippet(
                'text',
                'Model reference',
                'claude-opus-4-6          — Most capable. Best for complex analysis. ~$15/1M in, $75/1M out\n' +
                  'claude-sonnet-4-6        — Balanced speed/quality. Recommended default. ~$3/1M in, $15/1M out\n' +
                  'claude-haiku-4-5-20251001— Fastest and cheapest. Good for short tasks. ~$0.80/1M in, $4/1M out'
              ),
            ]
          ),
          docStep(
            'Via the AI Engine Playground',
            'Navigate to /admin/ai-engine → Playground → select "Claude (Anthropic)" and your model. Write a system prompt and user message, then click Send. Token counts and estimated cost are shown after each response.'
          ),
          docStep(
            'Direct API call (for custom Functions)',
            'Use the existing callProvider() helper from the AI router inside any Azure Function.',
            [
              snippet(
                'js',
                'functions/index.js (example)',
                "const { callProvider } = require('./lib/ai-model-router');\n\n" +
                  'const result = await callProvider({\n' +
                  "  provider: 'anthropic',\n" +
                  "  model: 'claude-sonnet-4-6',\n" +
                  "  prompt: 'Summarize this article in 3 bullet points.',\n" +
                  "  systemPrompt: 'You are a helpful content editor.',\n" +
                  '});\n\n' +
                  'console.log(result.text);'
              ),
            ]
          ),
          docStep(
            'Prompt caching (automatic)',
            'The callAnthropic() implementation in ai-model-router.js automatically applies Anthropic prompt caching to large system prompts using the ephemeral cache_control type. Cached tokens cost 10% of the normal input price.'
          ),
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          docStep(
            'Disable in AI Engine',
            'Go to /admin/ai-engine → AI Services → Claude (Anthropic) → toggle Off. This prevents the provider from being used in the Playground.'
          ),
          docStep(
            'Remove the API key',
            'Remove the ANTHROPIC_API_KEY local setting and its Azure Function App setting / Key Vault reference, then restart the Function App and revoke the key in the Anthropic Console.',
            [snippet('bash', 'functions/.env — remove this line', '# ANTHROPIC_API_KEY=sk-ant-...')]
          ),
          docStep(
            'Revoke the key in Console',
            'For security, also revoke the key in the Anthropic Console → API Keys → Delete.'
          ),
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          docStep(
            'Extended context (200K tokens)',
            'All Claude 3+ models support 200K token context windows. The current callAnthropic() implementation sets max_tokens: 4096 for output — increase this for longer completions.',
            [
              snippet(
                'js',
                'functions/lib/ai-model-router.js — adjust max_tokens',
                "max_tokens: 8192,  // increase up to model's output limit"
              ),
            ]
          ),
          docStep(
            'Streaming responses',
            "The current implementation uses non-streaming mode. For real-time output in the UI, implement streaming using the Anthropic SDK's stream() method.",
            [
              snippet(
                'js',
                'Streaming example (SDK)',
                "import Anthropic from '@anthropic-ai/sdk';\n\n" +
                  'const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });\n\n' +
                  'const stream = client.messages.stream({\n' +
                  "  model: 'claude-sonnet-4-6',\n" +
                  '  max_tokens: 1024,\n' +
                  "  messages: [{ role: 'user', content: 'Hello' }],\n" +
                  '});\n\n' +
                  'for await (const chunk of stream) {\n' +
                  "  process.stdout.write(chunk.delta?.text ?? '');\n" +
                  '}'
              ),
            ]
          ),
          docStep(
            'Rate limits',
            'Anthropic rate limits are per API key and scale with your usage tier. Tier 1 (new accounts) starts at 50,000 TPM (tokens per minute). The ai-model-router.js withRetry() function handles 429 rate-limit errors automatically with exponential backoff.'
          ),
        ],
      },
    },
    references: [
      reference('Anthropic API Documentation', 'https://docs.anthropic.com'),
      reference(
        'Claude Models Overview',
        'https://docs.anthropic.com/en/docs/about-claude/models/overview'
      ),
      reference('Anthropic Console', 'https://console.anthropic.com'),
      reference(
        'Prompt Caching Guide',
        'https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching'
      ),
    ],
  },

  // ── Gemini (Google AI) ───────────────────────────────────────────────────
  gemini: {
    id: 'gemini',
    name: 'Gemini (Google AI)',
    type: 'ai_provider',
    tagline: "Google's Gemini models through the public Generative Language API.",
    requirements: [
      requirement(
        'Google AI Studio API key',
        'Create a key at aistudio.google.com/app/apikey',
        true
      ),
      requirement(
        'Azure Function App setting',
        'Production uses a Key Vault reference for GEMINI_API_KEY',
        true
      ),
      requirement('Entra admin access', 'Required to use the authenticated AI Engine routes', true),
      requirement(
        'Local Azure Functions environment',
        'Use functions/.env for local development only',
        true
      ),
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
          docStep(
            'Create the API key',
            'Create a Google AI Studio API key. Do not put it in browser code, source control, or the Admin Portal configuration document.'
          ),
          docStep(
            'Configure local development',
            'For local Azure Functions development only, add the key to functions/.env. This file is ignored by git and is not a production secret store.',
            [
              snippet(
                'bash',
                'functions/.env',
                'GEMINI_API_KEY=replace-with-your-key\nCONTENTFORGE_AI_PROVIDER=gemini'
              ),
            ]
          ),
          docStep(
            'Configure production',
            'Set GEMINI_API_KEY as an Azure Function App setting backed by Azure Key Vault, then restart the Function App. The browser calls Azure Functions and never receives the key.',
            [
              snippet(
                'bash',
                'Azure CLI pattern',
                'az functionapp config appsettings set \\\n  --name <function-app> \\\n  --resource-group <resource-group> \\\n  --settings GEMINI_API_KEY="@Microsoft.KeyVault(SecretUri=<secret-uri>)"'
              ),
            ]
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Available models',
            'The Admin Portal seeds the current Gemini model list. Select a model in AI Engine, or let the router use its purpose-specific defaults.',
            [
              snippet(
                'text',
                'Model reference',
                'gemini-3.5-flash-lite — default low-cost model\n' +
                  'gemini-3.6-flash      — default analysis and multimodal model\n' +
                  'gemini-2.5-pro        — higher-quality reasoning option'
              ),
            ]
          ),
          docStep(
            'Use the AI Engine Playground',
            'Navigate to /admin/ai-engine → AI Services or Playground → select "Gemini (Google AI)" → choose a model → click Test or Send. Requests are authenticated with Entra and proxied by Azure Functions.',
            [
              snippet(
                'bash',
                'Routing note',
                'The browser calls Azure Functions; provider credentials and usage logging remain server-side.'
              ),
            ]
          ),
          docStep(
            'Route a recording',
            'Pick a content type and send. The transcript goes through the same drafter as Generate Article Draft, with instructions for the chosen type; the draft lands in the editor as a recording-sourced item and the recording is marked routed with its content id. The provider shown in the request is a hint only: the AI router picks by configured order and the draft records which provider ran.'
          ),
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          docStep(
            'Disable in AI Engine',
            'Turn Gemini off or change the provider order in /admin/ai-engine. The Azure API honors the stored provider configuration on every request.'
          ),
          docStep(
            'Remove the production secret',
            'Remove the GEMINI_API_KEY Function App setting or Key Vault reference, then restart the Function App and revoke the key in Google AI Studio.'
          ),
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          docStep(
            'Multimodal input (images in prompts)',
            'Use the shared Azure Function AI router with the parts parameter for image or other supported inline content. This keeps retries, usage logging, and provider errors consistent.',
            [
              snippet(
                'js',
                'Multimodal call via generateJsonResponse()',
                'const result = await generateJsonResponse({\n' +
                  "  prompt: 'Describe this image.',\n" +
                  "  parts: [{ inlineData: { mimeType: 'image/jpeg', data: base64String } }],\n" +
                  "  purpose: 'multimodal',\n" +
                  '});'
              ),
            ]
          ),
          docStep(
            'Provider safety and limits',
            'The public Gemini API applies provider safety controls. Use the shared Azure Function router so authentication, retries, usage logging, and error handling remain centralized.'
          ),
          docStep(
            'Safety settings',
            'Adjust safety thresholds if the model blocks legitimate content. Use with caution in production.'
          ),
        ],
      },
    },
    references: [
      reference('Gemini API Documentation', 'https://ai.google.dev/gemini-api/docs'),
      reference('Google AI Studio', 'https://aistudio.google.com/app/apikey'),
    ],
  },

  // ── OpenAI ───────────────────────────────────────────────────────────────
  openai: {
    id: 'openai',
    name: 'OpenAI',
    type: 'ai_provider',
    tagline: 'GPT-5 mini and nano through the OpenAI Platform API.',
    requirements: [
      requirement('OpenAI API key', 'Create a key at platform.openai.com/api-keys', true),
      requirement(
        'Azure Function App setting',
        'Production uses a Key Vault reference for OPENAI_API_KEY (secret OPENAI-API-KEY)',
        true
      ),
      requirement('Entra admin access', 'Required to use the authenticated AI Engine routes', true),
      requirement(
        'Local Azure Functions environment',
        'Use functions/.env for local development only',
        true
      ),
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
          docStep(
            'Create the API key',
            'Create a key at platform.openai.com/api-keys. Do not put it in browser code, source control, or the Admin Portal configuration document.'
          ),
          docStep(
            'Configure local development',
            'For local Azure Functions development only, add the key to functions/.env. This file is ignored by git and is not a production secret store. The command prompts for the key and never shows it.',
            [
              snippet(
                'powershell',
                'Append to functions/.env (repository root)',
                '$k = Read-Host -AsSecureString "OpenAI key"; Add-Content -Path functions/.env -Value ("OPENAI_API_KEY=" + [System.Net.NetworkCredential]::new("", $k).Password)'
              ),
            ]
          ),
          docStep(
            'Configure production',
            'Seed OPENAI-API-KEY in Key Vault with the seeding script; the Function App setting OPENAI_API_KEY is a Key Vault reference Terraform manages. Restart the Function App to pick the value up at once. The browser calls Azure Functions and never receives the key.',
            [
              snippet(
                'powershell',
                'Seed the secret (repository root)',
                './scripts/cutover/06-seed-secret.ps1 -Name OPENAI-API-KEY'
              ),
            ]
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Available models',
            'The Admin Portal seeds the current model list. Select a model on the card to pin it for every purpose, or leave Auto so the router uses its purpose defaults.',
            [
              snippet(
                'text',
                'Model reference',
                "gpt-5-mini  — the card's default\n" +
                  'gpt-5-nano  — lower cost, shorter answers\n' +
                  'gpt-4o      — the previous generation, still offered\n' +
                  'gpt-4o-mini — the previous generation, small'
              ),
            ]
          ),
          docStep(
            'Use the AI Engine Playground',
            'Navigate to /admin/ai-engine → AI Services or Playground → select "OpenAI" → choose a model → click Test or Send. Requests are authenticated with Entra and proxied by Azure Functions.'
          ),
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          docStep(
            'Disable in AI Engine',
            'Turn OpenAI off or change the provider order in /admin/ai-engine. The Azure API honors the stored provider configuration on every request.'
          ),
          docStep(
            'Remove the production secret',
            'Remove the OPENAI-API-KEY secret from Key Vault, restart the Function App, and revoke the key at platform.openai.com. With no key the router treats the provider as absent and the others serve as before.'
          ),
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          docStep(
            'Reasoning models, max_tokens and temperature',
            "OpenAI's reasoning models refuse the max_tokens field and any temperature but the default, so the router sends neither to OpenAI; the per-call cap the portal's Test passes applies only to providers whose table row sends one."
          ),
          docStep(
            'JSON responses',
            'JSON generation asks this provider for response_format json_object, with one repair round trip if the answer does not parse.'
          ),
        ],
      },
    },
    references: [
      reference('OpenAI Platform documentation', 'https://platform.openai.com/docs'),
      reference('API keys', 'https://platform.openai.com/api-keys'),
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
      requirement(
        'NVIDIA API Catalog key',
        'An nvapi- key from build.nvidia.com/settings/api-keys; read the trial terms before seeding',
        true
      ),
      requirement(
        'Azure Function App setting',
        'Production uses a Key Vault reference for NVIDIA_API_KEY (secret NVIDIA-API-KEY)',
        true
      ),
      requirement('Entra admin access', 'Required to use the authenticated AI Engine routes', true),
      requirement(
        'Local Azure Functions environment',
        'Use functions/.env for local development only',
        true
      ),
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
          docStep(
            'Create the API key',
            'Generate one key at build.nvidia.com/settings/api-keys. Do not put it in browser code, source control, or the Admin Portal configuration document.'
          ),
          docStep(
            'Configure local development',
            'For local Azure Functions development only, add the key to functions/.env. This file is ignored by git and is not a production secret store. The command prompts for the key and never shows it.',
            [
              snippet(
                'powershell',
                'Append to functions/.env (repository root)',
                '$k = Read-Host -AsSecureString "NVIDIA key"; Add-Content -Path functions/.env -Value ("NVIDIA_API_KEY=" + [System.Net.NetworkCredential]::new("", $k).Password)'
              ),
            ]
          ),
          docStep(
            'Configure production',
            'Seed NVIDIA-API-KEY in Key Vault with the seeding script; the Function App setting NVIDIA_API_KEY is a Key Vault reference Terraform manages. Restart the Function App to pick the value up at once.',
            [
              snippet(
                'powershell',
                'Seed the secret (repository root)',
                './scripts/cutover/06-seed-secret.ps1 -Name NVIDIA-API-KEY'
              ),
            ]
          ),
          docStep(
            'Wait before judging a fresh key',
            'A freshly seeded key can answer "403 Authorization failed" from the app for up to about 40 minutes, the same reply a wrong key gets. Measured 2026-10-04: the app refused a key at 1, 12 and 13 minutes after seeding and accepted it at 37; a workstation accepted that same key at about 23 minutes; a separate key seconds old passed at once from Azure Cloud Shell. Test again later before reseeding, and delete the previous key at NVIDIA only after the new one passes from here.'
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Available models',
            'The router uses GLM-5.3 for every purpose. The two "flash" models stay priced for an override, but on the trial tier they were the slow ones: 70 s and more than 120 s to answer one line, against 2.6 s for GLM-5.3.',
            [
              snippet(
                'text',
                'Model reference',
                'z-ai/glm-5.3                     — the default for every purpose\n' +
                  'z-ai/glm-5.3-flash               — CONTENTFORGE_NVIDIA_*_MODEL override only\n' +
                  'deepseek-ai/deepseek-v4.1-flash  — CONTENTFORGE_NVIDIA_*_MODEL override only'
              ),
            ]
          ),
          docStep(
            'Use the AI Engine Playground',
            'Navigate to /admin/ai-engine → AI Services or Playground → select "NVIDIA API" → click Test or Send. The Test caps max_tokens and the timeout so a reasoning model proves it answers in seconds rather than thinking past the edge limit.'
          ),
          docStep(
            'Pacing',
            'The router keeps each instance under the account limit (36 requests a minute by default; NVIDIA_REQUESTS_PER_MINUTE overrides). A call the guard refuses is not sent and fails over to the next provider at once, so a burst of batch drafts degrades to the paid providers instead of failing.'
          ),
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          docStep(
            'Disable in AI Engine',
            'Turn NVIDIA off, or change its placement under Where AI is used, in /admin/ai-engine. The Azure API honors the stored configuration on every request.'
          ),
          docStep(
            'Remove the production secret',
            'Remove the NVIDIA-API-KEY secret from Key Vault, restart the Function App, and delete the key at build.nvidia.com. With no key the router treats the provider as absent and the paid providers serve as before.'
          ),
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          docStep(
            'Text only',
            'A call carrying an image is routed past this provider rather than refused by it; the next provider in the chain takes it.'
          ),
          docStep(
            'Failover on 400 and 422',
            'A bad request from this provider fails over, unlike the three frontier APIs: the catalogue models have their own context and parameter limits, and the next provider will very likely take the same request. A prompt part the router rejected locally before sending (AI_PART_REFUSED) does not fail over.'
          ),
          docStep(
            'Cost and output',
            "Usage rows are priced at zero so the Usage tab shows the calls and the saving. A <think> block in an answer is stripped before the text reaches the caller. Model ids are the `model` value in each page's curl sample, which is not always the URL slug."
          ),
        ],
      },
    },
    references: [
      reference('NVIDIA API Catalog models', 'https://build.nvidia.com/models'),
      reference('API keys', 'https://build.nvidia.com/settings/api-keys'),
    ],
  },

  // ── Microsoft Foundry ────────────────────────────────────────────────────
  foundry: {
    id: 'foundry',
    name: 'Microsoft Foundry',
    type: 'ai_provider',
    tagline: 'GPT-5 nano and mini on an Azure account the estate owns, paid, under its own budget.',
    requirements: [
      requirement(
        'Terraform applied',
        'infra/foundry.tf creates the account, the two deployments, the role for the app and the budget; the owner applies it through TFC',
        true
      ),
      requirement(
        'Azure Function App setting',
        'FOUNDRY_ENDPOINT, written by Terraform from the account; nothing is seeded',
        true
      ),
      requirement('Entra admin access', 'Required to use the authenticated AI Engine routes', true),
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
          docStep(
            'Apply the Terraform',
            "infra/foundry.tf declares the AIServices account (local authentication off), the gpt-5-nano and gpt-5-mini deployments, the Cognitive Services OpenAI User role for the Function App identity, and a USD 75 monthly budget on the ai resource group. The TFC run is the owner's; after it, FOUNDRY_ENDPOINT is on the Function App and the card reads Connected after Test."
          ),
          docStep(
            'Local development',
            'With no FOUNDRY_API_KEY, the router asks @azure/identity for a token, which on a workstation is the az login session; that account needs Cognitive Services OpenAI User on the resource. A developer with a Foundry account of their own can set FOUNDRY_ENDPOINT and FOUNDRY_API_KEY in functions/.env instead. The command prompts for the key and never shows it.',
            [
              snippet(
                'powershell',
                'Append to functions/.env (repository root)',
                '$k = Read-Host -AsSecureString "Foundry key"; Add-Content -Path functions/.env -Value ("FOUNDRY_API_KEY=" + [System.Net.NetworkCredential]::new("", $k).Password)'
              ),
            ]
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Available models',
            'The deployment names are the model names. Leave the card on Auto and the router uses mini for drafts and analysis and nano for short calls; pick one to pin it for every purpose.',
            [
              snippet(
                'text',
                'Model reference (USD per 1M tokens, Global Standard, 2026-10-04)',
                'gpt-5-nano — $0.05 in / $0.40 out; short calls and captions\n' +
                  'gpt-5-mini — $0.25 in / $2.00 out; drafts, grading, analysis'
              ),
            ]
          ),
          docStep(
            'Use the AI Engine Playground',
            'Navigate to /admin/ai-engine → AI Services or Playground → select "Microsoft Foundry" → click Test or Send. Requests are authenticated with Entra and proxied by Azure Functions, which signs in to Foundry with its own identity.'
          ),
          docStep(
            'Watch the budget',
            'The Foundry resource group has its own Cost Management budget of USD 75 a month, with alerts at 50, 90 and 100 % actual and 100 % forecast to the ops action group. A budget alerts; it does not stop spend, so the response to an alert is to turn the provider off here. The Usage & Cost tab prices each call from the same rates.'
          ),
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          docStep(
            'Disable in AI Engine',
            'Turn Foundry off, or change its placement under Where AI is used, in /admin/ai-engine. The Azure API honors the stored configuration on every request.'
          ),
          docStep(
            'Remove the account',
            'Remove foundry.tf and the FOUNDRY_ENDPOINT setting and apply; with no endpoint the router treats the provider as absent and the others serve as before. There is no key to revoke.'
          ),
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          docStep(
            'Token, not key',
            'The router fetches an Entra token for https://ai.azure.com/.default (the audience the Foundry v1 endpoint documents; the FOUNDRY_TOKEN_SCOPE app setting overrides it) through @azure/identity and reuses it until five minutes before expiry. A 401 or 403 from Foundry therefore means the role assignment or the audience, not a secret: check that the Function App identity holds Cognitive Services OpenAI User on the account.'
          ),
          docStep(
            'Reasoning models, max_tokens and temperature',
            'GPT-5 deployments refuse the max_tokens field and any temperature but the default (400, "Only the default (1) value is supported"), so the row sends neither, as for OpenAI; JSON generation asks for response_format json_object with one repair round trip.'
          ),
        ],
      },
    },
    references: [
      reference('Microsoft Foundry documentation', 'https://learn.microsoft.com/azure/foundry/'),
      reference(
        'Azure OpenAI pricing',
        'https://azure.microsoft.com/pricing/details/azure-openai/'
      ),
    ],
  },

  // ── Azure OpenAI ─────────────────────────────────────────────────────────
  azure: {
    id: 'azure',
    name: 'Microsoft Azure OpenAI',
    type: 'ai_provider',
    tagline: 'GPT-4o via Azure — enterprise-grade with data residency and compliance.',
    requirements: [
      requirement('Azure subscription', 'azure.microsoft.com — free trial gives $200 credit', true),
      requirement(
        'Azure OpenAI resource',
        'Created in Azure Portal → AI Services → Azure OpenAI',
        true
      ),
      requirement('Model deployment', 'Deploy gpt-4o in Azure OpenAI Studio → Deployments', true),
      requirement(
        'API Key + Endpoint URL',
        'Both found in your Azure OpenAI resource → Keys and Endpoint',
        true
      ),
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
          docStep(
            '1. Create an Azure OpenAI resource',
            'In the Azure Portal, go to Create a resource → AI + Machine Learning → Azure OpenAI. Select a region (East US or Sweden Central recommended for latest models). The resource creation takes a few minutes.'
          ),
          docStep(
            '2. Deploy a model',
            'In Azure OpenAI Studio (oai.azure.com), go to Deployments → Create new deployment. Select gpt-4o and give it a deployment name (e.g. "gpt-4o-prod"). Note the deployment name — it is used in API calls.'
          ),
          docStep(
            '3. Get your endpoint and key',
            'In the Azure Portal, open your Azure OpenAI resource → Keys and Endpoint. Copy Key 1 and the Endpoint URL.'
          ),
          docStep(
            '4. Configure the provider settings',
            'For local Azure Functions development, set all three variables in functions/.env. Production uses Azure Function App settings / Key Vault. The AZURE_OPENAI_DEPLOYMENT value must exactly match the deployment name you created in step 2.',
            [
              snippet(
                'bash',
                'functions/.env',
                'AZURE_OPENAI_API_KEY=your_azure_key_here\n' +
                  'AZURE_OPENAI_ENDPOINT=https://your-resource-name.openai.azure.com\n' +
                  'AZURE_OPENAI_DEPLOYMENT=gpt-4o-prod'
              ),
            ]
          ),
          docStep(
            '5. Enable in AI Engine',
            'Go to /admin/ai-engine → AI Services → Microsoft Azure OpenAI → toggle On → Test.'
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'API version',
            'Azure OpenAI API versions are date-pinned. The current HCW implementation uses api-version=2024-02-01, which supports gpt-4o. Always pin to a stable version in production.',
            [
              snippet(
                'text',
                'Endpoint format',
                'https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version=2024-02-01'
              ),
            ]
          ),
          docStep(
            'Via the AI Engine Playground',
            'Select "Microsoft Azure OpenAI" — the model shown will be your configured deployment. The interface is identical to the OpenAI playground.'
          ),
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          docStep(
            'Remove env vars and disable',
            'Toggle off in AI Engine, remove the local AZURE_OPENAI_* settings and any Azure Function App / Key Vault settings, and optionally delete the Azure OpenAI resource in the Azure Portal to stop any charges.'
          ),
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          docStep(
            'Content filtering policies',
            'Azure applies content safety filters by default. Configure custom policies in Azure OpenAI Studio → Content filters if the defaults are too restrictive for technical content.'
          ),
          docStep(
            'Managed identity (recommended for production)',
            'Instead of an API key, use Azure Managed Identity to authenticate — no credentials in env vars.',
            [
              snippet(
                'js',
                'Managed identity header',
                "const { DefaultAzureCredential } = require('@azure/identity');\n" +
                  'const credential = new DefaultAzureCredential();\n' +
                  "const token = await credential.getToken('https://cognitiveservices.azure.com/.default');\n" +
                  "headers['Authorization'] = `Bearer ${token.token}`;\n" +
                  "// Remove 'api-key' header when using managed identity"
              ),
            ]
          ),
        ],
      },
    },
    references: [
      reference(
        'Azure OpenAI Service Documentation',
        'https://learn.microsoft.com/en-us/azure/ai-services/openai/'
      ),
      reference('Azure OpenAI Studio', 'https://oai.azure.com'),
      reference(
        'Supported Models by Region',
        'https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models'
      ),
    ],
  },

  // ── AWS Bedrock (Nova) ───────────────────────────────────────────────────
  bedrock: {
    id: 'bedrock',
    name: 'AWS Bedrock (Amazon Nova)',
    type: 'ai_provider',
    tagline: 'Amazon Nova models via Bedrock — extremely cost-effective inference.',
    requirements: [
      requirement('AWS account', 'aws.amazon.com — free tier available', true),
      requirement(
        'Bedrock model access',
        'Request access in AWS Console → Amazon Bedrock → Model access',
        true
      ),
      requirement(
        'IAM user with bedrock permission',
        'Policy: bedrock:InvokeModel on the Nova model ARNs',
        true
      ),
      requirement('Access Key + Secret', 'Generated in IAM → Users → Security credentials', true),
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
          docStep(
            '1. Request model access in AWS Console',
            'Amazon Nova models require explicit access requests. In the AWS Console go to Amazon Bedrock → Model access → Manage model access → check Amazon Nova Lite and Nova Pro → Save changes. Access is usually granted within minutes.'
          ),
          docStep(
            '2. Create an IAM user',
            'In IAM → Users → Create user, attach the AmazonBedrockFullAccess policy or a scoped policy. Under Security credentials → Create access key, select "Application running outside AWS". Copy the Access Key ID and Secret.'
          ),
          docStep(
            '3. Create a scoped IAM policy (recommended)',
            'For production, use a minimal policy rather than the full access policy.',
            [
              snippet(
                'json',
                'IAM Policy (minimal)',
                JSON.stringify(
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
                )
              ),
            ]
          ),
          docStep(
            '4. Configure the provider credentials',
            'For local Azure Functions development, use functions/.env. Production should use Azure Function App settings / Key Vault or the approved AWS credential federation path. Nova models are available in us-east-1 (and a few other regions).',
            [
              snippet(
                'bash',
                'functions/.env',
                'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n' +
                  'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n' +
                  'AWS_REGION=us-east-1'
              ),
            ]
          ),
          docStep(
            '5. Enable in AI Engine',
            'Go to /admin/ai-engine → AI Services → AWS Bedrock (Nova) → toggle On → Test.'
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Available Nova models',
            'All three Nova tiers are available. Nova Micro has no image understanding; Nova Lite and Pro support multimodal input.',
            [
              snippet(
                'text',
                'Model reference',
                'amazon.nova-micro-v1:0  — Text only. Cheapest. ~$0.035/1M in, $0.14/1M out\n' +
                  'amazon.nova-lite-v1:0   — Text + image. Fast. ~$0.06/1M in, $0.24/1M out\n' +
                  'amazon.nova-pro-v1:0    — Most capable Nova. ~$0.80/1M in, $3.20/1M out'
              ),
            ]
          ),
          docStep(
            'No SDK required',
            "The SigV4 signing algorithm is implemented directly in ai-model-router.js using Node.js's built-in crypto module. No @aws-sdk packages are needed."
          ),
          docStep(
            'Nova message format',
            'Nova uses a slightly different request body than OpenAI. The implementation in callAWSNova() handles this automatically.',
            [
              snippet(
                'json',
                'Nova request body format',
                JSON.stringify(
                  {
                    messages: [{ role: 'user', content: [{ text: 'Hello!' }] }],
                    system: [{ text: 'You are a helpful assistant.' }],
                    inferenceConfig: { max_new_tokens: 2048, temperature: 0.2 },
                  },
                  null,
                  2
                )
              ),
            ]
          ),
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          docStep(
            'Remove credentials and disable',
            'Toggle off in AI Engine, remove the local AWS settings and any production Function App / Key Vault configuration. In the AWS Console, deactivate or delete the IAM access key.'
          ),
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          docStep(
            'Cross-region inference profiles',
            'For higher throughput, use a cross-region inference profile instead of a direct model ID. This routes requests across multiple regions automatically.',
            [
              snippet(
                'bash',
                'Cross-region profile ARN format',
                'us.amazon.nova-lite-v1:0  # routes across US regions\neu.amazon.nova-lite-v1:0  # routes across EU regions'
              ),
            ]
          ),
          docStep(
            'Bedrock Guardrails',
            'Apply safety guardrails to all Nova calls via the GuardrailIdentifier and GuardrailVersion headers. Create guardrails in the Bedrock console.'
          ),
        ],
      },
    },
    references: [
      reference(
        'Amazon Bedrock User Guide',
        'https://docs.aws.amazon.com/bedrock/latest/userguide/'
      ),
      reference(
        'Amazon Nova Model IDs',
        'https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html'
      ),
      reference(
        'Bedrock InvokeModel API',
        'https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeModel.html'
      ),
    ],
  },

  // ── NotebookLM ───────────────────────────────────────────────────────────
  notebooklm: {
    id: 'notebooklm',
    name: 'NotebookLM (Google)',
    type: 'ai_provider',
    tagline: "Google's research assistant — no public API for the consumer product.",
    requirements: [
      requirement('Google account', 'notebooklm.google.com', true),
      requirement(
        'Public API',
        'None for consumer NotebookLM (checked 2026-09-29). Gemini Notebook Enterprise has a v1alpha API that needs a Google Cloud project and a Gemini Enterprise licence',
        true
      ),
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
          docStep(
            'No public API',
            'Checked 2026-09-29: consumer NotebookLM at notebooklm.google.com still has no public REST API or MCP server. Google’s enterprise edition, now called Gemini Notebook Enterprise, documents a v1alpha API for notebooks and their sources (docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/api-notebooks), which needs a Google Cloud project and a Gemini Enterprise licence. This slot stays reserved in the AI Engine until the consumer product opens programmatic access or HCW takes the enterprise licence.'
          ),
          docStep(
            'Workaround — manual use',
            'You can manually use NotebookLM by uploading HCW content (exported articles, transcripts) via the web interface. To connect it to HCW programmatically, check this page when a public API is announced.'
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Not yet available',
            'No API integration possible until Google releases developer access.'
          ),
        ],
      },
      uninstall: { title: 'N/A', steps: [] },
      advanced: { title: 'N/A', steps: [] },
    },
    references: [
      reference('NotebookLM', 'https://notebooklm.google.com'),
      reference(
        'NotebookLM Blog (stay updated)',
        'https://blog.google/technology/ai/notebooklm-google-ai/'
      ),
    ],
  },

  // ── Plaud MCP ────────────────────────────────────────────────────────────
  plaud: {
    id: 'plaud',
    name: 'Plaud (Voice Recordings)',
    type: 'mcp_server',
    tagline: 'Connect your Plaud recordings live — transcripts, AI notes, and search via MCP.',
    requirements: [
      requirement('Plaud account', 'plaud.ai — required for recordings', true),
      requirement('Node.js ≥ 20', 'For the MCP installer CLI', true),
      requirement('OAuth token', 'Generated via the MCP installer or Claude Web', true),
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
          docStep(
            'Option A — CLI installer (recommended)',
            'Run the Plaud MCP installer. It auto-detects local AI clients (Claude Desktop, Cursor, VS Code), writes their MCP config, and opens your browser for OAuth authorization.',
            [
              snippet(
                'bash',
                'Terminal (Node.js ≥ 20 required)',
                'npx -y @plaud-ai/mcp@latest install'
              ),
            ]
          ),
          docStep(
            'Option B — Claude Web connector',
            'In Claude Web (claude.ai), go to Settings → Connectors → Add custom connector and fill in the form.',
            [
              snippet(
                'text',
                'Claude Web connector settings',
                'Name:                Plaud\nRemote MCP server URL: https://mcp.plaud.ai/mcp'
              ),
            ]
          ),
          docStep(
            'Copy your OAuth access token',
            'After the CLI install, your token is stored at ~/.plaud/tokens-mcp.json. Open the file and copy the access_token value.',
            [snippet('bash', 'Terminal — view the token file', 'cat ~/.plaud/tokens-mcp.json')]
          ),
          docStep(
            'Paste the token in HCW',
            'Go to /admin/recording-hub → Plaud tab → Connect → paste the token → Save & Test. The token is stored server-side in Cosmos DB and used by the Azure mcpProxy Function. It never returns to the browser after saving.'
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Available MCP tools',
            'These tools are called by HCW via the Azure mcpProxy Function at https://mcp.plaud.ai/mcp.',
            [
              snippet(
                'text',
                'Tool reference',
                'list_files       — List recordings. Params: query, date_from (YYYY-MM-DD), date_to, page, page_size\n' +
                  'get_file         — Full recording details + 24h presigned audio URL. Params: id\n' +
                  'get_note         — AI summary, action items, key topics (Markdown). Params: id\n' +
                  'get_transcript   — Full transcript with timestamps and speaker labels. Params: id\n' +
                  'get_current_user — Your account details. No params.'
              ),
            ]
          ),
          docStep(
            'Recording Hub — Plaud tab, Library',
            'Once connected, navigate to /admin/recording-hub → Plaud tab → Library. Your recordings appear immediately. Search by keyword or date range, expand any card to read the transcript, click "Script this" to queue a podcast episode draft (it lands on the Podcast tab), or click "Create Content" to route a transcript through the ContentForge pipeline. The Upload sub-tab sends an audio file to the Plaud Embedded Transcription API — a separate key pair, seeded in Key Vault — and stores the transcript under Stored recordings.'
          ),
          docStep(
            'Via the AI Engine Playground',
            'Go to /admin/ai-engine → Playground → MCP Tool mode → select Plaud → list_files. Pass arguments as JSON.',
            [
              snippet(
                'json',
                'list_files arguments example',
                JSON.stringify(
                  { query: 'standup', date_from: '2026-05-01', date_to: '2026-05-31' },
                  null,
                  2
                )
              ),
            ]
          ),
          docStep(
            'Plaud CLI (standalone terminal access)',
            'You can also browse your recordings from the terminal without the HCW admin UI.',
            [
              snippet(
                'bash',
                'Plaud CLI quick reference',
                'npm install -g @plaud-ai/cli\n\n' +
                  'plaud login               # authorize via browser\n' +
                  'plaud files               # list recent recordings\n' +
                  'plaud search "Q2 review"  # search by keyword\n' +
                  'plaud transcript <id>     # read full transcript\n' +
                  'plaud summary <id>        # read AI summary\n' +
                  'plaud transcript <id> -o out.txt  # save to file'
              ),
            ]
          ),
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          docStep(
            'Remove OAuth token from HCW',
            'In /admin/ai-engine → MCP Servers → Plaud → toggle Off. To delete the stored token, clear the oauthToken field from the mcp_servers/plaud document in Cosmos DB.'
          ),
          docStep(
            'Remove local CLI and token files',
            'If you installed the CLI or MCP package, clean up with these commands.',
            [
              snippet(
                'bash',
                'Full local cleanup',
                '# Uninstall MCP package\nnpm uninstall -g @plaud-ai/mcp\n\n' +
                  '# Uninstall CLI package\nnpm uninstall -g @plaud-ai/cli\n\n' +
                  '# Remove local token files\nrm -rf ~/.plaud'
              ),
            ]
          ),
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          docStep(
            'Token refresh',
            'Plaud OAuth tokens expire. If the Library tab stops loading or you see 401 errors, re-run the installer (or re-authorize via Claude Web) and paste the new token in the Connect tab.',
            [
              snippet(
                'bash',
                'Refresh MCP token',
                'npx -y @plaud-ai/mcp@latest install\n# Re-authorize in browser, then copy the new access_token from ~/.plaud/tokens-mcp.json'
              ),
            ]
          ),
          docStep(
            'Pagination for large libraries',
            'list_files defaults to 20 recordings per page. Use page and page_size to navigate large libraries. Keyword search scans the 500 most recent recordings client-side.',
            [snippet('json', 'Paginated list_files call', '{ "page": 2, "page_size": 50 }')]
          ),
          docStep(
            'Audio download',
            'get_file returns a presigned_url for the audio file, valid for 24 hours. Use this to download recordings for external processing.',
            [
              snippet(
                'js',
                'Download audio via presigned URL',
                "const res = await aiEngine.mcpTool('plaud', 'get_file', { id: recordingId });\n" +
                  'const file = JSON.parse(res.result);\n' +
                  'const audioUrl = file.presigned_url;  // valid 24 hours\n' +
                  '// Use in an <audio> element or download with fetch()'
              ),
            ]
          ),
          docStep(
            'Skills (pre-built prompt workflows)',
            'The Plaud MCP includes built-in skills that trigger on natural language phrases inside AI clients like Claude Desktop.',
            [
              snippet(
                'text',
                'Available skills',
                'plaud-browse   → "list my recordings", "show recent files"\n' +
                  'plaud-find     → "find the Weekly Sync", "the meeting from Monday"\n' +
                  'plaud-read     → "show the transcript", "summarize this recording"\n' +
                  'plaud-digest   → "weekly report", "what meetings did I have this week"\n' +
                  'plaud-followup → "draft a follow-up email", "list the action items"\n' +
                  'plaud-export   → "save to Notion", "post to Slack"'
              ),
            ]
          ),
        ],
      },
    },
    references: [
      reference('Plaud MCP Documentation', 'https://docs.plaud.ai/documentation/plaud_app/mcp'),
      reference('Plaud CLI Documentation', 'https://docs.plaud.ai/documentation/plaud_app/cli'),
      reference('Plaud Developer Platform', 'https://docs.plaud.ai/documentation/index.md'),
      reference('Plaud App', 'https://plaud.ai'),
    ],
  },

  // ── Firecrawl ─────────────────────────────────────────────────────────────
  firecrawl: {
    id: 'firecrawl',
    name: 'Firecrawl',
    type: 'mcp_server',
    tagline: 'Web scraping and content extraction — already powering HCW content discovery.',
    requirements: [
      requirement('Firecrawl account', 'firecrawl.dev — free tier: 500 credits/month', true),
      requirement('API Key', 'Dashboard → API Keys', true),
    ],
    hcwUses: [
      {
        feature: 'Content Scraping Pipeline',
        usage:
          'Fetches and converts web pages to clean Markdown for ContentForge ingestion using @mendable/firecrawl-js SDK',
        files: ['functions/index.js (scrape functions)'],
        status: HCW_STATUS.ACTIVE,
      },
      {
        feature: 'Scrape Benchmark',
        usage: 'functions/test-scrape-fallback.js runs batch scraping quality tests',
        files: ['functions/test-scrape-fallback.js'],
        status: HCW_STATUS.ACTIVE,
      },
      {
        feature: 'AI Engine MCP',
        usage: 'Access Firecrawl tools via mcpProxy for Playground-based scraping',
        files: ['src/pages/admin/AIEnginePage.jsx'],
        status: HCW_STATUS.AVAILABLE,
      },
    ],
    sections: {
      install: {
        title: 'Install & Configure',
        steps: [
          docStep(
            'Configure the Azure MCP proxy',
            'The MCP proxy reads FIRECRAWL_API_KEY from the Azure Function App settings. In production, store it as an App Setting backed by Key Vault; do not put it in functions/.env or source control.',
            [snippet('text', 'Azure Function App setting', 'FIRECRAWL_API_KEY=fc-...')]
          ),
          docStep(
            'Enable via MCP (for Playground access)',
            'To call Firecrawl via the AI Engine MCP Servers tab, ensure the MCP server URL is set and toggle it on.',
            [
              snippet(
                'text',
                'Firecrawl MCP server settings',
                'Name:    Firecrawl\nURL:     https://mcp.firecrawl.dev/sse\nAuth:    FIRECRAWL_API_KEY (env var, already set)'
              ),
            ]
          ),
          docStep(
            'If you need a new API key',
            'Get a key at firecrawl.dev → Dashboard → API Keys. Add it to the Azure Function App settings, preferably as a Key Vault reference.',
            [snippet('text', 'Azure Function App setting', 'FIRECRAWL_API_KEY=fc-...')]
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Scrape a single URL',
            'Returns clean Markdown from any web page, including JavaScript-rendered content.',
            [
              snippet(
                'js',
                'SDK usage in Azure Functions',
                "const FirecrawlApp = require('@mendable/firecrawl-js').default;\n\n" +
                  'const app = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });\n' +
                  "const result = await app.scrapeUrl('https://example.com/article', {\n" +
                  "  formats: ['markdown'],\n" +
                  '});\n\nconsole.log(result.markdown);'
              ),
            ]
          ),
          docStep(
            'MCP tool via Playground',
            'In /admin/ai-engine → Playground → MCP Tool → Firecrawl, call the scrape tool.',
            [
              snippet(
                'json',
                'scrape tool arguments',
                '{ "url": "https://example.com/article", "formats": ["markdown"] }'
              ),
            ]
          ),
          docStep(
            'Crawl an entire site',
            'The crawl tool recursively fetches all pages from a domain — useful for auditing competitor sites.',
            [
              snippet(
                'js',
                'Crawl a site',
                "const crawlResult = await app.crawlUrl('https://example.com', {\n" +
                  '  limit: 50,\n' +
                  "  scrapeOptions: { formats: ['markdown'] },\n" +
                  '});'
              ),
            ]
          ),
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          docStep(
            'Disable the MCP server',
            'Toggle off in /admin/ai-engine → MCP Servers → Firecrawl. The SDK usage in functions/ is separate and will continue working.'
          ),
          docStep(
            'Remove the API key',
            'Remove FIRECRAWL_API_KEY from the Azure Function App settings / Key Vault and revoke the key in your Firecrawl dashboard.'
          ),
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          docStep(
            'Structured data extraction',
            'Use the extract mode with a JSON schema to pull structured data from any page — no CSS selectors needed.',
            [
              snippet(
                'js',
                'LLM-powered extraction',
                "const result = await app.scrapeUrl('https://example.com/product', {\n" +
                  "  formats: ['extract'],\n" +
                  '  extract: {\n' +
                  '    schema: {\n' +
                  "      type: 'object',\n" +
                  '      properties: {\n' +
                  "        title: { type: 'string' },\n" +
                  "        price: { type: 'number' },\n" +
                  "        description: { type: 'string' },\n" +
                  '      },\n' +
                  '    },\n' +
                  '  },\n' +
                  '});'
              ),
            ]
          ),
          docStep(
            'Credit usage',
            'Scraping one URL costs 1 credit. Crawling costs 1 credit per page. The free tier provides 500 credits/month. Monitor usage in the Firecrawl Dashboard.'
          ),
        ],
      },
    },
    references: [
      reference('Firecrawl Documentation', 'https://docs.firecrawl.dev'),
      reference('Firecrawl Dashboard', 'https://firecrawl.dev'),
      reference('Firecrawl JS SDK on npm', 'https://www.npmjs.com/package/@mendable/firecrawl-js'),
    ],
  },

  // ── Brave Search ─────────────────────────────────────────────────────────
  'brave-search': {
    id: 'brave-search',
    name: 'Brave Search',
    type: 'mcp_server',
    tagline: 'Real-time, privacy-respecting web search — no tracking, independent index.',
    requirements: [
      requirement(
        'Brave Search API account',
        'api.search.brave.com — free tier: 2,000 req/month',
        true
      ),
      requirement('API Key', 'Dashboard → Applications → Create app', true),
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
          docStep(
            '1. Create a Brave Search API account',
            'Sign up at api.search.brave.com. The free tier gives 2,000 requests/month with no credit card required.'
          ),
          docStep(
            '2. Create an application and get an API key',
            'In the Brave Search API Dashboard go to Applications → Create Application. Select the API plans you need (Web Search is sufficient). Copy the API key.'
          ),
          docStep(
            '3. Add the key to Azure Function App settings',
            'The Azure mcpProxy Function reads this key when calling the Brave Search MCP server. Prefer a Key Vault reference for production.',
            [snippet('text', 'Azure Function App setting', 'BRAVE_API_KEY=BSA...')]
          ),
          docStep(
            '4. Enable in AI Engine',
            'Go to /admin/ai-engine → MCP Servers → Brave Search → toggle On → Sync Tools.'
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Web search via Playground',
            'Go to /admin/ai-engine → Playground → MCP Tool → Brave Search → select brave_web_search.',
            [
              snippet(
                'json',
                'brave_web_search arguments',
                '{ "query": "AWS re:Invent 2026 announcements", "count": 10 }'
              ),
            ]
          ),
          docStep(
            'Combine with AI — search then summarize',
            'Use the Playground to first call Brave Search, then paste the results into an AI provider call to get a synthesized summary.'
          ),
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          docStep(
            'Disable and remove key',
            'Toggle off in AI Engine → MCP Servers → Brave Search. Remove BRAVE_API_KEY from the Azure Function App settings / Key Vault and revoke the application in the Brave Search API Dashboard.'
          ),
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          docStep(
            'Search parameters',
            'Brave Search supports country targeting, safe search, and freshness filtering.',
            [
              snippet(
                'json',
                'Advanced search arguments',
                JSON.stringify(
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
                )
              ),
            ]
          ),
        ],
      },
    },
    references: [
      reference(
        'Brave Search API Documentation',
        'https://api.search.brave.com/app/documentation/web-search/get-started'
      ),
      reference('Brave Search API Dashboard', 'https://api.search.brave.com/app/dashboard'),
    ],
  },

  // ── Context7 ─────────────────────────────────────────────────────────────
  context7: {
    id: 'context7',
    name: 'Context7 (Library Docs)',
    type: 'mcp_server',
    tagline: 'Up-to-date documentation for any npm/PyPI/crates package — free, no API key.',
    requirements: [
      requirement('No account required', 'Free public MCP server', false),
      requirement('No API key', 'Unauthenticated access', false),
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
          docStep(
            'Toggle on in AI Engine',
            "Go to /admin/ai-engine → MCP Servers → Context7 → toggle On → click Sync Tools. No API key or account is required — it's a free public server."
          ),
          docStep('MCP server URL', 'The server is pre-configured with the correct URL.', [
            snippet(
              'text',
              'MCP server details',
              'URL:       https://mcp.context7.com/mcp\nTransport: HTTP (Streamable HTTP)\nAuth:      None'
            ),
          ]),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Step 1 — Resolve the library ID',
            'First, resolve the exact library ID for the package you want docs for.',
            [snippet('json', 'resolve-library-id arguments', '{ "libraryName": "vite" }')]
          ),
          docStep(
            'Step 2 — Get the docs',
            'Use the resolved library ID (for example, "/vitejs/vite") to fetch documentation. Optionally specify a version and topic.',
            [
              snippet(
                'json',
                'get-library-docs arguments',
                JSON.stringify(
                  {
                    context7CompatibleLibraryID: '/vitejs/vite',
                    topic: 'plugins',
                    tokens: 5000,
                  },
                  null,
                  2
                )
              ),
            ]
          ),
          docStep(
            'Common HCW library IDs',
            'These are frequently useful when debugging HCW code.',
            [
              snippet(
                'text',
                'Frequently used library IDs',
                'React:              /facebook/react\n' +
                  'React Router:       /remix-run/react-router\n' +
                  'Vite:               /vitejs/vite\n' +
                  'Tailwind CSS:       /tailwindlabs/tailwindcss\n' +
                  'Axios:              /axios/axios'
              ),
            ]
          ),
        ],
      },
      uninstall: {
        title: 'Disable',
        steps: [
          docStep(
            'Toggle off',
            'Go to /admin/ai-engine → MCP Servers → Context7 → toggle Off. No credentials to revoke.'
          ),
        ],
      },
      advanced: {
        title: 'Advanced',
        steps: [
          docStep(
            'Token budget',
            'The tokens parameter controls how many tokens of documentation to return. Increase it for larger, more complete docs. The default is 5,000.',
            [
              snippet(
                'json',
                'Large docs request',
                '{ "context7CompatibleLibraryID": "/vitejs/vite", "tokens": 15000 }'
              ),
            ]
          ),
          docStep(
            'Version-specific docs',
            'Use the version parameter to get docs for a specific release — critical when your project pins a non-latest version.',
            [
              snippet(
                'json',
                'Version-pinned request',
                '{ "context7CompatibleLibraryID": "/facebook/react", "version": "18.3.0", "topic": "hooks" }'
              ),
            ]
          ),
        ],
      },
    },
    references: [
      reference('Context7 Website', 'https://context7.com'),
      reference('Context7 GitHub', 'https://github.com/upstash/context7'),
    ],
  },

  // ── AWS Knowledge Base ───────────────────────────────────────────────────
  'aws-knowledge-mcp': {
    id: 'aws-knowledge-mcp',
    name: 'AWS Knowledge Base',
    type: 'mcp_server',
    tagline: 'Retrieve AWS documentation, architecture patterns, and knowledge base details.',
    requirements: [requirement('Cluster Access', 'Runs inside the virtual network/cluster', true)],
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
          docStep(
            'Internal Cluster Service',
            'The AWS Knowledge MCP server is deployed within the internal cluster network and exposes its JSON-RPC endpoint at http://aws-docs-mcp:8000. It requires no additional API keys or installation.'
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Via the AI Engine Playground',
            'Go to /admin/ai-engine → Playground → MCP Tool → AWS Knowledge Base, select a tool and query.',
            [
              snippet(
                'json',
                'Arguments example',
                '{ "query": "S3 bucket lifecycle rules configuration" }'
              ),
            ]
          ),
        ],
      },
      uninstall: {
        title: 'Disable',
        steps: [
          docStep(
            'Toggle Off',
            'Go to /admin/ai-engine → MCP Servers → AWS Knowledge Base → toggle Off.'
          ),
        ],
      },
    },
    references: [
      reference(
        'AWS Knowledge MCP Server Repository',
        'https://github.com/awslabs/mcp-servers/tree/main/src/aws-knowledge-mcp-server'
      ),
    ],
  },

  // ── Microsoft Learn ──────────────────────────────────────────────────────
  'microsoftdocs-mcp': {
    id: 'microsoftdocs-mcp',
    name: 'Microsoft Learn / Docs',
    type: 'mcp_server',
    tagline: 'Retrieve Microsoft documentation, learning modules, and platform resources.',
    requirements: [requirement('Cluster Access', 'Runs inside the virtual network/cluster', true)],
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
          docStep(
            'Internal Cluster Service',
            'The Microsoft Learn MCP server is deployed within the internal cluster network and exposes its JSON-RPC endpoint at http://ms-learn-mcp:8000. It requires no additional API keys or installation.'
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Via the AI Engine Playground',
            'Go to /admin/ai-engine → Playground → MCP Tool → Microsoft Learn / Docs, select a tool and query.',
            [
              snippet(
                'json',
                'Arguments example',
                '{ "query": "Azure Kubernetes Service ingress Traefik setup" }'
              ),
            ]
          ),
        ],
      },
      uninstall: {
        title: 'Disable',
        steps: [
          docStep(
            'Toggle Off',
            'Go to /admin/ai-engine → MCP Servers → Microsoft Learn / Docs → toggle Off.'
          ),
        ],
      },
    },
    references: [
      reference('Microsoft Docs MCP Server Repository', 'https://github.com/microsoftdocs/mcp'),
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
      requirement('No installation required', 'Connects to the public Draw.io app server', false),
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
          docStep(
            'Public App Server',
            'The Draw.io MCP server connects directly to the public app bridge at https://mcp.draw.io/mcp. No local setup or installation is required.'
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Create diagrams via the Playground',
            'Select "Draw.io (Diagrams.net)" from the MCP server dropdown in the Playground and run the creation tools.',
            [
              snippet(
                'json',
                'Arguments example',
                '{\n  "prompt": "Create a flowchart showing a git push triggering a webhook that calls an Azure Function"\n}'
              ),
            ]
          ),
        ],
      },
      uninstall: {
        title: 'Disable',
        steps: [
          docStep(
            'Toggle Off',
            'Go to /admin/ai-engine → MCP Servers → Draw.io (Diagrams.net) → toggle Off.'
          ),
        ],
      },
    },
    references: [reference('Draw.io MCP Repository', 'https://github.com/jgraph/drawio-mcp')],
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
      requirement('Hostinger account', 'The account whose resources the tools act on', true),
      requirement(
        'Sign-in with Connect',
        'No API key or app setting: press Connect on the card and sign in at Hostinger. The token is kept server-side and renewed automatically.',
        true
      ),
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
          docStep(
            '1. Connect',
            'Go to /admin/ai-engine?tab=mcp → Hostinger MCP → Connect (super_admin). The browser goes to Hostinger; sign in and approve the “mcp:use” access. You return to the MCP Servers tab with “Hostinger MCP is connected. N tools synced.”'
          ),
          docStep(
            '2. Enable',
            'Toggle Hostinger MCP on (super_admin, as is calling its tools: the token is your Hostinger account). Its tools can change VPS, DNS and domain settings, so it ships off; switch it on only while you need it.'
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Query VPS info',
            'Playground → MCP Tool → Hostinger MCP → a VPS list tool. The tool list comes from Sync Tools after Connect.',
            [snippet('json', 'Arguments example', '{}')]
          ),
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          docStep(
            'Disconnect and disable',
            'Press Disconnect on the card (deletes the stored token) and toggle the server off. To revoke the access at Hostinger as well, remove HybridCloudWorks from the authorized apps in your Hostinger account.'
          ),
        ],
      },
    },
    references: [reference('Hostinger API Repository', 'https://github.com/hostinger/api/')],
  },

  // ── Replicate ────────────────────────────────────────────────────────────
  'replicate-mcp': {
    id: 'replicate-mcp',
    name: 'Replicate MCP',
    type: 'mcp_server',
    tagline:
      'Replicate’s hosted MCP server: search and run open-source models (images, audio, video, text) as tools.',
    requirements: [
      requirement('Replicate account', 'Runs are billed to the account that signs in', true),
      requirement(
        'Sign-in with Connect',
        'This server accepts only its own OAuth tokens, not REPLICATE_API_KEY. Press Connect on the card and sign in at Replicate.',
        true
      ),
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
          docStep(
            '1. Connect',
            'Go to /admin/ai-engine?tab=mcp → Replicate MCP → Connect (super_admin). Sign in at Replicate and approve. You return to the MCP Servers tab with “Replicate MCP is connected. N tools synced.”'
          ),
          docStep(
            '2. Enable',
            'Toggle Replicate MCP on (super_admin, as is calling its tools). Model runs cost money on the signed-in account.'
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep('Search models', 'Playground → MCP Tool → Replicate MCP → a model search tool.', [
            snippet('json', 'Arguments example', '{\n  "query": "flux"\n}'),
          ]),
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          docStep(
            'Disconnect and disable',
            'Press Disconnect on the card (deletes the stored token) and toggle the server off. REPLICATE_API_KEY is untouched: cover images still use it.'
          ),
        ],
      },
    },
    references: [reference('Replicate MCP documentation', 'https://replicate.com/docs/topics/mcp')],
  },

  // ── Publer ───────────────────────────────────────────────────────────────
  'publer-mcp': {
    id: 'publer-mcp',
    name: 'Publer MCP',
    type: 'mcp_server',
    tagline:
      'Publer’s own MCP server: accounts, drafts, posts, analytics and the Publer help corpus as tools.',
    requirements: [
      requirement(
        'Publer plan with MCP',
        'Settings → AI & Automations → MCP must be available on the account',
        true
      ),
      requirement(
        'PUBLER_API_KEY',
        'The Social Hub key, seeded on the Keys tab. The MCP reads it server-side.',
        true
      ),
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
          docStep(
            '1. Key',
            'PUBLER_API_KEY is already the Social Hub key. Its light on Integrations → Keys must be green. Do not paste Publer’s “Server URL”: it carries the key as ?api_key=, and the URL field refuses a query string on mcp.publer.com.'
          ),
          docStep(
            '2. Sync',
            'Go to /admin/ai-engine?tab=mcp → Publer MCP → Sync Tools. About 47 tools is right. Sync succeeds even with a bad key, so it proves the connection, not the key.'
          ),
          docStep(
            '3. Enable',
            'Toggle Publer MCP on (super_admin only for this server). The Playground only lists enabled servers that have synced tools. The card reads “34 of 47 tools allowed”: the allowed list ships with the seed and only a super_admin can change it.'
          ),
        ],
      },
      use: {
        title: 'Use',
        steps: [
          docStep(
            'Prove the key (read-only)',
            'Playground → MCP Tool → Publer MCP → get_publer_user. Good: your Publer name and plan. PERMISSION_DENIED with “Invalid API key or not active for this account” means the key is wrong or the plan has no MCP.',
            [snippet('json', 'Arguments', '{}')]
          ),
          docStep(
            'Never call from here',
            'submit_publer_posts, publish_publer_draft, update_publer_post, reschedule_publer_post, change_publer_post_state, confirm_delete_publer_posts, create_publer_post_from_file, create_publer_photo_draft, create_publer_ideas and the upload_publer_* tools write to Publer. delete_publer_posts deletes nothing itself, but it opens the delete preview that confirm_delete_publer_posts completes, so it is out too. None of the 13 is in the server’s allowed tools, and the API refuses a call to any of them whatever the role.'
          ),
        ],
      },
      uninstall: {
        title: 'Disconnect',
        steps: [
          docStep(
            'Disable',
            'Toggle Publer MCP off in the AI Engine. The key stays: the Social Hub and the calendar sync still use it.'
          ),
        ],
      },
    },
    references: [
      reference(
        'Publer: set up and use the MCP server',
        'https://publer.com/help/en/article/how-to-set-up-and-use-publers-mcp-server-14orlq0/'
      ),
      reference('Publer API documentation', 'https://publer.com/docs'),
    ],
  },
};

export default SERVICE_DOCS;

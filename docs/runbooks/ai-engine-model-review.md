# Review AI Engine models and costs

The [AI Engine](https://hybridcloudworks.com/admin/ai-engine) separates model
discovery from model selection. **Refresh model lists** reads the configured
providers' catalogues. It updates available choices and retirement status; it
does not replace a saved choice or rewrite recommendations. A provider refresh
failure preserves its previous models. An incomplete paginated response is a
failure, rather than evidence that models retired.

The Priority list selects chat models. Speech and image models belong on
[Tasks](https://hybridcloudworks.com/admin/ai-engine?tab=routing), where Custom
filters choices to the task's capabilities and product rules. A provider default
can select different models for drafting, analysis, images as input, and short
answers. Its eligibility model is not necessarily the model a particular
operation calls.

## Choose by workload

The existing recommendations implement the owner's provider and budget rules,
rather than a universal ranking. Their reasons and review dates are displayed
on Tasks. The following is the current recommendation policy, not a claim that
each model is the newest available or wins every benchmark.

| Workload | Existing recommendation | Reason and constraints |
| --- | --- | --- |
| Inspector, critique, grading, calibration, private assistant | Foundry GPT-5 mini | Structured responses and longer inputs; private assistant stays on Foundry. |
| Drafts, studio assistance, study scripts, podcast scripts | Foundry GPT-5 mini | Longer content generation under the existing subscription budget. |
| Captions and Telegram replies | Foundry GPT-5 nano | Short responses; lower published table rate than mini. |
| Alt text | Foundry GPT-5 mini | Image input; compare quality on representative images before changing. |
| Public explanations | Gemini Flash-Lite | Existing cached public path; NVIDIA trial tier is excluded. |
| Source grounding | Gemini Flash | Existing web-page and YouTube adapter. |
| Listen & Learn speech | Gemini 3.8 Flash TTS | Current long-form multi-speaker model; Flash-Lite is the cheaper Custom option. |
| Podcast voice | ElevenLabs v3 | Product is restricted to the existing ElevenLabs dialogue adapter. |
| Cover and manual images | Replicate Imagen 4 Fast | Existing image adapter and per-image pricing. |

Compare candidates using the same real workload: response validity, output
quality, latency, and cost for the expected input and output sizes. A one-word
connection Test establishes connectivity; it does not establish task quality or
which model is cheapest. Media task Test resolves routing without making paid
audio or images.

Recording transcripts, Page OCR, and Embeddings are **planned** registry entries
without connected implementations. Changing a model or key cannot enable them.
They do not expose routing controls until their adapters and call sites exist.

## Gemini speech review, 2026-10-27

Google's official [TTS cookbook](https://github.com/google-gemini/cookbook/blob/main/quickstarts/Get_started_TTS.ipynb)
names `gemini-3.8-flash-tts` and `gemini-3.8-flash-lite-tts`. It states that these
models speak text verbatim and take speaker information in `speech_metadata`
annotations. The adapter supports that request shape while retaining the
legacy prompt shape for older models. Both raw PCM and complete WAV replies
are converted to the existing MP3 output.

The new models are adapter-supported choices, not proof that the configured
account can use them. A provider listing confirms availability. Google's official
[pricing](https://ai.google.dev/gemini-api/docs/pricing) and
[speech guide](https://ai.google.dev/gemini-api/docs/speech-generation) were
verified on 2026-10-27 once documentation access became available:

| Model | Input / audio output per 1M tokens through 2026-12-31 | From 2027-01-01 |
| --- | --- | --- |
| Gemini 3.8 Flash TTS | $0.50 / $9 | $1 / $18 |
| Gemini 3.8 Flash-Lite TTS | $0.50 / $6 | $1 / $12 |

Flash TTS is the reviewed recommendation for long-form multi-speaker stability.
Flash-Lite is the lower-cost option for bulk production. Existing explicit
model selections survive migration. The adapter's legacy fallback remains
available for callers that do not use task routing.

Generated speech uses **25 audio tokens per second** when the provider supplies
no token counts. The earlier input-audio approximation of 32 tokens per second
overestimated output usage. Duration-derived counts remain marked estimated.
Published introductory prices have explicit expiration dates, shared by the
catalogue and usage recorder; they cannot silently remain permanent discounts.

The same review corrected Claude Opus 4.6 ($5 input / $25 output) and Haiku 4.5
($1 / $5), and added published standard token rates for current OpenAI GPT-6
models, Claude Opus/Sonnet 5.5, Gemini 3.8 Flash, and Gemini 4 Argon. Sources:
[OpenAI pricing](https://developers.openai.com/api/docs/pricing) and
[Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing).
Foundry deployments, explicit model choices, and public-route provider rules
remain in force; a newer public model is not evidence of an available Azure
deployment. Token estimates do not include provider-specific cache discounts,
long-context surcharges, grounding/tool fees, or account discounts. Live
production account configuration and provider invoices were not accessed.

## Interpret usage costs

[Usage & Cost](https://hybridcloudworks.com/admin/ai-engine?tab=usage) shows the
last 200 recorded calls, not a complete monthly bill. Missing costs and
unpriced models are excluded from subtotals and explicitly marked unknown.
A confirmed zero-cost trial call remains distinct from an unknown price.
Small nonzero costs retain enough precision to remain visible.

New calls require a model-specific confirmed rate rather than an unrelated
provider default. Image callers supply their per-image cost explicitly.
Speech estimates return unknown when the selected model has no confirmed
rate. Existing stored cost rows are not rewritten by a refresh or a rate-table
change; historical unknowns need separate reconciliation against provider
usage or billing evidence.

Before revising a recommendation, verify its current API support and pricing,
update the dated reason and model-specific rate together, then validate both
the recommendation and the configured provider's availability. Documentation
access alone does not establish account authorization or a live model response.

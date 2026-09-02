# Free / Free-Tier OpenAI-Compatible LLM API Providers

**Compiled: 2026-08-27** (note: request said "2025", but current date is Aug 2026 — all facts verified live against official docs on this date).
All entries verified by reading official docs / live endpoints unless marked ⚠️.

**Verdict legend:** ✅ truly $0 (perpetual free tier) · 🟡 free credits / trial (one-time or capped) · ❌ no longer free · ☠️ retired

---

## 1. Groq — ✅ truly $0 free plan
- **BASE_URL:** `https://api.groq.com/openai/v1` (also supports the OpenAI **Responses API**)
- **AUTH:** `Authorization: Bearer $GROQ_API_KEY` — free key at https://console.groq.com (API Keys page), no card required
- **Free models + Free Plan limits** (official rate-limits table):
  | Model | RPM | RPD | TPM | TPD |
  |---|---|---|---|---|
  | `openai/gpt-oss-120b` | 30 | 1,000 | 8K | 200K |
  | `openai/gpt-oss-20b` | 30 | 1,000 | 8K | 200K |
  | `qwen/qwen3.6-27b` | 30 | 1,000 | 8K | 200K |
  | `qwen/qwen3.8-27b` | 30 | 1,000 | 8K | 2M |
  | `groq/compound-mini`, `groq/compound` | 30 | 250 | 70K | – |
  | `whisper-large-v3` / `-turbo` (audio) | 20 | 2,000 | – | – |
- ⚠️ Note: `llama-3.1-8b-instant` and `llama-3.3-70b-versatile` are now **Enterprise-only** (Contact Sales) — no longer on the free plan.
- **Docs:** [OpenAI compatibility](https://console.groq.com/docs/openai) · [Rate limits](https://console.groq.com/docs/rate-limits) · [Models](https://console.groq.com/docs/models)

## 2. Google AI Studio / Gemini API — ✅ truly $0 free tier
- **BASE_URL:** `https://generativelanguage.googleapis.com/v1beta/openai/` (chat/completions **and** /responses)
- **AUTH:** `Authorization: Bearer $GEMINI_API_KEY` (or `x-goog-api-key` header) — free key at https://aistudio.google.com/apikey
- **Free models** (pricing page lists them as "Free of charge" on Free Tier): `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.5-pro`
- **Free-tier rate limits:** the per-model RPM/TPM/RPD table on the official rate-limits page is **client-side rendered** (couldn't be scraped). Officially confirmed: free tier is per-project, RPD resets midnight Pacific; the official [gemini-cli quota doc](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md) states free-tier (unpaid API key) = **max 250 model requests/day, Flash models only**. ⚠️ Third-party trackers report per-model numbers like gemini-2.5-flash 10 RPM / 250K TPM / 250 RPD, Flash-Lite 15 RPM / 1,000 RPD — treat as approximate.
- ⚠️ Free-tier prompts/outputs are used to improve Google's products.
- **Docs:** [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai) · [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) · [Pricing](https://ai.google.dev/gemini-api/docs/pricing) · [Models](https://ai.google.dev/gemini-api/docs/models)

## 3. Mistral La Plateforme — ✅ truly $0 "Free mode"
- **BASE_URL:** `https://api.mistral.ai/v1` (endpoint verified live — `/v1/models` returns 401 without key)
- **AUTH:** `Authorization: Bearer $MISTRAL_API_KEY` — key at https://console.mistral.ai. No credit card required; **phone verification required** (⚠️ per third-party live-test).
- **Free models:** Free mode is the default access mode: "Includes monthly usage with rate limits suitable for evaluation and prototyping" (official docs string). ⚠️ Which exact models: third-party live tests ([freellm.net](https://freellm.net/providers/mistral-ai), [pricepertoken](https://pricepertoken.com/endpoints/mistral/free)) report access incl. `mistral-small-latest`, `mistral-medium-latest`, `mistral-large-latest`, `codestral`, `ministral-3b/8b/14b`, `open-mistral-7b`, `open-mixtral-8x7b`.
- **Limits:** official help center: enforced as RPS + tokens/min + tokens/month; ⚠️ third-party: ~1 RPS, ~500K TPM, ~1B tokens/month. Exact per-model numbers only visible on the Admin-panel Limits page (login required). Data may be used for improvement unless opted out.
- **Docs:** [Usage & limits](https://docs.mistral.ai/admin/billing-usage/usage-limits) · [Help center: rate limits](https://help.mistral.ai/en/articles/698531-why-am-i-hitting-api-rate-limits-and-how-do-i-increase-them)

## 4. Cerebras — 🟡 free trial ($5 credits + rate limits)
- **BASE_URL:** `https://api.cerebras.ai/v1`
- **AUTH:** `Authorization: Bearer $CEREBRAS_API_KEY` — key at https://cloud.cerebras.ai
- **Free models (only 2 public models currently):** `gpt-oss-120b` (~3000 tok/s), `gemma-4-31b` (~1850 tok/s)
- **Free Trial tier limits** (official): gpt-oss-120b: **5 RPM / 30K TPM / 1M TPH / 1M TPD**; gemma-4-31b: **1 RPM / 30K TPM / 1M TPH / 1M TPD**
- **Free-trial economics:** official pricing page: "**$5 in free credits** after making an account"; Developer (pay-as-you-go) starts at $10. So: credit-based, not perpetual $0.
- **Docs:** [Quickstart](https://inference-docs.cerebras.ai/quickstart) · [Rate limits](https://inference-docs.cerebras.ai/support/rate-limits) · [Model catalog](https://inference-docs.cerebras.ai/models/overview) · [Pricing](https://www.cerebras.ai/pricing)

## 5. Together AI — ❌ no longer free
- **BASE_URL:** `https://api.together.ai/v1` (OpenAI-compatible, official)
- **Official billing docs:** "Together AI **does not currently offer free trials**. Access requires a **minimum $5 credit purchase**. Fully prepaid — you need a positive credit balance."
- One model is priced $0 (`Prism-ML/Ternary-Bonsai-27B`, input/output "Free" in the serverless model table), but platform access still requires a positive balance.
- Rate limits are now **dynamic per-model** (no fixed published numbers).
- **Docs:** [Credits/billing](https://docs.together.ai/docs/billing-credits) · [OpenAI compatibility](https://docs.together.ai/docs/inference/openai-compatibility) · [Serverless models](https://docs.together.ai/docs/serverless/models) · [Rate limits](https://docs.together.ai/docs/serverless/rate-limits)

## 6. SambaNova Cloud — ✅ truly $0 free tier
- **BASE_URL:** `https://api.sambanova.ai/v1` (chat/completions **and** `/v1/responses` Responses API)
- **AUTH:** `Authorization: Bearer <key>` — free key at https://cloud.sambanova.ai/apis. Free Tier applies automatically **when no payment method is linked**.
- **Free models + limits** (official rate-limits page):
  | Model | RPM | RPD | TPD |
  |---|---|---|---|
  | `DeepSeek-V3.1` (production) | 20 | 20 | 200K |
  | `Meta-Llama-3.3-70B-Instruct` (production) | 20 | 20 | 200K |
  | `gpt-oss-120b` (production) | 20 | 20 | 200K |
  | `DeepSeek-V3.2` (preview) | 20 | 20 | 200K |
  | `gemma-4-31B-it` (preview) | 20 | 20 | 200K |
  (Note: free-tier RPD is quite low — 20 requests/day.)
- **Docs:** [Rate limits](https://docs.sambanova.ai/docs/en/models/rate-limits) · [OpenAI compatibility](https://docs.sambanova.ai/docs/en/features/openai-compatibility) · [API keys & URLs](https://docs.sambanova.ai/docs/en/get-started/api-keys-urls)
- ⚠️ Prod docs site bot-blocked curl; content verified via the identical docs-preprod deployment + search snippets of the prod URL.

## 7. OpenRouter — ✅ truly $0 for `:free` model variants
- **BASE_URL:** `https://openrouter.ai/api/v1`
- **AUTH:** `Authorization: Bearer $OPENROUTER_API_KEY` — key at https://openrouter.ai/settings/keys (free account)
- **Free models:** any model ID ending in `:free`. **Live API check today: 18 free variants**, incl. `z-ai/glm-5.2:free`, `minimax/minimax-m3:free`, `nvidia/nemotron-3-ultra-550b-a55b:free`, `google/gemma-4-31b-it:free`, `cohere/north-mini-code:free`, `thinkingmachines/inkling:free`, `minimax/minimax-m2.7:free`
- **Free limits** (constants extracted from the official docs page bundle): **20 RPM**; **50 requests/day** if you've purchased < $10 credits all-time; **1,000 requests/day** if ≥ $10 purchased.
- **Docs:** [Quickstart](https://openrouter.ai/docs/quickstart) · [Limits](https://openrouter.ai/docs/api-reference/limits)

## 8. GitHub Models — ☠️ RETIRED 2026-07-30
- Official docs: "**As of July 30, 2026, GitHub Models has been fully retired.** The playground, model catalog, inference API, and bring your own key (BYOK) are no longer available to any customer." The old Azure endpoint (`models.inference.ai.azure.com`) was deprecated 2025-07-17.
- Suggested replacements: Azure AI Foundry, GitHub Copilot.
- **Docs:** [docs.github.com/en/github-models](https://docs.github.com/en/github-models) · [REST models/inference](https://docs.github.com/en/rest/models/inference) · [changelog](https://github.blog/changelog/2025-07-17-deprecation-of-azure-endpoint-for-github-models/)

## 9. Cloudflare Workers AI — ✅ truly $0 daily free allocation
- **BASE_URL:** `https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1` (supports `/v1/chat/completions`, `/v1/embeddings`, and `/v1/responses`)
- **AUTH:** `Authorization: Bearer {CF_API_TOKEN}` — token from Cloudflare dashboard (needs Workers AI permission); account ID from dashboard URL
- **Free models (examples from official pricing):** `@cf/meta/llama-3.1-8b-instruct`, `@cf/meta/llama-3.2-1b-instruct`, `@cf/meta/llama-3.2-3b-instruct`, `@cf/meta/llama-3.1-70b-instruct-fp8-fast`, `@cf/openai/gpt-oss-120b`
- **Limits:** **10,000 Neurons/day free** (resets 00:00 UTC) on both Free and Paid plans; beyond that $0.011/1,000 neurons (Paid plan). ⚠️ Some frontier models (`@cf/moonshotai/kimi-k2.6`, `@cf/zai-org/glm-5.2`, `@cf/deepseek-ai/deepseek-v4-*`, …) require paid billing.
- **Docs:** [OpenAI-compatible endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/) · [Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

## 10. Cohere — 🟡 free trial/evaluation key ($0, capped)
- **BASE_URL:** `https://api.cohere.ai/compatibility/v1` (official OpenAI SDK Compatibility API)
- **AUTH:** `Authorization: Bearer $COHERE_API_KEY` — free **trial (evaluation) key** at https://dashboard.cohere.com/api-keys, no card required
- **Free models:** `command-a-plus-05-2026`, `command-a-reasoning`, `command-a`, `command-r-plus`, `command-r`, `command-r7b`, `north-mini-code`
- **Limits (official):** trial keys = **1,000 API calls/month** and **20 req/min** per chat model. Not for production.
- **Docs:** [Using the OpenAI SDK (Compatibility API)](https://docs.cohere.com/docs/compatibility-api) · [Rate limits & key types](https://docs.cohere.com/docs/rate-limits)

## 11. Hugging Face Inference Providers — 🟡 small monthly free credits
- **BASE_URL:** `https://router.huggingface.co/v1` (OpenAI-compatible chat/completions; routed across providers)
- **AUTH:** `Authorization: Bearer $HF_TOKEN` — free User Access Token at https://huggingface.co/settings/tokens
- **Free models:** models routed via "Routed by Hugging Face" / `hf-inference`, e.g. `openai/gpt-oss-120b:fastest` (docs example); free-tier credits apply to eligible providers/models.
- **Limits (official pricing page):** free users get **$0.10/month credits** ("subject to change"); PRO $2.00/month; Team/Enterprise $2.00/seat. Pay-as-you-go after credits.
- **Docs:** [Inference Providers overview](https://huggingface.co/docs/inference-providers/index) · [Pricing/free credits](https://huggingface.co/docs/inference-providers/pricing) · [First API call](https://huggingface.co/docs/inference-providers/guides/first-api-call)

## 12. NVIDIA NIM / build.nvidia.com (bonus) — 🟡 free developer access, details ⚠️
- **BASE_URL:** `https://integrate.api.nvidia.com/v1` (OpenAI-compatible, confirmed in official NIM API reference)
- **AUTH:** `Authorization: Bearer $NV_API_TOKEN` — free key via https://build.nvidia.com (no card)
- **Free models:** 100+ hosted models (Llama, Nemotron, DeepSeek, GLM, gpt-oss…) — model list is dynamic on build.nvidia.com
- **Limits:** ⚠️ not officially published in the docs I could fetch; third-party reports (Jul 2026) say **40 RPM** and signup free credits (historically 1,000 credits). Treat numbers as uncertain.
- **Docs:** [NIM LLM API reference](https://docs.api.nvidia.com/nim/reference/llm-apis) · [build.nvidia.com](https://build.nvidia.com/)

## 13. DeepSeek (bonus) — 🟡 one-time new-account grant, then paid
- **BASE_URL:** `https://api.deepseek.com` (officially OpenAI/Anthropic-compatible)
- **AUTH:** `Authorization: Bearer $DEEPSEEK_API_KEY`
- **Free status:** no perpetual free tier; ⚠️ third-party trackers report a **one-time ~5M-token grant** for new accounts (no card), then pay-per-token. Models: `deepseek-v4-flash`, `deepseek-v4-pro`.
- **Docs:** [api-docs.deepseek.com](https://api-docs.deepseek.com/) · [pricing](https://api-docs.deepseek.com/quick_start/pricing/)

---

## Quick comparison

| Provider | Verdict | Free budget | OpenAI-compat base |
|---|---|---|---|
| Groq | ✅ $0 | ~1K req/day per model | `https://api.groq.com/openai/v1` |
| Google AI Studio | ✅ $0 | ~250 req/day (Flash) | `https://generativelanguage.googleapis.com/v1beta/openai/` |
| Mistral | ✅ $0 | ~1B tok/mo ⚠️ | `https://api.mistral.ai/v1` |
| SambaNova | ✅ $0 | 20 req/day per model | `https://api.sambanova.ai/v1` |
| OpenRouter `:free` | ✅ $0 | 50 req/day (<$10 credits) | `https://openrouter.ai/api/v1` |
| Cloudflare Workers AI | ✅ $0 | 10K neurons/day | `https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1` |
| Cohere | 🟡 trial key | 1,000 calls/mo | `https://api.cohere.ai/compatibility/v1` |
| Hugging Face | 🟡 credits | $0.10/mo | `https://router.huggingface.co/v1` |
| Cerebras | 🟡 credits | $5 one-time | `https://api.cerebras.ai/v1` |
| NVIDIA NIM | 🟡 free dev access ⚠️ | ~40 RPM ⚠️ | `https://integrate.api.nvidia.com/v1` |
| DeepSeek | 🟡 one-time grant ⚠️ | ~5M tokens ⚠️ | `https://api.deepseek.com` |
| Together AI | ❌ paid only | min $5 purchase | `https://api.together.ai/v1` |
| GitHub Models | ☠️ retired 2026-07-30 | — | — |

# Image Generation

Axiom can generate and edit images through dedicated **image generation models**. They are configured per provider, kept strictly apart from text (chat) models, and used by the agent through the `generate_image` tool. Results are saved as files in the workspace and delivered with `send_file_to_user`.

Three provider types offer image models:

| Provider type | How it is paid | Models |
|---|---|---|
| **OpenRouter** (API key) | per image, OpenRouter reports the billed amount | pi-ai image catalog, or OpenRouter's live list |
| **OpenAI** (API key) | per token, Axiom estimates the cost from OpenAI's list prices | GPT Image models (`gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2`, `gpt-image-1.5`, `gpt-image-1`, `gpt-image-1-mini`), or the key's live list |
| **ChatGPT Plus/Pro (Codex)** (OAuth login) | included in the ChatGPT subscription, counts toward its Codex usage limits | one model: *GPT Image (ChatGPT subscription)* |

See [Image backends](#image-backends) for the differences in parameters, limits and availability checks.

## Image models vs. text models

| | Text models | Image models |
|---|---|---|
| Stored in `providers.json` as | `enabledModels` | `enabledImageModels` |
| Catalog | pi-ai text catalog (or the live `/models` list) | pi-ai **image** catalog plus Axiom's OpenAI/ChatGPT entries (or the provider's live image list) |
| Used by | chat, tasks, cronjobs, consolidation, fact extraction, … | `generate_image` only |
| Shown in model pickers (Settings, `/model`, task restart, cronjobs) | yes | **no** — only in *Settings → Image Generation → Default image model* |
| Listed in the system prompt | `<available_providers>` text list (description-gated) | separate *Image generation models* block (always all) |
| Thinking levels, context window, token costs | yes | no — billed per image, per token, or included in a subscription |

Image models are added under [Providers → Image models](../web-ui/providers#image-models). The same model id may in principle exist in both lists (some OpenRouter models can chat *and* draw), but each list is managed separately.

## Image backends

Each provider type talks to its own image API. OpenRouter uses its dedicated Image API (`POST …/images`, input images as data URLs in `input_references`); the OpenAI and ChatGPT ones share one wire format (`POST …/images/generations`, `POST …/images/edits` with input images as data URLs).

| | OpenRouter | OpenAI (API key) | ChatGPT subscription (Codex login) |
|---|---|---|---|
| Endpoint | `https://openrouter.ai/api/v1/images` | `https://api.openai.com/v1/images/…` | `https://chatgpt.com/backend-api/codex/images/…` |
| Model choice | any OpenRouter image model | any GPT Image model the key can use | none — ChatGPT picks the renderer (currently GPT Image 2) |
| `aspect_ratio` | sent as `aspect_ratio`; the provider clamps it to its supported ratios | converted to `size`: exact (multiples of 16, 1:3 to 3:1) for GPT Image 2 and newer, the closest of 1024x1024 / 1536x1024 / 1024x1536 for older models | ignored |
| `quality` | ignored | `low`, `medium`, `high`, `auto` | ignored |
| `background` | ignored | `transparent`, `opaque`, `auto`; `gpt-image-2` cannot render transparency | `transparent`, `opaque`, `auto` |
| Variants (`n`) | parallel | parallel | one after another |
| Input images | up to 8 | up to 8 | up to 5 |
| Cost | billed amount from the response (`usage.cost`) | estimated: reported tokens × OpenAI list price | none; counts toward the Codex usage limits |
| [Free availability check](../web-ui/providers#image-model-rows) | `GET /models/<id>/endpoints` and `GET /key` | `GET /v1/models/<id>` with the key | `GET /backend-api/wham/usage`: login valid, plan is not *Free*, usage limit not reached |
| Live model list | `GET /models?output_modalities=image` | `GET /v1/models`, filtered to `gpt-image-*` / `chatgpt-image-*` | no (one fixed model) |

Ignored or adjusted parameters are never silent: the tool result and the Providers test image list them as notes (e.g. *"aspect_ratio 16:9 was sent as 1536x1024"*). Parameters a model cannot honour at all (a transparent background on `gpt-image-2`, an aspect ratio beyond 3:1) are refused before anything is sent or billed.

### ChatGPT subscription

A ChatGPT Plus/Pro provider (the same OAuth login used for Codex chat models) generates images the way the Codex CLI does. Things to know:

- **The model cannot be chosen.** The ChatGPT backend accepts any model id — even an invalid one — and generates with the model it picks. Size and quality are chosen by the backend as well (tested October 2026: every request came back as `low` quality at sizes like 1254x1254, whatever was requested). Axiom therefore offers exactly one image model for this provider type and sends the same request the Codex CLI sends. Describe the format in the prompt if it matters.
- **Usage limits.** No API costs, but image generations count toward the plan's Codex usage limits (OpenAI: 3–5× faster than comparable chat turns). The backend also reports a separate daily image limit in its response headers; the tool result shows it, e.g. *"ChatGPT image limit: 2% used of the 24 h window"*. The *Free* plan cannot generate images.
- **Unofficial endpoint.** The endpoint is the one the Codex CLI uses with a ChatGPT login, not a documented public API, so OpenAI may change it without notice.

To pick the image model, size and quality yourself, use an **OpenAI** API key provider instead (billed per token).

## Settings → Image Generation

The [Image Generation settings tab](../settings/image-generation) controls how the agent may use the image models:

| Setting | Key in `settings.json` | Default |
|---|---|---|
| Enabled | `imageGeneration.enabled` | `true` |
| Default image model | `imageGeneration.defaultModel` | `""` (first enabled image model) |
| Max variants per call | `imageGeneration.maxVariants` | `4` (range 1–10) |
| Output folder | `imageGeneration.outputDir` | `images` |

The tab also shows a read-only list of all enabled image models with their descriptions, each linking to its provider. Models themselves (key, availability check, credit balance) stay owned by the provider under [Providers → Image models](../web-ui/providers#image-models).

### Default image model

The [default image model](../settings/image-generation#default-image-model) is the single place that decides which model `generate_image` uses when the agent does not pick one. It is stored as `imageGeneration.defaultModel` (`providerId:modelId`) in `settings.json`. When it is empty or points at a model that is no longer enabled, the first enabled image model is used. Disabling the provider resets the setting.

## The `generate_image` tool

The tool is registered only while image generation is **switched on** (`imageGeneration.enabled`, default on) **and** at least one image model is usable (enabled, on an enabled provider). The interactive agent re-checks both before every turn, background agents whenever the setting or the image models change — no restart needed. While switched off, the tool, the *Image generation models* prompt block, the `generate_image` line in `<available_tools>` and the `image-generation` skill listing are all absent; a background task that still holds the tool gets a clear "switched off" error instead of a generation.

| Parameter | Required | Notes |
|---|---|---|
| `prompt` | yes | Detailed description of the image. |
| `model` | no | `providerId:modelId`, `providerName:modelId` or a bare model id. Defaults to the default image model. |
| `aspect_ratio` | no | e.g. `"1:1"`, `"16:9"`, `"9:16"`. How it is applied depends on the [backend](#image-backends). |
| `quality` | no | `low`, `medium`, `high` or `auto`. Honoured by OpenAI GPT Image models; higher quality costs more and takes longer. |
| `background` | no | `transparent`, `opaque` or `auto`. `transparent` yields a PNG with alpha channel (OpenAI GPT Image models except `gpt-image-2`, and the ChatGPT subscription). |
| `n` | no | Number of variants, from `1` up to [Max variants per call](../settings/image-generation#max-variants-per-call) (default `4`). The limit is part of the parameter definition; a larger `n` is refused before anything is generated. Each variant is a separate request, billed separately; they run in parallel except on a ChatGPT subscription. |
| `input_images` | no | Workspace-relative (or absolute) paths of PNG/JPEG/WebP/GIF images to edit, combine or use as reference (max 8, 20 MB each; max 5 on a ChatGPT subscription). Only models that accept image input can use them. |

### Output files

Every image is written to the workspace, under the configured [output folder](../settings/image-generation#output-folder) (default `images`):

```text
/workspace/images/YYYY-MM-DD/<slug>.<ext>          # single image
/workspace/images/YYYY-MM-DD/<slug>-1.<ext> …       # n > 1
/workspace/images/YYYY-MM-DD/<file>.json            # sidecar per image
```

- `<slug>` is derived from the first words of the prompt. Existing files are never overwritten — a numeric suffix is added instead.
- The extension follows the returned MIME type: `png`, `jpg`, `webp`, `svg` (Recraft vector models), `gif`.
- The output folder must stay inside the workspace; absolute paths and `..` escapes are rejected when the setting is saved.
- The sidecar (`<file>.json`, e.g. `logo.svg.json`) records model, provider, prompt, parameters (`aspectRatio`, `quality`, `background`, `n`, `inputImages`), duration, the cost, how it was billed (`billing`: `reported`, `estimated` or `subscription`) and the provider's generation id.

The tool result lists the relative paths, format, file size, the cost (or *"included in the ChatGPT subscription"*), the duration and any parameter notes. It **never** contains image data, so a generation does not blow up the context window. To show an image to the user, the agent calls [`send_file_to_user`](./tools#user-delivery) with the path (web chat shows a preview, Telegram sends raster images as photos and SVG files as documents).

### Errors

Provider errors (invalid key, insufficient credits, an exhausted ChatGPT usage limit, content policy, timeouts) are returned as a clear error message instead of failing the turn. A response without an image — for example a refusal — is reported as *"The model returned no image"*, together with any text the model sent. With `n > 1`, partial failures are listed next to the images that did succeed.

Each request times out after **6 minutes**. Most models finish in 20–60 s, but GPT Image 2 at high quality regularly needs 2–5 minutes per image, and an abandoned request is still billed.

## Cost tracking

pi-ai's token-based estimate is far off for image models (zero for most of them), so the cost comes from the backend:

- **OpenRouter** — the **billed amount** OpenRouter reports in each response (`usage.cost`).
- **OpenAI** — an **estimate**: the reported text-input, image-input and image-output tokens multiplied by OpenAI's list prices, which Axiom ships per model (e.g. $30 per 1M image output tokens for GPT Image 2/2.5, $8 for GPT Image 1 Mini). Dated snapshots such as `gpt-image-2-2026-04-21` use the price of their base model; models without a known price report the cost as *unknown*. The Providers page shows the price per 1M output tokens next to each OpenRouter and OpenAI image model and, once three images were billed, the average cost of the last five images.
- **ChatGPT subscription** — no cost (`0`); the image counts toward the plan's usage limits instead.

The cost is used for:

- the tool result and the sidecar file,
- the [Token Usage](../web-ui/token-usage) page — every generated variant (one provider request) is booked as its own `token_usage` row for the image model (interactive chats on the current session, background tasks and the Providers test image without a session).

Typical OpenRouter prices seen in testing: Recraft V4.1 ≈ $0.035, GPT-5 Image Mini ≈ $0.04, Gemini 3.1 Flash Image ≈ $0.07, Recraft V4.1 Vector (SVG) ≈ $0.08 per image. Check [`provider_quota`](./tools#provider-quota) for the remaining OpenRouter credit or the ChatGPT/Codex usage windows.

Axiom does not cap spending per call. Spending limits belong on the provider's API key (e.g. an OpenRouter key limit or an OpenAI project budget).

## System prompt

When image generation is switched on and at least one image model is usable, `<available_providers>` gains an *Image generation models* block that lists every usable image model with its provider, id, the description from the [image model edit dialog](../web-ui/providers#image-models) and a *default image model* label. It also states that these models are only for `generate_image`. `<available_tools>` gains a `generate_image` line. See [System Prompt](./system-prompt#_8-available-providers-configured-llm-providers).

## The `image-generation` skill

The built-in [`image-generation` skill](./skills#currently-shipped) carries the workflow the tool description points to: when to generate, how to write a detailed prompt, generating variants within the configured limit, optional self-checks, delivery via `send_file_to_user`, iterating with `input_images` instead of re-rolling, model choice (from the descriptions you give each image model) and cost awareness (`provider_quota` before batch runs, no base64 in chat). It declares `requires_toolsets: [generate_image]`, so it only appears in `<available_skills>` while the tool is available.

## Migration of existing configurations

Before image models had their own list, image-only models could only be added as text models (where every chat request to them failed). On the first load after the update, Axiom moves every id from `enabledModels` to `enabledImageModels` when the provider type's image catalog lists it and its text catalog does not — for example `openai/gpt-5-image-mini`, `google/gemini-3.1-flash-image` or `recraft/recraft-v4.1` on OpenRouter, or `gpt-image-1` on OpenAI. The change is written back to `providers.json` once.

Ids are left as text models when they are also chat models in pi-ai's text catalog (e.g. `google/gemini-3-pro-image`, `openrouter/auto`) or when they are currently the active or fallback model, so a running chat setup never changes underneath you. Per-model descriptions and display names are kept. A provider that only had image models ends up with no text models — it simply disappears from the text model pickers.

## Limitations

- **OpenRouter, OpenAI and ChatGPT only.** Other providers show no *Add image model* action.
- **ChatGPT subscription:** no choice of model, size or quality, and the endpoint is not a public API (see [above](#chatgpt-subscription)).
- **OpenAI costs are estimates** based on list prices shipped with Axiom; check the OpenAI usage dashboard for the billed amount.
- **Long generations in chat.** While `generate_image` runs, the chat [provider-stall watchdog](../reference/settings#watchdog) uses its own thresholds instead of `watchdog.*`: the stall warning appears after 5 minutes and the turn is aborted after 7 minutes, both multiplied by `n` because ChatGPT-subscription variants run one after another.
- **Remote image URLs** are not supported; a model must return inline image data.
- **No built-in vision self-check.** Axiom's file tools return text, so the agent cannot look at the generated pixels unless you give it a way to query a vision model.
- **`aspect_ratio`** is forwarded to OpenRouter, but whether a given model honours it is up to the model.
- **Variants on a ChatGPT subscription** run one after another, so `n: 4` takes about four times as long as one image.

## See also

- [Providers → Image models](../web-ui/providers#image-models) — enabling models, live model lists, availability check, test image.
- [Settings → Image Generation](../settings/image-generation) — on/off switch, default image model, limits, output folder.
- [Built-in Tools](./tools#generate-image) — the tool registry.
- [`settings.json` → `imageGeneration`](../reference/settings#imagegeneration) and [`providers.json` → `enabledImageModels`](../reference/settings#providerconfig)

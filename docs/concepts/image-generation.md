# Image Generation

Axiom can generate and edit images through dedicated **image generation models**. They are configured per provider, kept strictly apart from text (chat) models, and used by the agent through the `generate_image` tool. Results are saved as files in the workspace and delivered with `send_file_to_user`.

Today **OpenRouter** is the only image backend. The implementation is keyed on pi-ai's image API (`openrouter-images`), so further backends can be added later.

## Image models vs. text models

| | Text models | Image models |
|---|---|---|
| Stored in `providers.json` as | `enabledModels` | `enabledImageModels` |
| Catalog | pi-ai text catalog (or the live `/models` list) | pi-ai **image** catalog |
| Used by | chat, tasks, cronjobs, consolidation, fact extraction, … | `generate_image` only |
| Shown in model pickers (Settings, `/model`, task restart, cronjobs) | yes | **no** — only in *Settings → Tasks → Default image model* |
| Listed in the system prompt | `<available_providers>` text list (description-gated) | separate *Image generation models* block (always all) |
| Thinking levels, context window, token costs | yes | no — billed per image |

Image models are added under [Providers → Image models](../web-ui/providers#image-models). The same model id may in principle exist in both lists (some OpenRouter models can chat *and* draw), but each list is managed separately.

## Default image model

[Settings → Tasks → Default image model](../settings/tasks#default-image-model) is the single place that decides which model `generate_image` uses when the agent does not pick one. It is stored as `imageGeneration.defaultModel` (`providerId:modelId`) in `settings.json`. When it is empty or points at a model that is no longer enabled, the first enabled image model is used. Disabling the provider resets the setting.

## The `generate_image` tool

The tool is registered only while at least one image model is usable (enabled, on an enabled provider). The interactive agent re-checks this before every turn, background agents whenever image models change — no restart needed.

| Parameter | Required | Notes |
|---|---|---|
| `prompt` | yes | Detailed description of the image. |
| `model` | no | `providerId:modelId`, `providerName:modelId` or a bare model id. Defaults to the default image model. |
| `aspect_ratio` | no | e.g. `"1:1"`, `"16:9"`, `"9:16"`. Sent to OpenRouter as `image_config.aspect_ratio`; not every model honours it. |
| `n` | no | Number of variants, `1`–`4`. Each variant is a separate request; they run in parallel and are billed separately. |
| `input_images` | no | Workspace-relative (or absolute) paths of PNG/JPEG/WebP/GIF images to edit, combine or use as reference (max 8, 20 MB each). Only models that accept image input can use them. |

### Output files

Every image is written to the workspace:

```text
/workspace/images/YYYY-MM-DD/<slug>.<ext>          # single image
/workspace/images/YYYY-MM-DD/<slug>-1.<ext> …       # n > 1
/workspace/images/YYYY-MM-DD/<file>.json            # sidecar per image
```

- `<slug>` is derived from the first words of the prompt. Existing files are never overwritten — a numeric suffix is added instead.
- The extension follows the returned MIME type: `png`, `jpg`, `webp`, `svg` (Recraft vector models), `gif`.
- The sidecar (`<file>.json`, e.g. `logo.svg.json`) records model, provider, prompt, parameters, duration, the billed cost and the provider's generation id.

The tool result lists the relative paths, format, file size, the billed cost and the duration. It **never** contains image data, so a generation does not blow up the context window. To show an image to the user, the agent calls [`send_file_to_user`](./tools#user-delivery) with the path (web chat shows a preview, Telegram sends raster images as photos and SVG files as documents).

### Errors

Provider errors (invalid key, insufficient credits, content policy, timeouts) are returned as a clear error message instead of failing the turn. A response without an image — for example a refusal, or a model that answers with a remote image URL instead of inline data — is reported as *"The model returned no image"*, together with any text the model sent. With `n > 1`, partial failures are listed next to the images that did succeed.

Each request times out after **180 s**.

## Cost tracking

pi-ai's token-based estimate is far off for image models (zero for most of them), so Axiom reads the **billed amount** that OpenRouter reports in each response (`usage.cost`) and uses it for:

- the tool result and the sidecar file,
- the [Token Usage](../web-ui/token-usage) page — every generation is booked as a `token_usage` row for the image model (interactive chats on the current session, background tasks and the Providers test image without a session).

Typical prices seen in testing: Recraft V4.1 ≈ $0.035, GPT-5 Image Mini ≈ $0.04, Gemini 3.1 Flash Image ≈ $0.07, Recraft V4.1 Vector (SVG) ≈ $0.08 per image. Check [`provider_quota`](./tools#provider-quota) for the remaining OpenRouter credit.

## System prompt

When at least one image model is usable, `<available_providers>` gains an *Image generation models* block that lists every usable image model with its provider, id, the description from the [image model edit dialog](../web-ui/providers#image-models) and a *default image model* label. It also states that these models are only for `generate_image`. `<available_tools>` gains a `generate_image` line. See [System Prompt](./system-prompt#_8-available-providers-configured-llm-providers).

## The `image-generation` skill

The built-in [`image-generation` skill](./skills#currently-shipped) carries the workflow the tool description points to: when to generate, how to write a detailed prompt, generating 1–4 variants, optional self-checks, delivery via `send_file_to_user`, iterating with `input_images` instead of re-rolling, model choice (Recraft vector for logos and icons, GPT/Gemini for text in images and photorealism) and cost awareness (`provider_quota` before batch runs, no base64 in chat). It declares `requires_toolsets: [generate_image]`, so it only appears in `<available_skills>` while the tool is available.

## Migration of existing configurations

Before image models had their own list, image-only models could only be added as text models (where every chat request to them failed). On the first load after the update, Axiom moves every id from `enabledModels` to `enabledImageModels` when pi-ai lists it **only** as an image model for that provider type — for example `openai/gpt-5-image-mini`, `google/gemini-3.1-flash-image` or `recraft/recraft-v4.1` on OpenRouter. The change is written back to `providers.json` once.

Ids are left as text models when they are also chat models in pi-ai's text catalog (e.g. `google/gemini-3-pro-image`, `openrouter/auto`) or when they are currently the active or fallback model, so a running chat setup never changes underneath you. Per-model descriptions and display names are kept. A provider that only had image models ends up with no text models — it simply disappears from the text model pickers.

## Limitations

- **OpenRouter only.** Other providers show no *Add image model* action. ChatGPT/Codex subscription image generation is not supported.
- **Long generations in chat.** During a tool call the chat [provider-stall watchdog](../reference/settings#watchdog) keeps counting (default abort after 90 s). Variants run in parallel, so a single slow model rarely hits this, but very slow models may need a higher `watchdog.stallAbortMs`.
- **Remote image URLs** are not supported; a model must return inline image data.
- **No built-in vision self-check.** Axiom's file tools return text, so the agent cannot look at the generated pixels unless you give it a way to query a vision model.
- **`aspect_ratio`** is forwarded to OpenRouter, but whether a given model honours it is up to the model.

## See also

- [Providers → Image models](../web-ui/providers#image-models) — enabling models, availability check, paid test image.
- [Settings → Tasks → Default image model](../settings/tasks#default-image-model)
- [Built-in Tools](./tools#generate-image) — the tool registry.
- [`settings.json` → `imageGeneration`](../reference/settings#imagegeneration) and [`providers.json` → `enabledImageModels`](../reference/settings#providerconfig)

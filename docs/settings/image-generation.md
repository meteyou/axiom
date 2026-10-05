# Image Generation

Switch the [`generate_image`](../concepts/image-generation) tool on or off and set its default model, limits and output folder. The image models themselves are configured per provider under [Providers → Image models](../web-ui/providers#image-models) — this tab only reads them.

**URL:** `/settings?tab=imageGeneration`

All changes apply from the **next message** — no restart. Background tasks pick them up as well: new tasks get the updated tool, and a running task that still holds the old tool is checked against the current settings on every call.

## Enabled

Master switch for image generation. Default: **on**, so existing setups keep working.

When off, the agent gets **no** `generate_image` tool (in chat and in background tasks), the system prompt has no *Image generation models* block and no `generate_image` line in `<available_tools>`, and the built-in [`image-generation` skill](../concepts/skills#currently-shipped) disappears from `<available_skills>` (it declares `requires_toolsets: [generate_image]`). Image models stay configured under Providers, so switching back on restores everything.

Even when on, the tool only exists while at least one image model is enabled on an enabled provider.

```json
{ "imageGeneration": { "enabled": true } }
```

The remaining fields are shown while image generation is on.

## Default image model

Image model used by `generate_image` when the agent does not pick one. The dropdown lists the enabled image models of all enabled providers; text models never appear here, and image models never appear in text-model dropdowns. This is the only place where the default is set.

*First enabled image model* (empty value) picks the first enabled image model. If the selected model is removed later, the same fallback applies; disabling its provider resets the setting.

```json
{ "imageGeneration": { "defaultModel": "<providerId>:recraft/recraft-v4.1-vector" } }
```

## Max variants per call

Upper limit for the tool's `n` parameter (number of images in one call). Default: `4`. Range: 1 – 10. The limit is part of the tool definition the agent sees; a call with a larger `n` is refused before anything is generated. Each variant is a separate, separately billed request.

```json
{ "imageGeneration": { "maxVariants": 4 } }
```

## Cost limit per call

Optional upper bound in USD for a single `generate_image` call. Empty (default) means no limit.

Before generating, the tool estimates the cost as **variants × the average billed cost per image of the last 5 generations with that model**. If the estimate exceeds the limit, the call is refused with a message that states the estimate and the limit. Nothing is generated and nothing is billed.

The limit is **approximate**:

- pi-ai's image catalog has no per-image prices, so the estimate comes from the costs the provider actually billed for earlier generations (tool calls and the paid test image under Providers).
- Token-priced models (e.g. Gemini and GPT image models) cost different amounts per prompt and per input image, so the real cost can be above or below the estimate. Flat-priced models such as Recraft cost the same every time, so their estimate is close.
- The **first generation** with a model is not checked because no billed cost is on record yet. The tool result then says that the limit was not checked. Generate one test image under Providers first if the limit should apply from the start.

```json
{ "imageGeneration": { "maxCostPerCallUsd": 0.25 } }
```

## Output folder

Folder inside the workspace where images are saved. Default: `images`. Each image lands in a `YYYY-MM-DD/` subfolder of it, together with its JSON sidecar. The value must be a relative path that stays inside the workspace — absolute paths and paths that leave the workspace via `..` are rejected on save.

```json
{ "imageGeneration": { "outputDir": "images" } }
```

## Enabled image models

A read-only list of every image model the agent can use: provider, model and the model's description. Each entry links to its provider on the Providers page, where models are added, edited (display name and description), checked and removed. The description is what the agent reads to pick a model, so describe what each model is good at.

## See also

- [Image Generation](../concepts/image-generation) — how the tool, the system prompt block and the skill work.
- [Providers → Image models](../web-ui/providers#image-models) — enabling models, availability check, paid test image.
- [`settings.json` → `imageGeneration`](../reference/settings#imagegeneration)

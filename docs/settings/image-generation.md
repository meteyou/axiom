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

Axiom has no spending limit of its own. To cap image costs, set a limit on the provider's API key (e.g. an OpenRouter key limit).

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

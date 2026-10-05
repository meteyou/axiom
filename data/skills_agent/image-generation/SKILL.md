---
name: image-generation
version: 1.0.0
description: Generate and edit images with the generate_image tool — prompt writing, model choice, variants, cost control, self-checks and delivery via send_file_to_user. Load this skill before the first generate_image call in a conversation and whenever the user asks for a picture, logo, icon, illustration, mockup or an edit of an existing image.
requires_toolsets: [generate_image]
---

# Image Generation

`generate_image` renders images with the image generation models the user enabled under **Providers → Image models**. The models, their descriptions and the default are listed in the **Image generation models** part of `<available_providers>` in your system prompt. Image models are only reachable through this tool — never pass them to `create_task`, `create_cronjob` or any chat model parameter.

## When to use it

- The user asks for an image, logo, icon, illustration, poster, mockup, sticker, wallpaper or diagram-like artwork.
- The user wants an existing image changed: different colours, background removed or replaced, a variation, a combination of several images.
- Do **not** use it for charts and exact diagrams that can be produced deterministically (use code, e.g. matplotlib, Mermaid or SVG written by hand), or when the user only wants a description of an image.

## Workflow

1. **Brief.** Make sure you know subject, purpose (logo, social post, slide, print…), style, colours, format/aspect ratio and any text that must appear. Ask one short question only if something essential is missing; otherwise choose sensible defaults and say which ones you chose.
2. **Write a detailed prompt.** Image models need concrete visual language, not a chat request:
   - subject and action, composition and framing (close-up, wide shot, centred, rule of thirds)
   - style and medium (flat vector, watercolour, 3D render, photo with 35 mm lens…)
   - colours, lighting, mood, background
   - exact text in quotes, e.g. the word "Axiom" on the sail — keep it short
   - what to avoid, phrased positively where possible ("plain white background")
3. **Generate.** Start with `n: 1` for a quick check, or `n: 2` or more when the user wants options — the maximum is set by the user under Settings → Image generation and shown in the `n` parameter. Each variant is a separate, separately billed request. Optional parameters:
   - `aspect_ratio` (e.g. `"1:1"`, `"16:9"`, `"9:16"`) when the format matters.
   - `quality` (`low`, `medium`, `high`, `auto`): `low` for drafts, `high` for final assets. Only OpenAI GPT Image models (API key) honour it; higher quality costs more and takes longer.
   - `background: "transparent"` for logos, icons, stickers and cut-outs that need an alpha channel.
   Not every model honours every parameter. The tool result says what was ignored or adjusted (`Note: …`); if the format still matters, describe it in the prompt and tell the user.
4. **Files are saved for you** under the output folder named in the tool description (default `images/YYYY-MM-DD/`) in the workspace, each with a `.json` sidecar (model, prompt, parameters, cost, generation id). The tool result lists the paths, format, file size, cost and duration — it never contains image data.
5. **Optional self-check.** You usually cannot see the generated pixels: Axiom's file tools return text, not images. If a vision-capable text model is configured and the user has given you a way to query it (for example a script or skill that sends an image to that model), use it to verify what matters — readable text, correct subject, no obvious artefacts. Without such a path, do not claim the image is correct; tell the user what to check (e.g. spelling of rendered text). For SVG output, `read_file` shows the markup, which is enough to check `viewBox`, colours and whether text was converted to paths.
6. **Deliver** every image the user should see with `send_file_to_user` (one call per file, with a one-line caption). Then summarise what you generated, which model you used and the cost from the tool result.
7. **Iterate with `input_images`.** For "make it bluer", "remove the background", "same logo but round", pass the previous file path in `input_images` together with a prompt describing only the change. This keeps composition and identity; re-rolling from scratch usually loses them. Not every model accepts input images; if the call fails for that reason, tell the user. SVG files cannot be passed as `input_images`: iterate on vector output by generating again with a refined prompt, or edit the SVG markup directly for small changes (colours, text).

## Choosing a model

- Only one image model enabled → omit `model`; the default is used.
- The user named a model → use it.
- Otherwise pick the model whose description in `<available_providers>` best fits the request (the user writes these descriptions to tell you what each model is for). If no description fits, use the default.
- A *ChatGPT* provider's model (ChatGPT Plus/Pro subscription) cannot be steered: ChatGPT picks the renderer, size and quality and ignores `aspect_ratio` and `quality`. Prefer another enabled model when an exact format or quality matters.

## Cost and quota

- The tool result states the cost of every call:
  - a billed amount (e.g. OpenRouter),
  - an estimate from list prices (`~$0.03 (estimated…)`, OpenAI API key) — say it is an estimate,
  - or *included in the ChatGPT subscription*: no extra cost, but it uses the plan's Codex usage limits, which image generations exhaust quickly. The result then also shows the ChatGPT image limit; warn the user when it gets high.
- Repeat the cost to the user when it is noticeable or when you ran several calls.
- Axiom does not cap spending per call. Spending limits belong on the provider's API key (e.g. an OpenRouter key limit); if a call fails because such a limit is reached, report it and let the user decide.
- Before batch runs (many images, or several multi-variant calls), call `provider_quota` for credit-based providers such as OpenRouter, or for the ChatGPT/Codex usage windows, and check what is left. Tell the user the expected cost first if a batch will clearly exceed a few dollars or a large part of the usage limit.
- On errors (`Insufficient credits`, `no credits remaining`, a reached ChatGPT usage limit, rate limits, content policy refusals, "no image returned"), report the reason instead of retrying blindly. Retry at most once, and only for transient errors.

## Rules

- Never paste base64 or data URLs into the chat or into files you write by hand — work with the saved file paths.
- Keep generated files in the workspace; do not delete earlier versions while the user is still iterating.
- Respect content policies and the user's rights: no realistic images of real private persons without consent, no misleading fake documents.

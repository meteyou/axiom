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
3. **Generate.** Start with `n: 1` for a quick check, or `n: 2`–`4` when the user wants options. Each variant is a separate, separately billed request. Pass `aspect_ratio` (e.g. `"1:1"`, `"16:9"`, `"9:16"`) when the format matters; not every model honours it.
4. **Files are saved for you** under `images/YYYY-MM-DD/` in the workspace, each with a `.json` sidecar (model, prompt, parameters, cost, generation id). The tool result lists the paths, format, file size, billed cost and duration — it never contains image data.
5. **Optional self-check.** You usually cannot see the generated pixels: Axiom's file tools return text, not images. If a vision-capable text model is configured and the user has given you a way to query it (for example a script or skill that sends an image to that model), use it to verify what matters — readable text, correct subject, no obvious artefacts. Without such a path, do not claim the image is correct; tell the user what to check (e.g. spelling of rendered text). For SVG output, `read_file` shows the markup, which is enough to check `viewBox`, colours and whether text was converted to paths.
6. **Deliver** every image the user should see with `send_file_to_user` (one call per file, with a one-line caption). Then summarise what you generated, which model you used and the cost from the tool result.
7. **Iterate with `input_images`.** For "make it bluer", "remove the background", "same logo but round", pass the previous file path in `input_images` together with a prompt describing only the change. This keeps composition and identity; re-rolling from scratch usually loses them. Only models that accept image input can edit (the Providers UI marks them with "edits images").

## Choosing a model

Prefer the model the user named, then the descriptions in `<available_providers>`, then the default. Rules of thumb:

- **Logos, icons, flat illustrations, anything that must scale** → a Recraft *vector* model (e.g. `recraft/recraft-v4.1-vector`); it returns SVG.
- **Text inside the image** (posters, signs, labels) → GPT image models or Gemini image models render text most reliably; keep the text short and quote it exactly.
- **Photorealism, product shots, people** → GPT image or Gemini image models, or Recraft (non-vector) for stylised realism.
- **Editing existing images** → a model that accepts image input (Gemini and GPT image models do; some Recraft variants do not).
- **Cost.** Prices differ by model and are billed per image — from roughly $0.03 to well over $0.10. Prefer the cheaper model for drafts and exploration, and the stronger one for the final version. Do not generate more variants than asked for.

## Cost and quota

- Every call costs real money. The tool result reports the billed cost; repeat it to the user when it is noticeable or when you ran several calls.
- Before batch runs (many images, or `n: 4` several times), call `provider_quota` for credit-based providers such as OpenRouter and check the remaining balance. Tell the user the expected cost first if a batch will clearly exceed a few dollars.
- On errors (`Insufficient credits`, rate limits, content policy refusals, "no image returned"), report the reason instead of retrying blindly. Retry at most once, and only for transient errors.

## Rules

- Never paste base64 or data URLs into the chat or into files you write by hand — work with the saved file paths.
- Keep generated files in the workspace; do not delete earlier versions while the user is still iterating.
- Respect content policies and the user's rights: no realistic images of real private persons without consent, no misleading fake documents.

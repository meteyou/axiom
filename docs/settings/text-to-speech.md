# Text-to-Speech

Let the agent talk back in an actual human-sounding voice — used by the "play this message" speaker button in the web chat and by [Telegram voice replies](./telegram#send-voice-reply).

**URL:** `/settings?tab=tts`

## Enabled

Master toggle. When off, the speaker icons disappear from the UI.

```json
{ "tts": { "enabled": false } }
```

## Provide as agent tool

Gives the agent the [`audio_send`](../concepts/tools#audio-send) tool, so it can answer with a spoken voice message when you ask for one — e.g. "answer me as a voice message" on Telegram. On by default; the speaker button and the automatic [Telegram voice replies](./telegram#send-voice-reply) work without it. Applies to new chat sessions.

```json
{ "tts": { "agentTool": true } }
```

## TTS model

Which model generates the audio. The dropdown lists every enabled **TTS model** of every enabled provider, e.g. `Deepgram (aura-2-thalia-en)` or `OpenRouter (ElevenLabs: Eleven v3)`.

TTS models are added on the [Providers](../web-ui/providers#voice-models) page via the provider's ⋮ menu → **Add TTS model** — this tab only selects one of them. If no TTS model is configured yet, the dropdown is disabled and links to the Providers page.

The selection is stored as `providerId:modelId`. It is empty until you pick a model, and it is reset to empty when the model or its provider is disabled or removed.

```json
{ "tts": { "model": "deepgram-main:aura-2-thalia-en" } }
```

Every synthesis is recorded with its character count on the [Token Usage](../web-ui/token-usage) page. The cost comes from the model's price, set via [Edit Model](../web-ui/providers#voice-model-rows) on the Providers page.

## Voice

Shown once a model is selected. The options depend on the provider:

| Provider | Voices |
|---|---|
| OpenAI | OpenAI's preset voices (`alloy`, `coral`, `nova`, …). `tts-1` / `tts-1-hd` only offer the classic subset. |
| Mistral | Loaded live from Mistral's voice library (`/v1/audio/voices`). |
| OpenRouter | The model's `supported_voices` from OpenRouter's model list. |
| xAI | Loaded live from `/v1/tts/voices`. |
| Deepgram | No voice picker — every Aura model id already *is* a voice (`aura-2-thalia-en`, `aura-2-julius-de`, …). Add another TTS model to change the voice. |
| Custom (OpenAI-compatible) | Free-text voice id, because self-hosted servers name their voices freely. |

Leave empty to use the model's default voice (OpenRouter: the model's first supported voice).

```json
{ "tts": { "voice": "coral" } }
```

## Voice instructions

Free-form tone/style guidance, e.g. `Speak calmly, medium pace.` Only models that support it use the field (OpenAI `gpt-4o-mini-tts`, and on OpenRouter e.g. Gemini TTS and Fish Audio); all others ignore it.

```json
{ "tts": { "instructions": "" } }
```

## Voice preview

A text field + play button. Enter any text, click the speaker icon, and hear the current (unsaved) model, voice, instructions and audio format immediately. Stop playback by clicking the same button again.

## Audio format

Output container format of the synthesized audio. Only the formats the provider of the selected model can return are offered; when there is only one (OpenRouter), the picker is replaced by a note. Saving replaces an unsupported format with the provider's first supported one.

| Value  | Notes |
|--------|-------|
| `mp3`  | Universal default. Supports long-text chunking with Deepgram (see below). |
| `wav`  | Uncompressed, large. Supports long-text chunking with Deepgram (PCM is concatenated and wrapped in a single WAV header). |
| `opus` | Small, OGG container. Telegram renders it as a native voice message. With Deepgram, longer texts than 2000 characters come back as MP3 (see below). |
| `flac` | Lossless. With Deepgram, longer texts than 2000 characters come back as MP3 (see below). |

Some providers only deliver some formats: **OpenRouter** always returns MP3 (for every model it routes to), **xAI** returns MP3 or WAV. OpenAI, Mistral, Deepgram and custom OpenAI-compatible servers offer all four.

```json
{ "tts": { "responseFormat": "mp3" } }
```

### Deepgram long-text behavior

Deepgram's `/v1/speak` endpoint rejects any single request longer than **2000 characters**. To make the “Read message aloud” button work for long assistant replies, Axiom splits the input on sentence boundaries, synthesizes each chunk separately and concatenates the result.

- **`mp3`** — frame-aligned; chunked output is concatenated directly.
- **`wav`** — Axiom requests headerless PCM (`linear16` with `container=none`); chunks are concatenated as raw samples and wrapped in a single WAV header.
- **`opus`** and **`flac`** — use page/frame containers that **do not** survive naive concatenation. Inputs **≤ 2000 characters** still work normally; longer inputs are synthesized as `mp3` instead (Telegram still shows MP3 as a voice message).

The other providers don't have this limit.

## Upgrading from the old TTS settings

Older versions configured the backend directly on this tab. On the first start after the upgrade, Axiom moves that setup to the new TTS model:

- **OpenAI** and **Mistral** — the selected model (e.g. `gpt-4o-mini-tts`, `voxtral-mini-tts-2603`) is added as a TTS model to the selected provider and becomes the TTS model. The voice and the instructions are kept.
- **Deepgram** — a **Deepgram** provider is created from the API key stored in the settings (or an existing Deepgram provider with the same key is reused). The model is kept.

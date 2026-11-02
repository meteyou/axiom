# Text-to-Speech

Let the agent talk back in an actual human-sounding voice — used by the "play this message" speaker button in the web chat and by [Telegram voice replies](./telegram#send-voice-reply).

**URL:** `/settings?tab=tts`

## Enabled

Master toggle. When off, the speaker icons disappear from the UI.

```json
{ "tts": { "enabled": false } }
```

## TTS model

Which model generates the audio. The dropdown lists every enabled **TTS model** of every enabled provider, e.g. `Deepgram (aura-2-thalia-en)` or `OpenRouter (ElevenLabs: Eleven v3)`.

TTS models are added on the [Providers](../web-ui/providers#voice-models) page via the provider's ⋮ menu → **Add TTS model** — this tab only selects one of them. If no TTS model is configured yet, the dropdown is disabled and links to the Providers page.

The selection is stored as `providerId:modelId`. It is empty until you pick a model, and it is reset to empty when the model or its provider is disabled or removed.

```json
{ "tts": { "model": "deepgram-main:aura-2-thalia-en" } }
```

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

Output container format of the synthesized audio.

| Value  | Notes |
|--------|-------|
| `mp3`  | Universal default. Supports long-text chunking with Deepgram (see below). |
| `wav`  | Uncompressed, large. Supports long-text chunking with Deepgram (PCM is concatenated and wrapped in a single WAV header). |
| `opus` | Small. Telegram renders it as a native voice message. With Deepgram limited to 2000 characters per request (see below). |
| `flac` | Lossless. With Deepgram limited to 2000 characters per request (see below). |

Some providers only deliver some formats: **OpenRouter** always returns MP3, **xAI** returns MP3 or WAV (Opus/FLAC fall back to MP3).

```json
{ "tts": { "responseFormat": "mp3" } }
```

### Deepgram long-text behavior

Deepgram's `/v1/speak` endpoint rejects any single request longer than **2000 characters**. To make the “Read message aloud” button work for long assistant replies, Axiom splits the input on sentence boundaries, synthesizes each chunk separately and concatenates the result.

- **`mp3`** — frame-aligned; chunked output is concatenated directly.
- **`wav`** — Deepgram returns headerless PCM (`linear16`); chunks are concatenated as raw samples and wrapped in a single WAV header.
- **`opus`** and **`flac`** — use page/frame containers that **do not** survive naive concatenation. Inputs **≤ 2000 characters** still work normally; longer inputs are rejected with an error asking you to switch to `mp3` or `wav`.

The other providers don't have this limit.

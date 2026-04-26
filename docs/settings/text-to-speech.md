# Text-to-Speech

Let the agent talk back in an actual human-sounding voice — used by the "play this message" speaker button in the web chat.

**URL:** `/settings?tab=tts`

## Enabled

Master toggle. When off, no speaker icons disappear from the UI.

```json
{ "tts": { "enabled": false } }
```

## Provider

Which backend generates the audio. Both options reference an entry you already configured on the [Providers](/providers/) page — the API key / base URL is read from there.

| Value     | Notes                                                                                                                         |
|-----------|-------------------------------------------------------------------------------------------------------------------------------|
| `openai`  | Uses an OpenAI API-Key provider from `providers.json`. Calls its `/v1/audio/speech` endpoint with one of OpenAI's TTS models. |
| `mistral` | Uses a Mistral API-Key provider from `providers.json`. Synthesises with Mistral's Voxtral voices.                             |

The dropdown lists each matching provider as its own entry, e.g. `OpenAI (My OpenAI)` or `Mistral Voxtral (Mistral Main)`. If no matching provider is configured, the option appears `disabled`.

The selected provider's id is stored in `tts.providerId`; `tts.provider` stores only the backend type:

```json
{ "tts": { "provider": "openai", "providerId": "openai-main" } }
```

## OpenAI model

Shown when provider is `openai`. The model is sent to the selected provider's `/v1/audio/speech` endpoint.

| Value             | Notes                                                         |
|-------------------|---------------------------------------------------------------|
| `gpt-4o-mini-tts` | Newer, supports tone/style instructions. Recommended default. |
| `tts-1`           | Classic, fast, cheap.                                         |
| `tts-1-hd`        | Higher-fidelity version of `tts-1`.                           |

```json
{ "tts": { "openaiModel": "gpt-4o-mini-tts" } }
```

## OpenAI voice

Shown when provider is `openai`. One of OpenAI's preset voices (`alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer`, …). The list is loaded live from the OpenAI catalog so the options stay in sync if OpenAI ships new voices.

```json
{ "tts": { "openaiVoice": "nova" } }
```

## OpenAI instructions

_Only shown for `gpt-4o-mini-tts`._ Free-form tone/style guidance for the voice model, e.g.:

```
Speak calmly, with a slight Viennese accent, medium pace.
```

Leave empty for the neutral default.

```json
{ "tts": { "openaiInstructions": "" } }
```

## Mistral voice

Shown when provider is `mistral`. The UI splits the choice into two side-by-side dropdowns:

- **Speaker** — one of the available Voxtral speakers, annotated with language (e.g. `Nadia (German)`, `Theo (English)`).
- **Mood** — emotional color (`neutral`, `happy`, `serious`, …).

The list is fetched live from the Voxtral catalog when you open the panel. The two selections are combined into a single voice id and stored in `tts.mistralVoice`:

```json
{ "tts": { "mistralVoice": "nadia-neutral" } }
```

## Voice preview

A text field + play button at the bottom of each provider block. Enter any text, click the speaker icon, hear the current settings applied immediately — no need to save first. Stop playback by clicking the same button again.

## Audio format

Output container format used for the synthesized audio in the web chat.

| Value  | Notes                |
|--------|----------------------|
| `mp3`  | Universal default.   |
| `wav`  | Uncompressed, large. |
| `opus` | Small.               |
| `flac` | Lossless.            |

```json
{ "tts": { "responseFormat": "mp3" } }
```

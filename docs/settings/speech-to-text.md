# Speech-to-Text

Transcribe voice input (from the web chat mic button and Telegram voice messages) into text the agent can read. Optionally rewrite the raw transcript with an LLM to clean up filler words and punctuation.

**URL:** `/settings?tab=stt`

## Enabled

Master toggle. When off, the mic button is hidden in the UI and Telegram voice messages are passed through to the agent as unknown attachments.

```json
{ "stt": { "enabled": false } }
```

## Provider

Which backend handles the actual transcription. The `openai` and `ollama` options reference an entry you already configured on the [Providers](/providers/) page — the API key / base URL is read from there, **not** from [Secrets](./secrets).

| Value | Notes |
|---|---|
| `openai` | Uses an OpenAI-compatible provider from `providers.json` (typically your OpenAI entry). Calls its `/v1/audio/transcriptions` endpoint with OpenAI's Whisper / GPT‑4o transcription models. |
| `whisper-url` | A self-hosted Whisper-compatible HTTP endpoint (e.g. `faster-whisper-server`, `whisper.cpp` server). Standalone — does **not** use a provider entry, just a raw URL. Local-first, zero API cost. |
| `ollama` | Uses an Ollama provider from `providers.json`. A Whisper-family model served by that Ollama instance handles the transcription. |

The dropdown lists each matching provider from `providers.json` as its own entry, e.g. `OpenAI Whisper (My OpenAI)` or `Ollama (Ollama Mac)`. If no matching provider is configured, the option appears `disabled`.

The selected provider's id is stored in `stt.providerId`; `stt.provider` stores only the backend type:

```json
{ "stt": { "provider": "openai", "providerId": "openai-main" } }
```

## OpenAI model

Shown when provider is `openai`. The model is sent to the selected provider's `/v1/audio/transcriptions` endpoint.

| Value | Notes |
|---|---|
| `whisper-1` | Classic Whisper, cheap, decent. |
| `gpt-4o-transcribe` | Newer, higher quality. |
| `gpt-4o-mini-transcribe` | Cheaper `gpt-4o` variant. |

```json
{ "stt": { "openaiModel": "gpt-4o-mini-transcribe" } }
```

## Whisper URL

Shown when provider is `whisper-url`. Full URL to the transcription endpoint, e.g.:

```
http://whisper:9000/v1/audio/transcriptions
```

Must be an OpenAI-compatible `/audio/transcriptions` route. Usable over HTTPS or plain HTTP on the internal Docker network.

```json
{
  "stt": {
    "whisperUrl": "http://whisper:9000/v1/audio/transcriptions"
  }
}
```

## Ollama model

Shown when provider is `ollama`. The model tag as pulled into the Ollama server referenced by the selected provider entry, e.g. `dimavz/whisper-tiny`.

```json
{ "stt": { "ollamaModel": "dimavz/whisper-tiny" } }
```

## Rewrite enabled

After transcription, run the raw text through an LLM to:

- Strip filler ("äh", "umm", "like").
- Fix punctuation and capitalization.
- Keep the original language.

Useful for messy dictations. Adds latency and token cost — leave off if your transcriber is already clean.

```json
{ "stt": { "rewrite": { "enabled": false } } }
```

## Rewrite provider

When rewrite is on, picks which provider+model does the cleanup. Any enabled chat provider from the [Providers](/providers/) page can be selected. If left empty, rewriting is silently skipped and the raw transcript is returned.

The stored value is a composite `providerId::modelId` string:

```json
{ "stt": { "rewrite": { "providerId": "openai-main::gpt-5.4-mini" } } }
```

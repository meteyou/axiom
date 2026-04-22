# Speech-to-Text

Transcribe voice input (from the web chat mic button and Telegram voice messages) into text the agent can read. Optionally rewrite the raw transcript with an LLM to clean up filler words and punctuation.

**URL:** `/settings?tab=stt`

## Enabled

Master toggle. When off, the mic button is hidden in the UI and Telegram voice messages are passed through to the agent as unknown attachments.

## Provider

Which backend handles the actual transcription.

| Value | Notes |
|---|---|
| `openai` | OpenAI's hosted Whisper / GPT‑4o transcription models. Requires `OPENAI_API_KEY` in [Secrets](./secrets). |
| `whisper-url` | A self-hosted Whisper-compatible HTTP endpoint (e.g. `faster-whisper-server`, `whisper.cpp` server). Local-first, zero API cost. |
| `ollama` | A Whisper-family model served by your Ollama instance. |

Options not backed by a reachable provider/secret appear `disabled` in the dropdown.

## OpenAI model

Shown when provider is `openai`.

| Value | Notes |
|---|---|
| `whisper-1` | Classic Whisper, cheap, decent. |
| `gpt-4o-transcribe` | Newer, higher quality. |
| `gpt-4o-mini-transcribe` | Cheaper `gpt-4o` variant. |

## Whisper URL

Shown when provider is `whisper-url`. Full URL to the transcription endpoint, e.g.:

```
http://whisper:9000/v1/audio/transcriptions
```

Must be an OpenAI-compatible `/audio/transcriptions` route. Usable over HTTPS or plain HTTP on the internal Docker network.

## Ollama model

Shown when provider is `ollama`. The model tag as pulled into your Ollama server, e.g. `dimavz/whisper-tiny`.

## Rewrite enabled

After transcription, run the raw text through an LLM to:

- Strip filler ("äh", "umm", "like").
- Fix punctuation and capitalization.
- Keep the original language.

Useful for messy dictations. Adds latency and token cost — leave off if your transcriber is already clean.

## Rewrite provider

When rewrite is on, which provider does the cleanup. Defaults to the active chat provider; override with any enabled provider+model.

## Full `settings.json` block

```json
{
  "stt": {
    "enabled": false,
    "provider": "openai",
    "openaiModel": "gpt-4o-mini-transcribe",
    "whisperUrl": "",
    "ollamaModel": "",
    "rewrite": {
      "enabled": false,
      "providerId": ""
    }
  }
}
```

# Speech-to-Text

Transcribe voice input (from the web chat mic button, Telegram voice messages and the agent's `audio_transcribe` tool) into text the agent can read. Optionally rewrite the raw transcript with an LLM to clean up filler words and punctuation.

**URL:** `/settings?tab=stt`

## Enabled

Master toggle. When off, the mic button is hidden in the UI, Telegram voice messages are ignored, and the agent has no `audio_transcribe` tool.

```json
{ "stt": { "enabled": false } }
```

## Provide as agent tool

Gives the agent the [`audio_transcribe`](../concepts/tools#audio-transcribe) tool, so it can transcribe audio and video files from the workspace — e.g. "download this video and transcribe it". On by default; the mic button and Telegram voice messages work without it. Applies to new chat sessions and to tasks started afterwards.

```json
{ "stt": { "agentTool": true } }
```

## STT model

Which model transcribes the audio. The dropdown lists every enabled **STT model** of every enabled provider, e.g. `Deepgram (nova-3)`, `OpenAI (gpt-4o-transcribe)` or `OpenRouter (ElevenLabs: Scribe v2)`.

STT models are added on the [Providers](../web-ui/providers#voice-models) page via the provider's ⋮ menu → **Add STT model** — this tab only selects one of them. If no STT model is configured yet, the dropdown is disabled and links to the Providers page.

The selection is stored as `providerId:modelId`. It is empty until you pick a model, and it is reset to empty when the model or its provider is disabled or removed.

```json
{ "stt": { "model": "deepgram-main:nova-3" } }
```

Every transcription is recorded with its audio length (and the rewrite with its tokens) on the [Token Usage](../web-ui/token-usage) page. The cost comes from the model's price, set via [Edit Model](../web-ui/providers#voice-model-rows) on the Providers page.

::: tip Self-hosted Whisper
A self-hosted, OpenAI-compatible transcription server (e.g. `faster-whisper-server`, Speaches) is added as a **Custom – OpenAI Chat Completions** provider with its base URL. Its models then appear under **Add STT model**.
:::

## Language

ISO‑639‑1 code passed to the STT model (`en`, `de`, `es`, …). Deepgram additionally accepts `multi` for recordings that switch between languages.

Leave empty to use the requesting user's [language setting](./agent#personal-agent-settings-regular-users) (the global one for admins); `match` lets the model auto-detect. The agent's `audio_transcribe` tool ignores this setting: it auto-detects unless the agent passes a language.

```json
{ "stt": { "language": "" } }
```

## Rewrite enabled

After transcription, run the raw text through an LLM to:

- Strip filler ("äh", "umm", "like").
- Fix punctuation and capitalization.
- Keep the original language.

Useful for messy dictations. Adds latency and token cost — leave off if your transcriber is already clean.

The agent's `audio_transcribe` tool does not rewrite by default. While a rewrite provider is configured here, the tool offers an optional `rewrite` flag the agent can set for a cleaned-up transcript.

```json
{ "stt": { "rewrite": { "enabled": false } } }
```

## Rewrite provider

When rewrite is on, picks which provider+model does the cleanup. Any chat provider from the [Providers](../web-ui/providers) page can be selected. If left empty, rewriting is skipped and the raw transcript is returned.

The stored value is a composite `providerId:modelId` string:

```json
{ "stt": { "rewrite": { "providerId": "openai-main:gpt-5.4-mini" } } }
```

## Upgrading from the old STT settings

Older versions configured the backend directly on this tab. On the first start after the upgrade, Axiom moves that setup to the new STT model:

- **OpenAI** — the selected model (e.g. `whisper-1`) is added as an STT model to the selected provider and becomes the STT model.
- **Deepgram** — a **Deepgram** provider is created from the API key stored in the settings (or an existing Deepgram provider with the same key is reused). The model and the language are kept.
- **Whisper URL** — an OpenAI-compatible endpoint (`…/v1/audio/transcriptions`) is added as a **Whisper** provider of type **Custom – OpenAI Chat Completions**. The old setting sent no model name, so add an STT model to that provider on the Providers page and select it here. Other URLs are not migrated and stay in `settings.json` (`stt.whisperUrl`) until you select an STT model; add the server as a custom provider yourself (see the tip above).
- **Ollama** — no longer supported. Select a model from one of the providers above.

Until an STT model is selected, the mic button, Telegram voice messages and `audio_transcribe` report that no STT model is configured.

# Configuration Files Reference

Authoritative schema reference for everything under `/data/config/`. This page is **the agent's map of its own configuration** — every key, type, default, and validation rule, with links to the [Settings UI documentation](../settings/) for behavioral context.

If you are an end user, prefer the [Settings overview](../settings/) and its subpages — they explain *what each setting does*. This page explains *exactly what shape the file on disk has*.

::: tip Editing rules of thumb
- **Web UI is the supported path** for everything except `AGENTS.md` / `HEARTBEAT.md` / `CONSOLIDATION.md` (those have their own [Instructions editor](../web-ui/instructions)).
- **Stop the container before hand-editing JSON** — the backend keeps an in-memory copy and overwrites the file on the next save through the UI.
- All non-secret values are merged via [PUT `/api/settings`](#how-the-ui-writes-files) which applies per-field validation; raw file edits bypass that validation.
:::

## Files in `/data/config/`

| File                           | Created by                                                                                                                              | Edited by                                          | Encrypted? | Schema                                            |
|--------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------------|------------|---------------------------------------------------|
| [`settings.json`](#settings-json)             | `ensureConfigTemplates()` ([`packages/core/src/config.ts`](https://github.com/)) on first boot | UI Settings panels (all except Telegram & Secrets) | No         | [`SettingsContract`](#settings-json)              |
| [`telegram.json`](#telegram-json)             | `ensureConfigTemplates()` on first boot                                                                                                 | UI Settings → Telegram, Telegram users panel       | No (token plain text) | [`TelegramSettingsStorageContract`](#telegram-json) |
| [`providers.json`](#providers-json)           | `ensureConfigTemplates()` on first boot                                                                                                 | UI Providers page                                  | **Yes** (apiKey, oauthCredentials) | [`ProvidersFile`](#providers-json)                |
| [`secrets.json`](#secrets-json)               | First call to `saveSecrets()`                                                                                                           | UI Settings → Secrets                              | **Yes** (every value)              | [`SecretsFile`](#secrets-json)                    |
| [`skills.json`](#skills-json)                 | `ensureConfigTemplates()` on first boot                                                                                                 | UI Skills page                                     | **Yes** (env values)               | [`SkillsFile`](#skills-json)                      |
| `AGENTS.md`                    | Seeded by [Instructions defaults](../concepts/instructions#agents-md)                                                                   | UI Instructions page                               | No         | Free-form Markdown                                |
| `HEARTBEAT.md`                 | Seeded by [Instructions defaults](../concepts/instructions#heartbeat-md)                                                                | UI Instructions page                               | No         | Free-form Markdown                                |
| `CONSOLIDATION.md`             | Seeded by [Instructions defaults](../concepts/instructions#consolidation-md)                                                            | UI Instructions page                               | No         | Free-form Markdown                                |

The directory itself is created with `0700` mode the first time the backend runs. See [File Paths](./file-paths) for the volume mapping.

---

## `settings.json`

The non-secret runtime config. Edited via every Settings UI panel except [Telegram](../settings/telegram) (which writes to `telegram.json`) and [Secrets](../settings/secrets) (which writes to `secrets.json`).

The on-disk shape is a **superset** of [`SettingsContract`](https://github.com/) (`packages/core/src/contracts/settings.ts`): the contract describes what the API exchanges with the frontend; the file may also contain a few keys the UI doesn't surface (`tokenPriceTable`, `builtinTools`, `braveSearchApiKey`, `searxngUrl`, `tavilyApiKey`) plus dead fields from older versions until they get re-saved.

### Top-level keys

| JSON path                          | Type                                                              | Default        | Validation                              | Controls                                                                                                          |
|------------------------------------|-------------------------------------------------------------------|----------------|-----------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| `sessionTimeoutMinutes`            | `number`                                                          | `30`           | `> 0`                                   | Inactivity window before a chat session ends — see [Memory → Session timeout](../settings/memory#session-timeout). |
| `sessionSummaryProviderId`         | `string`                                                          | `""`           | string                                  | Provider id (`provider::model`) used to summarize ended sessions; `""` = active provider.                         |
| `language`                         | `string`                                                          | `"en"` (template) / `"match"` (normalized) | non-empty                       | Forced reply language or `"match"` — see [Agent → Language](../settings/agent#agent-language).                    |
| `timezone`                         | IANA tz string                                                    | `"UTC"`        | non-empty                               | Cron + daily-memory naming. Overridden by `TZ` env var if set. See [Agent → Timezone](../settings/agent#timezone).|
| `thinkingLevel`                    | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"`    | `"off"`        | enum                                    | Reasoning effort for the chat agent — see [Agent → Thinking level](../settings/agent#thinking-level).             |
| `healthMonitorIntervalMinutes`     | `number`                                                          | `5`            | `> 0`                                   | Health-check frequency — see [Health Monitor → Interval](../settings/health-monitor#health-check-interval).       |
| `uploads`                          | object                                                            | see below      | nested                                  | Upload retention policy.                                                                                          |
| `healthMonitor`                    | object                                                            | see below      | nested                                  | Provider health checks + fallback.                                                                                |
| `memoryConsolidation`              | object                                                            | see below      | nested                                  | Nightly memory job.                                                                                               |
| `factExtraction`                   | object                                                            | see below      | nested                                  | Per-session fact extraction.                                                                                      |
| `agentHeartbeat`                   | object                                                            | see below      | nested                                  | Background reflection loop.                                                                                       |
| `tasks`                            | object                                                            | see below      | nested                                  | Task & cronjob defaults.                                                                                          |
| `tts`                              | object                                                            | see below      | nested                                  | Voice output config.                                                                                              |
| `stt`                              | object                                                            | see below      | nested                                  | Voice input config.                                                                                               |
| `tokenPriceTable`                  | `Record<string, { input: number; output: number }>`               | seed prices    | not validated by API                    | Per-model USD/1M-token costs used by [Token Usage](../web-ui/token-usage). Merged on top of `DEFAULT_PRICE_TABLE`. |
| `builtinTools`                     | object                                                            | see below      | not validated by API                    | Enable/disable built-in `web_search` and `web_fetch` tools, choose the search provider.                           |
| `braveSearchApiKey`                | `string`                                                          | `""`           | not validated by API                    | **Legacy** — read at boot, migrated into `builtinTools.webSearch.braveSearchApiKey` if present.                   |
| `searxngUrl`                       | `string`                                                          | `""`           | not validated by API                    | **Legacy** — read at boot, migrated into `builtinTools.webSearch.searxngUrl` if present.                          |
| `tavilyApiKey`                     | `string`                                                          | `""`           | not validated by API                    | **Legacy** — read at boot, migrated into `builtinTools.webSearch.tavilyApiKey` if present.                       |
| `heartbeat`                        | object                                                            | see template   | not read at runtime                     | **Legacy / dead key.** Seeded by the template, never read by current code. Replaced by `healthMonitor` + `healthMonitorIntervalMinutes` on the first save. Safe to delete by hand. |

### `uploads`

| Key                  | Type     | Default | Range            | UI                                                         |
|----------------------|----------|---------|------------------|------------------------------------------------------------|
| `uploads.retentionDays` | `number` | `30`    | `>= 0` (`0` = delete on next cleanup) | [Agent → Upload retention](../settings/agent#upload-retention) |

```json
{ "uploads": { "retentionDays": 30 } }
```

### `healthMonitor`

[Health Monitor settings UI](../settings/health-monitor).

| Key                                          | Type                       | Default     | Validation                                          |
|----------------------------------------------|----------------------------|-------------|-----------------------------------------------------|
| `healthMonitor.enabled`                      | `boolean`                  | `true`      | coerced to bool                                     |
| `healthMonitor.fallbackTrigger`              | `"down" \| "degraded"`     | `"down"`    | enum                                                |
| `healthMonitor.failuresBeforeFallback`       | `number`                   | `1`         | `> 0`                                               |
| `healthMonitor.recoveryCheckIntervalMinutes` | `number`                   | `1`         | `> 0`                                               |
| `healthMonitor.successesBeforeRecovery`      | `number`                   | `3`         | `> 0`                                               |
| `healthMonitor.notifications.healthyToDegraded` | `boolean`               | `false`     | bool                                                |
| `healthMonitor.notifications.degradedToHealthy` | `boolean`               | `false`     | bool                                                |
| `healthMonitor.notifications.degradedToDown`    | `boolean`               | `true`      | bool                                                |
| `healthMonitor.notifications.healthyToDown`     | `boolean`               | `true`      | bool                                                |
| `healthMonitor.notifications.downToFallback`    | `boolean`               | `true`      | bool                                                |
| `healthMonitor.notifications.fallbackToHealthy` | `boolean`               | `true`      | bool                                                |

::: warning Legacy nested `intervalMinutes`
The PUT endpoint also accepts `healthMonitor.intervalMinutes` and migrates it to the top-level `healthMonitorIntervalMinutes` (see `withLegacySettingsPayloadCompatibility`). New writes always go to the top-level field.
:::

### `memoryConsolidation`

[Memory → Memory consolidation UI](../settings/memory#memory-consolidation).

| Key                              | Type      | Default | Range     |
|----------------------------------|-----------|---------|-----------|
| `memoryConsolidation.enabled`    | `boolean` | `true`  | bool      |
| `memoryConsolidation.runAtHour`  | `number`  | `3`     | `0–23` (local time, see `timezone`) |
| `memoryConsolidation.lookbackDays` | `number` | `3`     | integer `1–30` |
| `memoryConsolidation.providerId` | `string`  | `""`    | string (`""` = active provider) |

Companion file: `/data/config/CONSOLIDATION.md` — the prompt for the consolidator. See [Instructions → CONSOLIDATION.md](../concepts/instructions#consolidation-md).

### `factExtraction`

[Memory → Fact extraction UI](../settings/memory#fact-extraction).

| Key                                  | Type      | Default | Range            |
|--------------------------------------|-----------|---------|------------------|
| `factExtraction.enabled`             | `boolean` | `true`  | bool             |
| `factExtraction.providerId`          | `string`  | `""`    | string           |
| `factExtraction.minSessionMessages`  | `number`  | `3`     | integer `1–100`  |

### `agentHeartbeat`

[Agent Heartbeat UI](../settings/agent-heartbeat).

| Key                                       | Type      | Default | Range  |
|-------------------------------------------|-----------|---------|--------|
| `agentHeartbeat.enabled`                  | `boolean` | `false` | bool   |
| `agentHeartbeat.intervalMinutes`          | `number`  | `60`    | `> 0` (UI clamps `1–1440`) |
| `agentHeartbeat.nightMode.enabled`        | `boolean` | `true`  | bool   |
| `agentHeartbeat.nightMode.startHour`      | `number`  | `23`    | `0–23` |
| `agentHeartbeat.nightMode.endHour`        | `number`  | `8`     | `0–23` |

`startHour > endHour` (e.g. `23 → 7`) means the window crosses midnight — that is the expected case.

Companion file: `/data/config/HEARTBEAT.md` — the prompt the agent receives every tick.

### `tasks`

[Tasks UI](../settings/tasks).

| Key                                             | Type                              | Default       | Range / enum                                |
|-------------------------------------------------|-----------------------------------|---------------|---------------------------------------------|
| `tasks.defaultProvider`                         | `string` (`provider::model`)      | `""`          | string                                      |
| `tasks.maxDurationMinutes`                      | `number`                          | `60`          | `> 0` (UI clamps `1–1440`)                  |
| `tasks.telegramDelivery`                        | `"auto" \| "always"`              | `"auto"`      | enum                                        |
| `tasks.backgroundThinkingLevel`                 | thinking-level enum               | `"off"`       | same as top-level `thinkingLevel`           |
| `tasks.loopDetection.enabled`                   | `boolean`                         | `true`        | bool                                        |
| `tasks.loopDetection.method`                    | `"systematic" \| "smart" \| "auto"` | `"systematic"` | enum                                       |
| `tasks.loopDetection.maxConsecutiveFailures`    | `number`                          | `3`           | `> 0`                                       |
| `tasks.loopDetection.smartProvider`             | `string`                          | `""`          | string                                      |
| `tasks.loopDetection.smartCheckInterval`        | `number`                          | `5`           | `> 0`                                       |
| `tasks.statusUpdates.enabled`                   | `boolean`                         | `false`       | bool                                        |
| `tasks.statusUpdates.intervalMinutes`           | `number`                          | `10`          | integer `1–120`                             |

::: warning Legacy `tasks.statusUpdateIntervalMinutes`
A flat `tasks.statusUpdateIntervalMinutes` may exist on disk from older installs. PUT still accepts it (validated as integer `1–120`) and writes it through to `tasks.statusUpdates.intervalMinutes` without flipping `enabled` to `true` — opting in is explicit. After the next save, the flat key is no longer needed.
:::

### `tts`

[Text-to-Speech UI](../settings/text-to-speech).

| Key                          | Type                                           | Default            | Validation                                                              |
|------------------------------|------------------------------------------------|--------------------|-------------------------------------------------------------------------|
| `tts.enabled`                | `boolean`                                      | `false`            | bool                                                                    |
| `tts.provider`               | `"openai" \| "mistral"`                        | `"openai"`         | enum (`SETTINGS_TTS_PROVIDERS`)                                         |
| `tts.providerId`             | `string` (provider entry id)                   | `""`               | string                                                                  |
| `tts.openaiModel`            | `"gpt-4o-mini-tts" \| "tts-1" \| "tts-1-hd"`   | `"gpt-4o-mini-tts"`| enum (`SETTINGS_TTS_OPENAI_MODELS`)                                     |
| `tts.openaiVoice`            | `string` (e.g. `"nova"`, `"alloy"`)            | `"nova"`           | non-empty string                                                        |
| `tts.openaiInstructions`     | `string`                                       | `""`               | string                                                                  |
| `tts.mistralVoice`           | `string` (e.g. `"nadia-neutral"`)              | `""`               | string                                                                  |
| `tts.responseFormat`         | `"mp3" \| "wav" \| "opus" \| "flac"`           | `"mp3"`            | enum (`SETTINGS_TTS_RESPONSE_FORMATS`)                                  |

### `stt`

[Speech-to-Text UI](../settings/speech-to-text).

| Key                          | Type                                                             | Default          | Validation                                  |
|------------------------------|------------------------------------------------------------------|------------------|---------------------------------------------|
| `stt.enabled`                | `boolean`                                                        | `false`          | bool                                        |
| `stt.provider`               | `"whisper-url" \| "openai" \| "ollama"`                          | `"whisper-url"`  | enum (`SETTINGS_STT_PROVIDERS`)             |
| `stt.whisperUrl`             | `string` (full URL)                                              | `""`             | string                                      |
| `stt.providerId`             | `string` (provider entry id)                                     | `""`             | string                                      |
| `stt.openaiModel`            | `"whisper-1" \| "gpt-4o-transcribe" \| "gpt-4o-mini-transcribe"` | `"whisper-1"`    | enum (`SETTINGS_STT_OPENAI_MODELS`)         |
| `stt.ollamaModel`            | `string`                                                         | `""`             | string                                      |
| `stt.rewrite.enabled`        | `boolean`                                                        | `false`          | bool                                        |
| `stt.rewrite.providerId`     | `string` (`provider::model` composite)                           | `""`             | string                                      |

### `tokenPriceTable`

```json
{
  "tokenPriceTable": {
    "gpt-4o":                       { "input": 2.5,  "output": 10.0 },
    "gpt-4o-mini":                  { "input": 0.15, "output": 0.6 },
    "claude-3-5-sonnet-20241022":   { "input": 3.0,  "output": 15.0 },
    "claude-sonnet-4-20250514":     { "input": 3.0,  "output": 15.0 }
  }
}
```

- Keys are model ids exactly as they appear in pi-ai responses.
- `input` / `output` are **USD per 1M tokens**.
- The runtime merges this object on top of [`DEFAULT_PRICE_TABLE`](https://github.com/) — entries you list here override the defaults; missing entries fall back to the defaults; entries unknown to either are reported as cost `null` in [Token Usage](../web-ui/token-usage).
- Not exposed by the Settings UI — edit directly. Read by `getConfiguredPriceTable()` (`packages/core/src/provider-config.ts`).

### `builtinTools`

```json
{
  "builtinTools": {
    "webSearch": {
      "enabled": true,
      "provider": "duckduckgo",
      "braveSearchApiKey": "",
      "searxngUrl": "",
      "tavilyApiKey": ""
    },
    "webFetch": { "enabled": true }
  }
}
```

| Key                                            | Type                                       | Default        | Notes                                                                                                                                                         |
|------------------------------------------------|--------------------------------------------|----------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `builtinTools.webSearch.enabled`               | `boolean`                                  | `true`         | When `false`, the `web_search` tool is not registered.                                                                                                        |
| `builtinTools.webSearch.provider`              | `"duckduckgo" \| "brave" \| "searxng" \| "tavily"` | `"duckduckgo"` | DuckDuckGo is keyless. `brave` requires `braveSearchApiKey`. `searxng` requires `searxngUrl`. `tavily` requires `tavilyApiKey`.                                |
| `builtinTools.webSearch.braveSearchApiKey`     | `string`                                   | `""`           | Encrypted at rest by `web-tools.ts` if you write it via that path; the file form is plain text — prefer keeping this in [secrets.json](#secrets-json) and referencing via env. |
| `builtinTools.webSearch.searxngUrl`            | `string`                                   | `""`           | Base URL of a SearXNG instance.                                                                                                                               |
| `builtinTools.webSearch.tavilyApiKey`          | `string`                                   | `""`           | Encrypted at rest by `web-tools.ts` if you write it via that path; the file form is plain text — prefer keeping this in [secrets.json](#secrets-json) and referencing via env. Sign up at <https://app.tavily.com> (1,000 queries/month free). |
| `builtinTools.webFetch.enabled`                | `boolean`                                  | `true`         | When `false`, the `web_fetch` tool is not registered.                                                                                                          |

The runtime also accepts the **legacy** flat keys `braveSearchApiKey`, `searxngUrl`, and `tavilyApiKey` at the top level of `settings.json`; on boot they are folded into `builtinTools.webSearch` if the new keys are empty (`packages/web-backend/src/bootstrap/runtime-composition.ts`).

### Default `settings.json` (after first boot)

This is the literal file written by `ensureConfigTemplates()`:

```json
{
  "sessionTimeoutMinutes": 30,
  "sessionSummaryProviderId": "",
  "language": "en",
  "timezone": "UTC",
  "thinkingLevel": "off",
  "heartbeat": {
    "intervalMinutes": 5,
    "fallbackTrigger": "down",
    "failuresBeforeFallback": 1,
    "recoveryCheckIntervalMinutes": 1,
    "successesBeforeRecovery": 3,
    "notifications": {
      "healthyToDegraded": false,
      "degradedToHealthy": false,
      "degradedToDown": true,
      "healthyToDown": true,
      "downToFallback": true,
      "fallbackToHealthy": true
    }
  },
  "uploads": { "retentionDays": 30 },
  "tokenPriceTable": {
    "gpt-4o":                     { "input": 2.5,  "output": 10 },
    "gpt-4o-mini":                { "input": 0.15, "output": 0.6 },
    "claude-3-5-sonnet-20241022": { "input": 3,    "output": 15 },
    "claude-sonnet-4-20250514":   { "input": 3,    "output": 15 }
  },
  "memoryConsolidation": { "enabled": true, "runAtHour": 3, "lookbackDays": 3, "providerId": "" },
  "factExtraction":      { "enabled": true, "providerId": "", "minSessionMessages": 3 },
  "agentHeartbeat": {
    "enabled": false,
    "intervalMinutes": 60,
    "nightMode": { "enabled": true, "startHour": 23, "endHour": 8 }
  },
  "builtinTools": {
    "webSearch": { "enabled": true, "provider": "duckduckgo" },
    "webFetch":  { "enabled": true }
  },
  "braveSearchApiKey": "",
  "searxngUrl": "",
  "tavilyApiKey": "",
  "tasks": {
    "defaultProvider": "",
    "maxDurationMinutes": 60,
    "telegramDelivery": "auto",
    "loopDetection": {
      "enabled": true,
      "method": "systematic",
      "maxConsecutiveFailures": 3,
      "smartProvider": "",
      "smartCheckInterval": 5
    },
    "statusUpdates": { "enabled": false, "intervalMinutes": 10 },
    "backgroundThinkingLevel": "off"
  }
}
```

Note: `tts`, `stt`, `healthMonitor`, and `healthMonitorIntervalMinutes` are **not** in the template — they are added the first time the user saves the relevant Settings panel. Until then, the runtime falls back to the defaults documented above (and surfaced by `mapSettingsResponse`).

---

## `telegram.json`

Stored separately from `settings.json` (the Settings UI groups it under the [Telegram panel](../settings/telegram), but writes go to a different file). Contains both UI-managed fields and runtime fields the UI doesn't expose.

| Key                  | Type        | Default        | Validation       | Surface                                                                            |
|----------------------|-------------|----------------|------------------|------------------------------------------------------------------------------------|
| `enabled`            | `boolean`   | `false`        | bool             | [Telegram → Enabled](../settings/telegram#enabled)                                 |
| `botToken`           | `string`    | `""`           | string (plain)   | [Telegram → Bot token](../settings/telegram#bot-token) — **stored in plain text**  |
| `batchingDelayMs`    | `number`    | `2500`         | `>= 0`           | [Telegram → Batching delay](../settings/telegram#batching-delay)                   |
| `adminUserIds`       | `number[]`  | `[]`           | not exposed via UI | Numeric Telegram IDs that receive [Health Monitor notifications](../settings/health-monitor#notifications). Edit by hand. |
| `pollingMode`        | `boolean`   | `true`         | not exposed via UI | `true` = long-poll (default). `false` = expect `webhookUrl` to be set.            |
| `webhookUrl`         | `string`    | `""`           | not exposed via UI | Public HTTPS URL for webhook mode. Ignored when `pollingMode: true`.              |

### Default `telegram.json`

```json
{
  "enabled": false,
  "botToken": "",
  "adminUserIds": [],
  "pollingMode": true,
  "webhookUrl": "",
  "batchingDelayMs": 2500
}
```

::: warning Bot token is plain text
The bot token is **not** encrypted at rest. Protect `/data/config/telegram.json` with normal filesystem permissions and back up the `axiom-data` volume to a trusted location. Do not commit or share this file.
:::

The Telegram **user directory** (approval / assignment / status badges) is **not** in this file — it lives in the SQLite `telegram_users` table. See [Telegram → Telegram users](../settings/telegram#telegram-users).

---

## `providers.json`

LLM provider catalog. UI-managed via the [Providers page](../web-ui/providers); the schema is documented here for reference.

| Key                | Type                       | Notes                                                                                            |
|--------------------|----------------------------|--------------------------------------------------------------------------------------------------|
| `providers`        | `ProviderConfig[]`         | Every configured provider. Created/edited via the UI.                                            |
| `activeProvider`   | `string` (provider id)     | Currently active provider for chat. Set by [Agent → Provider](../settings/agent#provider).        |
| `activeModel`      | `string` (model id)        | Active model within `activeProvider`.                                                            |
| `fallbackProvider` | `string`                   | Provider switched to by [Health Monitor](../settings/health-monitor) when active goes `down`.    |
| `fallbackModel`    | `string`                   | Model within `fallbackProvider`.                                                                 |
| `_comment`         | `string`                   | Cosmetic — written by the template, ignored at runtime.                                          |

### `ProviderConfig`

| Key                      | Type                                            | Notes                                                                                          |
|--------------------------|-------------------------------------------------|------------------------------------------------------------------------------------------------|
| `id`                     | `string`                                        | Stable, unique within the file. Used everywhere as `providerId`.                              |
| `name`                   | `string`                                        | Display name in the UI.                                                                        |
| `type`                   | `string`                                        | Wire protocol, e.g. `"openai-completions"`, `"anthropic-messages"`.                            |
| `providerType`           | `string`                                        | Logical class — `"openai"`, `"anthropic"`, `"mistral"`, `"openrouter"`, `"deepseek"`, `"kimi"`, `"minimax"`, `"ollama"`, `"google"`, `"openai-codex"`, `"github-copilot"`, `"anthropic-oauth"`, etc. |
| `provider`               | `string`                                        | pi-ai provider key.                                                                            |
| `baseUrl`                | `string`                                        | API base URL.                                                                                  |
| `apiKey`                 | `string` (**encrypted**)                        | Encrypted with `ENCRYPTION_KEY` (`packages/core/src/encryption.ts`). Use the UI to write.      |
| `defaultModel`           | `string`                                        | Model id used when `activeModel` is unset.                                                     |
| `enabledModels`          | `string[]?`                                     | Model ids the user has enabled for this provider.                                              |
| `degradedThresholdMs`    | `number?`                                       | Latency threshold for `healthy → degraded` transitions in [Health Monitor](../settings/health-monitor). |
| `textVerbosity`          | `"low" \| "medium" \| "high"` (optional)          | Response verbosity for supported OpenAI Codex/Responses-style providers. Omit to use the provider default (pi-ai currently defaults Codex to `low`). Configure via [Providers UI](../web-ui/providers#add-edit-dialog). |
| `transport`              | `"sse" \| "websocket" \| "websocket-cached" \| "auto"` (optional) | Wire-level streaming transport. **Only honoured by the OpenAI Codex / Responses apiType today** — silently ignored on every other provider type and dropped on persist. Omit (or set to `"sse"`) to use the default HTTP+SSE streaming. See [Transport modes](#transport-modes) below. |
| `models`                 | `ProviderModelConfig[]?`                        | Per-model overrides — context window, max tokens, reasoning support, fixed temperature, custom cost. |
| `status`                 | `"connected" \| "error" \| "untested"`          | Last-known result of an explicit "test connection" click.                                      |
| `modelStatuses`          | `Record<modelId, status>`                       | Per-model variant of `status`.                                                                 |
| `authMethod`             | `"apiKey" \| "oauth"`                           | Determines whether `apiKey` or `oauthCredentials` is used.                                     |
| `oauthCredentials`       | `OAuthCredentialsStored?` (**encrypted**)       | `{ refresh, access, expires, extra }` — only present when `authMethod === "oauth"`.            |

### Transport modes

The `transport` field selects the wire protocol used to stream completions for
providers that expose more than one. **In Axiom today this only applies to the
OpenAI Codex / Responses apiType** (`providerType: "openai-codex"`); for every
other provider type the value is dropped on save and the default SSE transport
is used.

| Value                | Behaviour                                                                                                                                                                              |
|----------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `"sse"` (default)    | Regular HTTP request per turn with Server-Sent Events streaming. The full conversation context is resent on every tool-call round.                                                     |
| `"websocket"`        | Persistent WebSocket connection per session. No SSE fallback — connection errors surface as request errors.                                                                            |
| `"websocket-cached"` | Persistent WebSocket connection that ships only **delta context items** per turn. The first turn primes the cache; subsequent turns reuse `previous_response_id` and send only what's new. Best fit for long agent sessions. |
| `"auto"`             | Try WebSocket first; fall back to SSE on connection error.                                                                                                                             |

Why `"websocket-cached"` matters for long sessions: with `"sse"` every tool-call
round re-uploads the full transcript, which scales linearly with session length.
`"websocket-cached"` instead keys off `sessionId` (Axiom already passes one per
session), keeps the connection open, and the upstream API resolves the prior
context from cache — only new items are sent.

Reconfigure via [Providers UI](../web-ui/providers#add-edit-dialog) or by
editing `providers.json` directly. Switching a provider away from a Codex-style
`providerType` automatically strips an existing `transport` value, since it
would otherwise be a silent no-op.

### Encryption

`apiKey`, `oauthCredentials.refresh`, `oauthCredentials.access`, and `oauthCredentials.extra` are AES-256-GCM-encrypted at rest using `ENCRYPTION_KEY` (see [Environment Variables → ENCRYPTION_KEY](./env-vars#required)). Losing or rotating that key makes existing values undecryptable — re-enter them via the UI to recover.

The encrypted form looks like `enc::<base64>` — `isEncrypted()` checks the prefix; `loadProvidersDecrypted()` returns the plaintext form for runtime use; `loadProvidersMasked()` returns `sk-••••••1234` for UI display.

---

## `secrets.json`

Generic key/value secret store the agent and skills can read at runtime. UI-managed via the [Secrets panel](../settings/secrets).

```json
{
  "env": {
    "GH_TOKEN":            "enc::AAAA…",
    "MY_CUSTOM_API_TOKEN": "enc::BBBB…"
  }
}
```

- File mode: `0600` (chowned to the container user).
- Every value is AES-256-GCM-encrypted with `ENCRYPTION_KEY`.
- Keys must match `^[A-Z][A-Z0-9_]*$` — uppercase letters, digits, underscores; must start with a letter.
- Values are write-only from the API's perspective: existing entries are never returned in full. The UI lists `sk-••••••1234`-style masks via `loadSecretsMasked()`.
- Read at runtime by `loadSecretsDecrypted()` and surfaced to skill processes through environment variables matching the key name.

::: warning Don't bypass the UI for `secrets.json`
If you write this file by hand, you must encrypt the values yourself with the same `ENCRYPTION_KEY` the runtime uses. Practical advice: **always** use the Settings UI for secrets.
:::

See [Secrets → Where they end up](../settings/secrets#where-they-end-up) for the full story.

---

## `skills.json`

Catalog of installed skills, edited via the [Skills page](../web-ui/skills).

```json
{
  "skills": [
    {
      "id": "github.com/owner/repo:main:path/to/skill",
      "owner": "owner",
      "name": "skill-name",
      "description": "What it does",
      "source": "github",
      "sourceUrl": "https://github.com/owner/repo",
      "path": "/data/skills/<id>",
      "enabled": true,
      "envKeys": ["MY_VAR"],
      "envValues": { "MY_VAR": "enc::…" },
      "emoji": "🛠",
      "installedAt": "2025-04-29T12:00:00Z"
    }
  ]
}
```

| Key            | Type                                       | Notes                                                                              |
|----------------|--------------------------------------------|------------------------------------------------------------------------------------|
| `id`           | `string`                                   | Stable id used as folder name under `/data/skills/`.                              |
| `owner`        | `string`                                   | Repository owner (or `"local"` for uploaded skills).                              |
| `name`         | `string`                                   | Display name.                                                                     |
| `description`  | `string`                                   | Short description shown in skill picker.                                          |
| `source`       | `"openclaw" \| "github" \| "upload"`       | How the skill was installed.                                                      |
| `sourceUrl`    | `string`                                   | Origin URL (GitHub repo, openclaw entry, or empty for uploads).                   |
| `path`         | `string`                                   | Absolute path to the installed skill directory.                                   |
| `enabled`      | `boolean`                                  | When `false`, the skill is loaded into the registry but not surfaced to the agent. |
| `envKeys`      | `string[]`                                 | Names of env vars the skill expects.                                              |
| `envValues`    | `Record<string, string>` (**encrypted**)   | Same encryption as `secrets.json`. UI presents these as masked password fields.    |
| `emoji`        | `string?`                                  | Optional UI icon.                                                                  |
| `installedAt`  | ISO timestamp                              | Set on install / re-install.                                                       |

Built-in agent skills are kept under `/data/skills_agent/` and are **not** listed here — see [File Paths](./file-paths).

---

## How the UI writes files

```
PUT /api/settings   { … partial update … }
        │
        ▼
withLegacySettingsPayloadCompatibility   ← migrate old key shapes (heartbeat.intervalMinutes → top-level)
        │
        ▼
mergeHealthMonitor / mergeConsolidation / mergeFactExtraction /
mergeAgentHeartbeat / mergeTasks / mergeTts / mergeStt / mergeUploads
        │   ← per-field validators (validatePositiveNumber, validateEnum, validateHour, …)
        ▼
fs.writeFileSync(/data/config/settings.json, …)
fs.writeFileSync(/data/config/telegram.json, …)
        │
        ▼
on*Changed hooks ── refresh in-memory caches & restart workers as needed
        │
        ▼
mapSettingsResponse → JSON returned to the UI
```

Source files:

- `packages/web-backend/src/api/modules/settings/service.ts` — `createSettingsService()` orchestrates read / merge / write.
- `packages/web-backend/src/api/modules/settings/schema.ts` — every per-field validator + merge function.
- `packages/web-backend/src/api/modules/settings/mapper.ts` — shapes the response with all defaults filled in.
- `packages/core/src/contracts/settings.ts` — single source of truth for types, enums (`SETTINGS_THINKING_LEVELS`, `SETTINGS_TTS_PROVIDERS`, …), and `normalizeSettingsContract()`.
- `packages/core/src/config.ts` — `ensureConfigTemplates()`, `loadConfig()`, `getConfigDir()`.

### Validators reference

| Validator                  | Rule                                                              |
|----------------------------|-------------------------------------------------------------------|
| `validatePositiveNumber`   | finite number `>= 1`                                              |
| `validateNonNegativeNumber`| finite number `>= 0`                                              |
| `validateIntegerRange(min, max)` | integer in `[min, max]`                                     |
| `validateHour`             | integer `0–23`                                                    |
| `validateNonEmptyString`   | string with non-whitespace content                                |
| `validateEnum(allowed)`    | exact match against an enum array exported from the contract     |

A failed validator turns into a `SettingsValidationError`, which the route handler maps to **HTTP 400** with the `error` message from the validator (e.g. `"tasks.maxDurationMinutes must be a positive number"`). No partial write happens — the file on disk stays unchanged.

### Live-reload triggers

After a successful write, the service fires whichever of these hooks the changed fields imply:

| Trigger                                  | Restarts / refreshes                                                        |
|------------------------------------------|-----------------------------------------------------------------------------|
| `sessionTimeoutMinutes` changed          | `agentCore.getSessionManager().setTimeoutMinutes(…)`                       |
| `language` or `timezone` changed         | `agentCore.refreshSystemPrompt()`                                          |
| `thinkingLevel` changed                  | `agentCore.setThinkingLevel(…)`                                            |
| `healthMonitorIntervalMinutes` or any `healthMonitor.*` changed | `onHealthMonitorSettingsChanged()`                  |
| `memoryConsolidation.*` changed          | `onConsolidationSettingsChanged()`                                          |
| `agentHeartbeat.*` changed               | `onAgentHeartbeatSettingsChanged()`                                         |
| `telegram.enabled` or `telegram.botToken` changed | `onTelegramSettingsChanged()` — restart bot                        |

No container restart is needed for any of the above. Changes to fields outside this list (e.g. `tasks.*`, `tts.*`, `stt.*`, `factExtraction.*`) are read on next use rather than via a hook.

---

## Migration & legacy fields

Things that may exist in older `settings.json` files and how the runtime handles them.

| Old field                                  | Replaced by                                            | Behavior                                                                             |
|--------------------------------------------|--------------------------------------------------------|--------------------------------------------------------------------------------------|
| `heartbeat` (whole block)                  | `healthMonitor` + `healthMonitorIntervalMinutes`       | Template still seeds it on first boot. Live code never reads it. Replaced on first save. |
| `healthMonitor.intervalMinutes`            | top-level `healthMonitorIntervalMinutes`               | PUT migrates it via `withLegacySettingsPayloadCompatibility`.                       |
| `tasks.statusUpdateIntervalMinutes` (flat) | `tasks.statusUpdates.intervalMinutes`                  | Migrated on first save; `tasks.statusUpdates.enabled` stays `false` until opted in.   |
| `uploadRetentionDays` (top-level)          | `uploads.retentionDays`                                | Read at runtime by `getUploadRetentionDays()` if the new key is absent. Replaced on first save of the Uploads panel. |
| `batchingDelayMs` (top-level in `settings.json`) | `telegram.batchingDelayMs` (in `telegram.json`)  | Read at boot by the Telegram bot if `telegram.json` does not yet have the key. Replaced on first save of the Telegram panel. |
| `braveSearchApiKey` (top-level)            | `builtinTools.webSearch.braveSearchApiKey`             | Folded in at boot if the new key is empty.                                            |
| `searxngUrl` (top-level)                   | `builtinTools.webSearch.searxngUrl`                    | Folded in at boot if the new key is empty.                                            |
| `tavilyApiKey` (top-level)                 | `builtinTools.webSearch.tavilyApiKey`                  | Folded in at boot if the new key is empty.                                            |

There is **no automatic rewrite** of these legacy fields. The new shape lands the next time the user saves the relevant panel; until then both shapes coexist and the runtime prefers the new one if both are present.

---

## See also

- [Settings overview](../settings/) — what each setting does, organized by UI panel.
- [File Paths](./file-paths) — full layout of `/data/` and `/workspace/`.
- [Environment Variables](./env-vars) — startup-only config (ports, secrets, paths) that never lives in JSON.
- [Configuration guide](../guide/configuration) — onboarding-oriented walkthrough for power users.
- [Memory System](../concepts/memory) — how `memoryConsolidation` and `factExtraction` fit into the bigger memory pipeline.
- [Instructions](../concepts/instructions) — `AGENTS.md`, `HEARTBEAT.md`, `CONSOLIDATION.md` editing.

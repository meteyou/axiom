# Providers

The Providers page is where you configure which LLM endpoints Axiom can talk to — API keys, OAuth subscriptions, base URLs, model lists, costs. Every row you add here becomes selectable as the active provider for chat, the default for tasks, and the optional fallback for the Health Monitor.

> **Admin only.** Regular users don't see this page.

![Screenshot of the Providers page](../assets/screenshot-providers.png)

## Header

A single primary button on the right:

- **Add Provider** — opens the [provider form dialog](#add-edit-dialog).

There is no Refresh button — the list re-loads after every successful add / edit / delete / test.

## Two-level table

The table renders providers in **two tiers**:

- **Provider header rows** — one per configured provider. Show the display name and the underlying type (e.g. `Anthropic`, `OpenAI`, `Mistral`, `z.ai`). OAuth providers additionally show `OAuth` after the type label.
- **Model sub-rows** — one per *enabled model* on that provider, indented with `└`. Each carries its own cost, status, and per-model actions.

Providers are sorted alphabetically by display name; sub-rows follow the order configured in the provider form.

### Provider header columns

| Column      | Notes                                                                                                |
|-------------|------------------------------------------------------------------------------------------------------|
| **Name**    | Bold display name; below it, the provider type label (e.g. *"Anthropic"*, *"Anthropic (Claude Pro/Max) · OAuth"*). |
| **Cost**    | Empty — costs live on the model rows.                                                                |
| **Status**  | Empty — status lives on the model rows.                                                              |
| **⋮**       | Edit, Delete. *Delete* is disabled for the provider that owns the currently active model.            |

Clicking anywhere on a header row opens the [Edit dialog](#add-edit-dialog).

### Model sub-row columns

| Column      | Notes                                                                                                |
|-------------|------------------------------------------------------------------------------------------------------|
| **Model**   | Indented model id; small badges for `Active` (green) and `Fallback` (outline). Both can appear on the same row in theory, but the active model is never also the fallback. |
| **Cost**    | `$<input>` / `$<output>` per million tokens. Shown as `—` when no cost is configured for that model. |
| **Status**  | One of `Untested`, `Connected`, `Error` — see [Statuses](#statuses).                                 |
| **⋮**       | Test Connection, Set Active, Set Fallback, Remove Fallback, Remove Model — context-aware (see [Per-model actions](#per-model-actions)). |

### Statuses

The status badge reflects the result of the **last manual test** of that specific model — *not* the live health-check state from the [Health Monitor](../settings/health-monitor).

| Badge        | Meaning                                                                                              |
|--------------|------------------------------------------------------------------------------------------------------|
| `Untested`   | Default for newly added models — no Test Connection has been run.                                    |
| `Connected`  | The last test succeeded. A green banner with the test's response time briefly appears at the top.    |
| `Error`      | The last test failed. The error message appears in a red banner at the top.                          |

While a test is running, the badge is replaced by an inline spinner with the label *"Testing…"*.

For ongoing health monitoring (latency thresholds, automatic fallback switchover), see [Settings → Health Monitor](../settings/health-monitor).

## Active vs. Fallback

Exactly one model is **active** at any time — that's the model the chat agent uses by default and the one the Dashboard shows as healthy/degraded. At most one *other* model is the **Fallback** — the Health Monitor switches to it automatically when the active provider becomes unhealthy.

- The `Active` badge in the screenshot above sits on `gpt-5.4` because that's the configured default.
- The `Fallback` badge sits on `gpt-5.3-codex` — when `gpt-5.4` goes down, the agent transparently routes to `gpt-5.3-codex` until the Health Monitor recovers the primary.

You set both from the row menu — see [Per-model actions](#per-model-actions). To change the *task* default (used by background task agents), go to [Settings → Tasks](../settings/tasks) instead — that's a separate setting.

## Per-model actions

The ⋮ menu on each model row carries up to five items, shown only when relevant:

| Item                  | When it appears                                                                  |
|-----------------------|----------------------------------------------------------------------------------|
| **Test Connection**   | Always. Sends a small request to the provider/model and updates the status badge. |
| **Set Active**        | When this model is *not* already active. Promotes it to the global active model.  |
| **Set Fallback**      | When this model is neither active nor the current fallback.                       |
| **Remove Fallback**   | Only on the current fallback model. Clears the fallback selection.                |
| **Remove Model**      | Always (but disabled in two cases — see below).                                   |

### Removing a model

`Remove Model` opens a confirmation dialog:

> **Remove model `<model>`** from provider `<provider>`? This does not uninstall the model, it only removes it from this provider's list.

Two rules guard against breaking your setup:

- **The active model can't be removed.** Switch to a different active model first, then come back.
- **The last remaining model can't be removed.** If you genuinely want to drop a provider's only model, delete the whole provider instead.

A few automatic adjustments happen on confirm:

- If you remove the model that was set as fallback, the fallback is cleared first.
- If you remove the model that was the provider's *default*, the next remaining model becomes the new default automatically — the form doesn't reopen.

## Add / Edit dialog

Opened by **Add Provider** or by clicking a provider header row. The form is small and adapts heavily to the chosen provider type.

### Common fields

| Field                  | Notes                                                                                                |
|------------------------|------------------------------------------------------------------------------------------------------|
| **Name**               | Free text, your label for this provider — appears in the table, in `<task_injection>` blocks, on the Dashboard. |
| **Type**               | Dropdown grouped into two sections: **API Key** (OpenAI, Anthropic, Mistral, Ollama, generic OpenAI-compatible, …) and **Subscription / OAuth** (Anthropic Claude Pro/Max, OpenAI ChatGPT Plus/Pro, Google Antigravity Free, …). |
| **Degraded Threshold** | Latency in ms above which the provider is marked *Degraded* in health checks. Default `5000`. Lower = more sensitive. |

### API-key providers

When you pick a type from the *API Key* group, three additional fields surface depending on what that preset declares:

#### Models

The model selector adapts to the preset:

- **Curated providers (OpenAI, Anthropic, Mistral, …)** — a checkbox list of known models. Tick the ones you want to enable; the first enabled becomes the default.
- **Generic OpenAI-compatible** — a free-text input for the default model id (e.g. `google/gemini-2.5-pro`, `kimi-k2.6`).
- **Ollama** — a separate panel with its own controls (see below).

#### API Key

A password field. Required for most presets, optional for ones that don't strictly need authentication (e.g. an unauthenticated local OpenAI-compatible server). In edit mode the field is empty and the hint reads *"Leave empty to keep existing key"* — only type a value if you want to replace the stored secret.

Stored encrypted at rest in `/data/config/providers.json` using `ENCRYPTION_KEY`. See [Configuration](../guide/configuration#why-encryption-key-matters).

#### Base URL

Only visible for presets where the URL is editable (Ollama, generic OpenAI-compatible, …). For Ollama the placeholder shows the default `http://localhost:11434/v1`.

### Ollama-specific controls

Picking the `ollama` type swaps the model selector for a dedicated Ollama panel:

- **Refresh button** — loads installed models from the Ollama API at the configured Base URL.
- **Installed models** — checkbox list with model name, parameter size, quantization, and on-disk size. Tick the ones you want to enable on this provider.
- **Pull Model** — type a model name (e.g. `llama3`, `gemma4`, `mistral`) and hit `Pull`. A live progress bar shows the percentage and the current pull stage. On success the model appears in the list above and can be ticked.

If Ollama can't be reached, you see a destructive banner with *"Could not reach Ollama"* and a retry link.

### OAuth providers

Picking a type from the *Subscription / OAuth* group changes the form's submit button: instead of `Save`, you see **Login & Connect**.

The full flow:

1. Type a **Name**, pick the OAuth provider type, optionally tick which models to enable.
2. Click **Login & Connect**. A new browser tab opens with the provider's auth page.
3. Complete the login. The dialog updates to *"Waiting for authentication…"* with a spinner.
4. Once the redirect comes back, the dialog closes and the provider appears in the list.

**Remote server fallback.** If your Axiom instance runs on a remote box where the OAuth callback URL can't reach you, a manual-code field appears below the spinner: *"Or paste the redirect URL here (for remote servers)"*. Complete the login locally, copy the full redirect URL from the browser, paste it in, and click **Submit**.

### Renewing OAuth tokens

In **edit** mode for an OAuth provider, the dialog footer shows a **Renew Token** button on the left. OAuth refresh tokens have a fixed lifetime — when they expire, the model status flips to `Error` with an authentication failure. Click **Renew Token** to start the OAuth flow again with the existing provider record (no new row, no lost configuration).

## Delete provider

The provider's row menu has a **Delete** item. Confirm dialog:

> Are you sure you want to delete provider `<name>`?

Rules:

- **Can't delete the active provider.** The button is disabled in the menu. Set a different model as active first.
- **Linked secrets are removed too.** The encrypted API key and any OAuth tokens for that provider are wiped from `/data/config/providers.json`.
- **Per-cronjob pins.** If a cronjob was pinned to this provider/model pair, it falls back to the default the next time it runs. To stop a cronjob from running on a missing provider, edit it under [Cronjobs](./cronjobs).

## Empty state

When you have no providers configured yet, the table is replaced by a centered plug icon and the message *"No providers configured yet. Add one to get started."* with an inline `Add Provider` button.

This is what you see right after first install — until at least one provider is configured, the chat agent can't respond.

## See also

- [Configuration](../guide/configuration) — encryption (`ENCRYPTION_KEY`), where API keys live on disk.
- [Settings → Agent](../settings/agent) — choosing the active provider/model from the Settings side; same data, different entry point.
- [Settings → Tasks](../settings/tasks) — separate default provider for background task agents.
- [Settings → Health Monitor](../settings/health-monitor) — periodic health checks, automatic fallback switchover.
- [Token Usage](./token-usage) — actual spend per provider and model over time.

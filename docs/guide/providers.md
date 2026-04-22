# LLM Providers

> **This page is a stub.** Full content will be written together with the agent. For now, the bare essentials:

Axiom supports any combination of:

- **OpenAI** (`gpt-4o`, `gpt-4o-mini`, `o1`, …)
- **Anthropic** (`claude-sonnet-4-…`, `claude-3-5-sonnet-…`)
- **OpenAI-compatible** providers (Groq, Together, OpenRouter, Mistral, DeepSeek, your local server, …)
- **Ollama** for local models (uncomment the `ollama` service in `docker-compose.yml`)

Configure providers in the web UI under **Settings → Providers**, or directly in `/data/config/providers.json`. API keys are encrypted at rest using `ENCRYPTION_KEY` — see [Configuration](./configuration).

The agent picks the default provider per task. Per-call overrides flow through `create_task` / `create_cronjob` / `edit_cronjob` via the `provider` and `model` parameters.

---

*To be expanded: provider-type matrix, OAuth flows, model-listing, default-model behavior, fallback config, cost-tracking, OpenAI-compatible quirks per backend, Ollama setup walk-through.*

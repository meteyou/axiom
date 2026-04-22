# Memory

Session lifetime, upload retention, memory consolidation, and fact extraction. For the broader picture (files, layers, templates) see [Memory System](../guide/memory).

**URL:** `/settings?tab=memory`

## Session timeout

How many minutes of inactivity end a session. When a session ends, Axiom may summarize it into the current daily note (see below). Default: `15`.

Range: 1 – 1440 (up to 24h).

```json
{ "sessionTimeoutMinutes": 15 }
```

> If [Agent Heartbeat](./agent-heartbeat) is enabled, the end-of-session summary is skipped — the heartbeat loop keeps memory fresh. The UI shows an inline hint when this is the case.

## Session Summary Provider

Which provider writes the end-of-session summary into `memory/daily/<date>.md`.

- **Use active provider** (default) — whatever is selected under [Agent → Provider](./agent#provider).
- **Explicit override** — pick a cheap, fast model here to avoid summarizing with your most expensive reasoning model.

```json
{ "sessionSummaryProviderId": "openai:gpt-4o-mini" }
```

## Upload retention

How many days uploaded files (`/data/uploads/`) are kept before the cleanup job removes them. Default: `30`. Set to `0` to keep uploads forever.

```json
{ "uploadRetentionDays": 30 }
```

## Memory consolidation

Scheduled job that condenses the last _N_ daily notes into durable entries in `MEMORY.md` and trims the daily files. Keeps the prompt small without losing context.

### Enable consolidation

Master toggle for the job.

### Run at hour

Hour of the day (0 – 23, in your configured [timezone](./agent#timezone)) to run the consolidation. Default: `3` (i.e. 3 AM local time).

### Lookback days

How many days of daily notes the job reads and condenses on each run. Default: `3`. Range: 1 – 30.

### Consolidation provider

Dedicated provider for consolidation. Defaults to the active chat provider; set something cheaper if consolidation runs often.

### Run now + status

A button triggers a one-off consolidation immediately, showing last run time + result (`updated` or `no change`).

### Consolidation rules

A card links to `/data/config/CONSOLIDATION.md` — the prompt that tells the consolidator _how_ to condense (what to keep, what to drop, how to name entries).

Click **Open editor** to jump to the [Agent Instructions](../guide/instructions#consolidation-md-memory-consolidation-rules) page. See that page for the default template and tuning tips.

### Full block

```json
{
  "memoryConsolidation": {
    "enabled": false,
    "runAtHour": 3,
    "lookbackDays": 3,
    "providerId": ""
  }
}
```

## Fact extraction

After a session ends with at least _N_ messages, run the transcript through a small LLM and write durable facts into the `agent_facts` table. The agent retrieves these via the `search_memories` tool — useful once memory grows past what fits in a single prompt.

### Enable fact extraction

Master toggle.

### Fact extraction provider

Dedicated provider (defaults to the active chat provider). Use something small and fast — this runs after every non-trivial session.

### Minimum session messages

Sessions shorter than this are skipped (no useful facts to extract). Default: `4`. Range: 1 – 100.

### Full block

```json
{
  "factExtraction": {
    "enabled": false,
    "providerId": "",
    "minSessionMessages": 4
  }
}
```

See [Memory System](../guide/memory) for the full picture of how SOUL, MEMORY, daily notes, user profiles, and the wiki fit together.

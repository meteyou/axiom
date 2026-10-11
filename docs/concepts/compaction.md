# Context Compaction

Every LLM call sends the whole conversation so far. Long chats and long-running background tasks (research, PR work, many tool calls) eventually grow past what the model can hold, or past what you want to pay for on every call. **Context compaction** replaces the older part of the conversation with a structured summary written by the same model, keeps the most recent messages verbatim, and lets the run continue.

Compaction works for both the main chat agent and [background tasks](./tasks-and-cronjobs). It is on by default and switched in [Settings → Agent → Context compaction](../settings/agent#context-compaction); tasks can be excluded under [Settings → Tasks → Context compaction](../settings/tasks#context-compaction).

## When it runs

| Trigger | What happens |
|---|---|
| **Between tool turns** | After every model response that called tools, before the next request, Axiom estimates the context size. Above the trigger threshold it compacts first, then sends the next request. |
| **Before a new message** | Before your next chat message (or a follow-up to a paused task) is sent, the same check runs including the size of the new message. This also catches a switch to a model with a smaller window. |
| **Provider overflow** | If the provider rejects a request as too long anyway, Axiom compacts and retries the request **once**. If that fails too, the turn (or task) ends with an error that says the context window was exceeded. |
| **`/compact [instructions]`** | Manual compaction in the web chat or Telegram. Optional instructions steer the summary, e.g. `/compact keep the exact PR numbers`. Works even when automatic compaction is switched off. |

The context size is the token count the provider reported for the last response plus an estimate (about 4 characters per token, ~1,500 tokens per image) for everything added since.

## What the model keeps

After a compaction the model sees:

1. The unchanged system prompt.
2. A `<context_summary>` message with the summary.
3. The most recent messages, verbatim (about 20k tokens, less on small models).

The cut never separates a tool call from its result. If the cut lands inside one long request, the beginning of that request is summarized separately and merged into the summary, so the original ask is not lost.

Images in the summarized part are not sent to the summary call; they appear there as `[image]` placeholders, so the agent has to re-open the file with `read_file` if it needs to see it again. Images in the recent messages stay and are still subject to the per-request [image limits](../web-ui/chat#attachments).

The summary uses a fixed structure:

```
## Goal
## Constraints & Preferences
## Progress (Done / In Progress / Blocked)
## Key Decisions
## External Actions Already Performed
## Open Threads & Next Steps
## Critical Context
```

The next compaction updates the previous summary instead of starting from scratch, so information carries over across several compactions.

### External actions

**External Actions Already Performed** is not written by the model. Axiom builds it from the summarized tool calls that had side effects: sent or moved emails, written or edited files, created tasks, cronjobs or reminders, files sent to the user, and shell commands such as `git push`, `gh pr …` or `curl -X POST`. Each line lists the call with its outcome (`done`, `failed`). The list is carried over from one compaction to the next, so the agent still knows after the third compaction that it already sent that email. This prevents duplicate pushes, emails or tasks after the history was shortened. Read-only tools (`web_fetch`, `read_file`, …) are not listed.

## Budgets

There is nothing to configure: all budgets derive from the context window `W` of the active model. Fixed defaults apply to large windows; the percentage caps take over on small windows so they do not compact on every turn:

```
reserve  = min(16384, 25% of W)       // room for the model's answer
trigger  = W − reserve                // compaction starts above this
keep     = min(20000, 30% of trigger) // recent messages kept verbatim
summary  = min(8192,  15% of trigger) // length the summary is asked to stay under
```

The summary call itself may use up to 80% of the reserve as output (at least the summary length, at most the model's output limit). The extra room is for reasoning models, which spend part of their output on thinking before writing the summary — some providers cannot switch that off.

Example for a background task on a 40k model with a ~4k system prompt: reserve 10k, trigger 30k, keep 9k, summary up to 4.5k. After a compaction the context is ~17.5k, leaving room for several more turns. On a 262k model, compaction starts around 246k and keeps the last 20k tokens.

To compact earlier on a model with a large window, lower its context window in the [Edit Model dialog](../web-ui/providers#edit-model-dialog).

### Tuning

`reserveTokens` and `keepRecentTokens` can be changed in `settings.json` (see the [settings reference](../reference/settings#compaction)); they are not shown in the UI and are still capped by the percentages above. Most setups never need this.

### Window too small

After a compaction there should be headroom: system prompt + summary + kept messages must stay below 60% of the trigger. Models that cannot meet this are flagged:

- On the [Providers page](../web-ui/providers#model-sub-row-columns) the model gets a **Window too small** badge, with the affected agent kind (main chat, background tasks) in its tooltip. The main chat's system prompt is much larger (~35k tokens) than a task's (~4k), so a model can be fine for tasks but too small for the main chat.
- At runtime the first compaction that hits the problem shows it as a warning under its divider (and in its Telegram status line).

If a compaction cannot bring the context below the trigger (for example a single huge tool result in the kept messages, or a system prompt that nearly fills the window), automatic compaction pauses instead of compacting on every turn, and the divider says so. It resumes on its own as soon as a compaction could get below the trigger again: once newer messages let the cut move past a huge message, or after a switch to a model with a larger window. `/compact` always runs, and a provider overflow still triggers its one compact-and-retry.

At most one compaction runs per model response.

## What you see

- **Web chat**: a divider *"Context compacted (368k → 41k tokens)"*. Click it to expand the summary. While the summary is written the divider shows *"Compacting context…"*. The divider is stored in the chat history and survives a reload.
- **Telegram**: one short status line after a compaction (or a failed one).
- **Task viewer**: the same divider in the task's event stream.

## Costs and records

The summary is one extra LLM call with the current model. It is logged to token usage with the session id of the chat or task, so it shows up on the [Token Usage](../web-ui/token-usage) page like any other call, and it counts towards a task's token and cost totals. Every compaction is also stored in the `context_compactions` table (tokens before/after, summary, model, cost).

A compaction invalidates the provider's prompt cache once, so compacting much earlier than necessary costs more than it saves.

## Limits

- **Summaries lose detail.** Exact identifiers are asked for explicitly, and external actions are carried over deterministically, but nuances of older messages can get lost.
- **If the summary call fails**, nothing is compacted and the run continues with the full context. Only on a real overflow does this end the turn with an error. A summary call that gets no response from the provider for 5 minutes is aborted and counts as failed.
- **One shared main conversation.** The main agent has one runtime for all channels, so a compaction (automatic or `/compact`) affects web chat and Telegram alike.
- **Not restored after a restart.** After a server restart the in-memory conversation starts fresh as before; the stored summaries are not used to rebuild it yet.

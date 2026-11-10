# Session Prompt Snapshot & Action-Tool Toolkit

Contributor notes on how the main agent's system prompt and tool list are frozen per session, how per-turn context travels instead, and how grouped (`area_verb` + `action`) tools are defined. User-facing behavior is documented in `docs/concepts/system-prompt.md` and `docs/concepts/tools.md`.

Why: provider prompt caching covers the prefix *system prompt → tool declarations → history*. Any byte change in the system prompt or the tool list invalidates the whole cached prefix, so both must stay stable within a session.

## Session snapshot (`agent-runtime.ts`)

`PiAgentRuntime` owns a `SessionSnapshot { prompt, sections, tools }`.

- **Built lazily on the first turn** of a session via `ensureSnapshot()`: `streamPrompt` and `retryLastTurn` call it, and task injections (`injectTaskResult` → `processTaskInjection` in `agent.ts`) enter through `streamPrompt` as well. An injection that arrives before any user message builds the snapshot too.
- **`rebuildSnapshot()`** assembles the prompt (`assembleSystemPromptWithSections` in `memory.ts`, or the runtime's fixed prompt), the tool list (`baseTools` + image generation + codemode), sets `agent.state.tools` and returns the system message carrying `toolsAdded`. Image-generation and codemode syncing happens **only here** — toggling them mid-session never changes the running tool list.
- **Rebuilt on compaction**: the compactor's `rebuildSystemMessage` callback calls `rebuildSnapshot()` (the cache is invalidated anyway) and sets `announceChannelAgain`, because the channel prefix may have been folded into the summary.
- **Dropped on session end**: `clearMessages()` removes the system message and sets `snapshot = null`; the next turn builds a fresh one.
- **Context breakdown** (`getContextUsage`) uses `snapshot.sections` only while the leading system message still equals `snapshot.prompt`.

There is deliberately no mid-session prompt refresh. Anything that feeds the prompt (settings, memory editor, consolidation, skills) applies from the next session or compaction. If you add a new prompt input, do **not** add a refresh hook; document it as "applies from the next session".

### Prompt layout

`assembleSystemPromptWithSections` emits, in order: `personality`, `instructions`, `agent_rules`, `system_rules`, `core_memory`, `recent_memory`, `current_user`, `user_profile`, `available_providers`, `available_skills`, `paths`, `language`. Section keys live in the core contract (`SystemPromptSectionKey`) and have en/de labels in the frontend locales — keep all three in sync.

`buildSystemRules()` and `buildPathsBlock()` (`system-prompt-blocks.ts`) are pure and shared with the background task prompt (`task-system-prompt.ts`, `variant: 'task'`). Safety rules belong in `buildSystemRules`, not in the `AGENTS.md` template: users rewrite `AGENTS.md`, and the template only seeds missing files (existing installations are never migrated).

Things that must **not** go into the system prompt because they change within a session: the date/time, the channel, anything listing growing data (e.g. wiki page names — use `memory_search` and the wiki FTS index in `wiki-index.ts` instead).

## Per-turn context (`turn-context.ts`, `delivery-channel.ts`)

`formatTurnContext({ previousChannel, currentChannel, isFirstTurn, timezone, now })` is pure and returns:

- `suffix` — `<current_time>` with weekday, date, time and timezone, appended to every user message.
- `prefix` — an optional `<channel_context>`: Telegram guidance on the first Telegram turn or when switching to Telegram; a short web note only when switching back from Telegram; nothing otherwise (web is the silent default).

The runtime tracks `lastTurnChannel` per session. `getTurnContext()` only computes the prefix; the channel state advances in `startRun` right before the message is added to the transcript, so a turn that is stopped earlier or continues the transcript (retry) announces the channel again next time. Task injections get their channel from `resolveDeliveryChannel()` **before** the injection runs, using the same rules as notification delivery (user, Telegram delivery mode `auto`/`always`, active web socket, Telegram link; for `always` Telegram wins). Don't let the injection guess the channel on its own.

## Action-tool toolkit (`action-tool.ts`)

`defineActionTool({ name, label, description, parameters, actions })` builds one tool that groups several operations behind an `action` enum. Used by `task_write`, `schedule_read`, `schedule_write` and `email_read`.

- **Flat schema.** Every parameter except `action` is optional in the JSON schema; no `oneOf`/`anyOf`, because OpenAI strict mode and Gemini reject them. The `action` enum description is generated from each action's `description` and `required` list.
- **Per-action validation.** `required` fields are checked at execution time; errors are precise (`"schedule is required for action=create."`, `Unknown action "x" for schedule_write. Valid actions: …`) so the model can self-correct.
- **Per-action replay policy.** Each action declares `replay: 'safe' | 'unsafe'`, exposed as `actionReplayPolicies`. `getToolReplayPolicy(name, args)` in `tool-replay.ts` classifies by tool + action; `tool-replay.test.ts` asserts that the static table matches every registered action tool. Reads are `safe`; anything that writes, sends, spawns or deletes is `unsafe`; unknown tools/actions default to `unsafe`.
- **Shared parameters.** `AGENT_RUN_PARAMETERS` (`provider`, `model`, `thinking_level`, `attached_skills`) is defined once and spread into `task_write` and `schedule_write`. Reuse it for any new tool that spawns or schedules an agent run instead of re-describing the fields.

When adding a grouped tool: define it with `defineActionTool`, add its classification to `TOOL_REPLAY_POLICIES`, add en/de labels per action in the frontend `toolLabels` table (and summary fields in `toolNameFormat.ts`), and — if it replaces old tools — add the old names to the legacy mapping.

## Legacy tool names (`contracts/tool-names.ts`)

`LEGACY_TOOL_NAMES` maps every old name to `{ name, action?, scheduleType? }`. It is the single source used by:

- the frontend label/summary/detection code (`resolveToolName`), so old chat history renders like new calls,
- the skill parser (`currentToolNames` for `allowed-tools` and `requires_toolsets`),
- the replay policy (journal entries written under old names),
- the idempotent DB migration `migrateScheduledTaskToolOverrides` (`scheduled-task-store.ts`, run from `initDatabase`). A grouped tool is only disabled when *all* its legacy members were disabled; otherwise it stays enabled and the migration logs it.

The model only ever sees current names — never declare aliases. Stored chat/tool history is not rewritten.

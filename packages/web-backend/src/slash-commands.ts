/**
 * Web-backend wrapper around the shared slash-command registry.
 *
 * Builds the registry used by the web chat WebSocket layer. Adds metadata-only
 * entries for surface-owned commands (`/new`, `/stop`, `/kill`) so they show up
 * in `/help` even though their behaviour stays inline in `ws-chat.ts` (they
 * have to manipulate transport-level state like the active stream and the
 * cached session ID, which the registry deliberately doesn't know about).
 */

import { SlashCommandRegistry, registerBuiltInSlashCommands } from '@axiom/core'

export function buildWebChatSlashCommandRegistry(): SlashCommandRegistry {
  const registry = new SlashCommandRegistry()
  registerBuiltInSlashCommands(registry)

  // Surface-owned commands — handler intentionally omitted; ws-chat.ts handles
  // them inline because they need to abort the active stream / reset session.
  registry.register({
    name: 'new',
    description: 'Summarize the current session and start a fresh conversation.',
    surfaces: ['web', 'telegram'],
  })
  registry.register({
    name: 'stop',
    aliases: ['kill'],
    description: 'Abort the current agent turn and clear queued work.',
    surfaces: ['web', 'telegram'],
  })

  return registry
}

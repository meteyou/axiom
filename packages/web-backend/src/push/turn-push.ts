import type { ResponseChunk, TurnEvent, TurnSubscriber } from '@axiom/core'
import type { PushNotificationPayload, PushNotifier } from './push-notifier.js'

export interface ChatClientPresence {
  visible: boolean
}

export type TurnOutcome =
  | { status: 'completed'; replyText: string }
  | { status: 'failed'; error: string }

type NotificationLocale = 'en' | 'de'

const NOTIFICATION_TEXT: Record<NotificationLocale, { replyReady: string; replyFailed: string; test: string }> = {
  en: {
    replyReady: 'Reply ready',
    replyFailed: 'The reply failed',
    test: 'Test notification: push works on this device.',
  },
  de: {
    replyReady: 'Antwort fertig',
    replyFailed: 'Die Antwort ist fehlgeschlagen',
    test: 'Testbenachrichtigung: Push funktioniert auf diesem Gerät.',
  },
}

const NOTIFICATION_TITLE = 'Axiom'
const CHAT_URL = '/'
/** One tag for all chat notifications, so a new reply replaces the previous one instead of stacking. */
const CHAT_NOTIFICATION_TAG = 'axiom-chat'
const TEST_NOTIFICATION_TAG = 'axiom-test'
export const PREVIEW_MAX_CHARS = 120

/** A user counts as present while any of their chat connections reports a visible page. */
export function shouldNotifyAboutTurn(clients: Iterable<ChatClientPresence>): boolean {
  for (const client of clients) {
    if (client.visible) return false
  }
  return true
}

function resolveLocale(locale: string | null | undefined): NotificationLocale {
  return locale?.toLowerCase().startsWith('de') ? 'de' : 'en'
}

function formatPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= PREVIEW_MAX_CHARS) return collapsed
  return `${collapsed.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`
}

export function buildTurnNotificationPayload(
  outcome: TurnOutcome,
  options: { showPreview: boolean; locale?: string | null },
): PushNotificationPayload {
  const text = NOTIFICATION_TEXT[resolveLocale(options.locale)]
  const fallback = outcome.status === 'completed' ? text.replyReady : text.replyFailed
  const previewSource = outcome.status === 'completed' ? outcome.replyText : outcome.error
  const preview = options.showPreview ? formatPreview(previewSource) : ''
  return {
    kind: outcome.status === 'completed' ? 'chat_reply' : 'chat_error',
    title: NOTIFICATION_TITLE,
    body: preview || fallback,
    url: CHAT_URL,
    tag: CHAT_NOTIFICATION_TAG,
  }
}

export function buildTestNotificationPayload(locale?: string | null): PushNotificationPayload {
  return {
    kind: 'test',
    title: NOTIFICATION_TITLE,
    body: NOTIFICATION_TEXT[resolveLocale(locale)].test,
    url: CHAT_URL,
    tag: TEST_NOTIFICATION_TAG,
  }
}

interface TurnSubscribable {
  subscribe: (user: number | string, subscriber: TurnSubscriber) => () => void
}

/**
 * The reply preview is the last text segment, i.e. the answer after the final
 * tool call rather than the "let me check…" preamble. A scheduled retry
 * discards the failed attempt's text, as the transcript does.
 */
function createOutcomeCollector() {
  let currentSegment = ''
  let lastSegment = ''
  let failure: string | null = null

  return {
    record(chunk: ResponseChunk): void {
      switch (chunk.type) {
        case 'text':
          currentSegment += chunk.text ?? ''
          break
        case 'tool_call_start':
          if (currentSegment.trim()) lastSegment = currentSegment
          currentSegment = ''
          break
        case 'retry_scheduled':
          currentSegment = ''
          lastSegment = ''
          break
        case 'error':
          failure = chunk.error ?? chunk.text ?? ''
          break
      }
    },
    outcome(): TurnOutcome {
      if (failure !== null) return { status: 'failed', error: failure }
      return { status: 'completed', replyText: currentSegment.trim() ? currentSegment : lastSegment }
    },
  }
}

/**
 * Follows one turn to its end and reports how it ended. Returns a function
 * that stops watching without reporting (used when the user aborts the turn).
 */
export function watchTurnOutcome(
  runner: TurnSubscribable,
  user: number | string,
  turnId: string,
  onSettled: (outcome: TurnOutcome) => void,
): () => void {
  const collector = createOutcomeCollector()
  let unsubscribe: (() => void) | null = null
  let settled = false

  const stop = () => {
    settled = true
    unsubscribe?.()
    unsubscribe = null
  }

  const handle = (event: TurnEvent) => {
    if (settled || event.turnId !== turnId) return
    if (event.type === 'chunk') {
      collector.record(event.chunk)
    } else if (event.type === 'turn_end') {
      stop()
      onSettled(collector.outcome())
    }
  }

  unsubscribe = runner.subscribe(user, handle)
  // The turn may already have ended inside subscribe() through its replay.
  if (settled) unsubscribe()
  return stop
}

export interface WebTurnPushOptions {
  runner: TurnSubscribable
  notifier: PushNotifier
  /** Presence of the user's chat connections at the moment the turn ends. */
  getClients: (userId: number) => Iterable<ChatClientPresence>
  getShowPreview: (userId: number) => boolean
  logger?: Pick<typeof console, 'warn'>
}

export interface WebTurnPush {
  watch: (userId: number, turnId: string) => void
  /** Drop pending notifications of a user, e.g. after they aborted their turns. */
  cancelForUser: (userId: number) => void
}

interface PendingWatch {
  stop: () => void
}

/**
 * Pushes "reply ready" / "reply failed" for web chat turns whose user is not
 * looking at the chat when the turn ends. Presence is evaluated at the end of
 * the turn, not at its start, so leaving mid-turn still notifies.
 */
export function createWebTurnPush(options: WebTurnPushOptions): WebTurnPush {
  const logger = options.logger ?? console
  const pending = new Map<number, Set<PendingWatch>>()

  function track(userId: number, watch: PendingWatch): void {
    let watches = pending.get(userId)
    if (!watches) {
      watches = new Set()
      pending.set(userId, watches)
    }
    watches.add(watch)
  }

  function forget(userId: number, watch: PendingWatch): void {
    const watches = pending.get(userId)
    if (!watches) return
    watches.delete(watch)
    if (watches.size === 0) pending.delete(userId)
  }

  function notify(userId: number, outcome: TurnOutcome): void {
    if (!shouldNotifyAboutTurn(options.getClients(userId))) return
    let showPreview = false
    try {
      showPreview = options.getShowPreview(userId)
    } catch (err) {
      logger.warn(`[push] Could not read preview preference of user ${userId}:`, err)
    }
    options.notifier
      .sendToUser(userId, device => buildTurnNotificationPayload(outcome, { showPreview, locale: device.locale }))
      .catch(err => logger.warn(`[push] Turn notification for user ${userId} failed:`, err))
  }

  return {
    watch(userId, turnId) {
      const watch: PendingWatch = { stop: () => {} }
      track(userId, watch)
      watch.stop = watchTurnOutcome(options.runner, userId, turnId, (outcome) => {
        forget(userId, watch)
        notify(userId, outcome)
      })
    },
    cancelForUser(userId) {
      for (const watch of pending.get(userId) ?? []) watch.stop()
      pending.delete(userId)
    },
  }
}

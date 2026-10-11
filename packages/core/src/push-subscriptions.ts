import type { Database } from './database.js'

export interface PushSubscriptionKeys {
  p256dh: string
  auth: string
}

export interface PushSubscriptionRecord {
  id: number
  userId: number
  endpoint: string
  keys: PushSubscriptionKeys
  deviceLabel: string | null
  userAgent: string | null
  /** Origin the device subscribed from; doubles as the VAPID contact when none is configured. */
  origin: string | null
  /** UI locale of the subscribing device, used for the notification text. */
  locale: string | null
  createdAt: string
  lastSuccessAt: string | null
}

export interface SavePushSubscriptionInput {
  userId: number
  endpoint: string
  keys: PushSubscriptionKeys
  deviceLabel?: string | null
  userAgent?: string | null
  origin?: string | null
  locale?: string | null
}

interface PushSubscriptionRow {
  id: number
  user_id: number
  endpoint: string
  p256dh: string
  auth: string
  device_label: string | null
  user_agent: string | null
  origin: string | null
  locale: string | null
  created_at: string
  last_success_at: string | null
}

/**
 * Users are soft-deleted, so the cascade only covers hard deletes;
 * `purgeUserData()` removes the rows of soft-deleted users explicitly.
 */
export function initPushSubscriptionsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      device_label TEXT,
      user_agent TEXT,
      origin TEXT,
      locale TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_success_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
  `)
}

function toRecord(row: PushSubscriptionRow): PushSubscriptionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
    deviceLabel: row.device_label,
    userAgent: row.user_agent,
    origin: row.origin,
    locale: row.locale,
    createdAt: row.created_at,
    lastSuccessAt: row.last_success_at,
  }
}

/**
 * An endpoint identifies one browser installation, so re-subscribing it moves
 * the device to whoever is logged in now instead of notifying the previous user.
 */
export function savePushSubscription(db: Database, input: SavePushSubscriptionInput): PushSubscriptionRecord {
  const row = db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_label, user_agent, origin, locale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      user_id = excluded.user_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      device_label = excluded.device_label,
      user_agent = excluded.user_agent,
      origin = excluded.origin,
      locale = excluded.locale,
      created_at = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.created_at ELSE datetime('now') END,
      last_success_at = CASE WHEN push_subscriptions.user_id = excluded.user_id THEN push_subscriptions.last_success_at ELSE NULL END
    RETURNING *
  `).get(
    input.userId,
    input.endpoint,
    input.keys.p256dh,
    input.keys.auth,
    input.deviceLabel ?? null,
    input.userAgent ?? null,
    input.origin ?? null,
    input.locale ?? null,
  ) as PushSubscriptionRow
  return toRecord(row)
}

export function listPushSubscriptions(db: Database, userId: number): PushSubscriptionRecord[] {
  const rows = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC, id DESC')
    .all(userId) as PushSubscriptionRow[]
  return rows.map(toRecord)
}

/** Only removes the row when it belongs to `userId`; returns whether something was removed. */
export function deleteOwnPushSubscription(db: Database, userId: number, id: number): boolean {
  return db.prepare('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?').run(id, userId).changes > 0
}

export function deletePushSubscriptionByEndpoint(db: Database, endpoint: string): boolean {
  return db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0
}

export function markPushSubscriptionDelivered(db: Database, id: number): void {
  db.prepare("UPDATE push_subscriptions SET last_success_at = datetime('now') WHERE id = ?").run(id)
}

export function getPushPreviewEnabled(db: Database, userId: number): boolean {
  const row = db.prepare('SELECT push_show_preview FROM users WHERE id = ?').get(userId) as { push_show_preview: number } | undefined
  return row?.push_show_preview === 1
}

export function setPushPreviewEnabled(db: Database, userId: number, enabled: boolean): void {
  db.prepare("UPDATE users SET push_show_preview = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, userId)
}

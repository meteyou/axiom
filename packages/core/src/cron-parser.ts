// Minimal cron expression parser and next-run-time calculator.
//
// Supports standard 5-field cron format: minute hour day-of-month month day-of-week
// Examples:
//   "0 9 * * *"       - Every day at 9:00
//   "star/15 * * * *" - Every 15 minutes (replace star with *)
//   "0 9 * * 1-5"     - Weekdays at 9:00
//   "30 14 1 * *"     - 1st of every month at 14:30
//   "0 0 * * 0"       - Every Sunday at midnight

export interface CronFields {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
}

/**
 * Parse a single cron field into an array of allowed values.
 */
function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>()

  for (const part of field.split(',')) {
    const trimmed = part.trim()

    // Handle step: */N or range/N
    const stepMatch = trimmed.match(/^(.+)\/(\d+)$/)
    if (stepMatch) {
      const [, rangePart, stepStr] = stepMatch
      const step = parseInt(stepStr, 10)
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step value: ${stepStr}`)

      let rangeMin = min
      let rangeMax = max

      if (rangePart !== '*') {
        const dashMatch = rangePart.match(/^(\d+)-(\d+)$/)
        if (dashMatch) {
          rangeMin = parseInt(dashMatch[1], 10)
          rangeMax = parseInt(dashMatch[2], 10)
        } else {
          rangeMin = parseInt(rangePart, 10)
          rangeMax = max
        }
      }

      for (let i = rangeMin; i <= rangeMax; i += step) {
        if (i >= min && i <= max) values.add(i)
      }
      continue
    }

    // Handle wildcard
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) values.add(i)
      continue
    }

    // Handle range: N-M
    const dashMatch = trimmed.match(/^(\d+)-(\d+)$/)
    if (dashMatch) {
      const start = parseInt(dashMatch[1], 10)
      const end = parseInt(dashMatch[2], 10)
      if (start > end) throw new Error(`Invalid range: ${trimmed}`)
      for (let i = start; i <= end; i++) {
        if (i >= min && i <= max) values.add(i)
      }
      continue
    }

    // Handle single number
    const num = parseInt(trimmed, 10)
    if (isNaN(num)) throw new Error(`Invalid cron field value: ${trimmed}`)
    if (num < min || num > max) throw new Error(`Value ${num} out of range [${min}-${max}]`)
    values.add(num)
  }

  if (values.size === 0) throw new Error(`Empty cron field: ${field}`)
  return Array.from(values).sort((a, b) => a - b)
}

/**
 * Parse a 5-field cron expression string.
 * @throws Error if the expression is invalid
 */
export function parseCronExpression(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}. Format: "minute hour day-of-month month day-of-week"`)
  }

  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek: parseField(parts[4], 0, 6), // 0 = Sunday
  }
}

/**
 * Validate a cron expression string.
 * @returns null if valid, error message string if invalid
 */
export function validateCronExpression(expression: string): string | null {
  try {
    parseCronExpression(expression)
    return null
  } catch (err) {
    return (err as Error).message
  }
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatterCache.set(timezone, formatter)
  }
  return formatter
}

/** Wall-clock time of an instant in `timezone`, encoded as a UTC timestamp. */
function toWallMs(instantMs: number, timezone: string): number {
  const parts: Record<string, number> = {}
  for (const part of getFormatter(timezone).formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

function offsetAt(instantMs: number, timezone: string): number {
  return toWallMs(instantMs, timezone) - Math.floor(instantMs / 1000) * 1000
}

/**
 * Instants at which the wall clock of `timezone` shows `wallMs`, ascending.
 * Empty inside a spring-forward gap, two entries inside a fall-back overlap.
 */
function wallToInstants(wallMs: number, timezone: string): number[] {
  const DAY = 86_400_000
  const offsets = new Set([offsetAt(wallMs - DAY, timezone), offsetAt(wallMs + DAY, timezone)])
  const instants: number[] = []
  for (const offset of offsets) {
    const instant = wallMs - offset
    if (offsetAt(instant, timezone) === offset) instants.push(instant)
  }
  return instants.sort((a, b) => a - b)
}

function getSystemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** @returns true when `timezone` is a valid IANA timezone identifier */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

/** Earliest wall-clock minute at or after `startWallMs` (UTC-encoded) matching the fields. */
function findNextMatchingWall(fields: CronFields, startWallMs: number, maxWallMs: number): number | null {
  const next = new Date(startWallMs)

  while (next.getTime() <= maxWallMs) {
    const month = next.getUTCMonth() + 1
    const dayOfMonth = next.getUTCDate()
    const dayOfWeek = next.getUTCDay()
    const hour = next.getUTCHours()
    const minute = next.getUTCMinutes()

    if (!fields.months.includes(month)) {
      next.setUTCMonth(next.getUTCMonth() + 1, 1)
      next.setUTCHours(0, 0, 0, 0)
      continue
    }

    const domMatch = fields.daysOfMonth.includes(dayOfMonth)
    const dowMatch = fields.daysOfWeek.includes(dayOfWeek)

    // Standard cron: if both dom and dow are restricted (not *), match either.
    const domIsWild = fields.daysOfMonth.length === 31
    const dowIsWild = fields.daysOfWeek.length === 7

    let dayMatch: boolean
    if (domIsWild && dowIsWild) {
      dayMatch = true
    } else if (domIsWild) {
      dayMatch = dowMatch
    } else if (dowIsWild) {
      dayMatch = domMatch
    } else {
      dayMatch = domMatch || dowMatch
    }

    if (!dayMatch) {
      next.setUTCDate(next.getUTCDate() + 1)
      next.setUTCHours(0, 0, 0, 0)
      continue
    }

    if (!fields.hours.includes(hour)) {
      const nextHour = fields.hours.find(h => h > hour)
      if (nextHour !== undefined) {
        next.setUTCHours(nextHour, fields.minutes[0], 0, 0)
      } else {
        next.setUTCDate(next.getUTCDate() + 1)
        next.setUTCHours(0, 0, 0, 0)
      }
      continue
    }

    if (!fields.minutes.includes(minute)) {
      const nextMinute = fields.minutes.find(m => m > minute)
      if (nextMinute !== undefined) {
        next.setUTCMinutes(nextMinute, 0, 0)
      } else {
        next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0)
      }
      continue
    }

    return next.getTime()
  }

  return null
}

/**
 * Calculate the next run time after `after` for the given cron fields,
 * evaluated on the wall clock of an IANA timezone (default: the system timezone).
 *
 * Wall-clock times skipped by a spring-forward gap do not run that day; times
 * repeated by a fall-back overlap run once, at their first occurrence.
 *
 * @param fields Parsed cron fields
 * @param after Date to search from (exclusive)
 * @param timezone IANA timezone, e.g. "Europe/Berlin"
 * @returns Next matching Date, or null if none found within 2 years
 */
export function getNextRunTime(fields: CronFields, after: Date = new Date(), timezone?: string): Date | null {
  const tz = timezone && isValidTimezone(timezone) ? timezone : getSystemTimezone()
  const afterMs = after.getTime()
  const MINUTE = 60_000
  const maxWallMs = toWallMs(afterMs, tz) + 2 * 366 * 86_400_000

  let wallCursor = Math.floor(toWallMs(afterMs, tz) / MINUTE) * MINUTE + MINUTE
  while (true) {
    const wall = findNextMatchingWall(fields, wallCursor, maxWallMs)
    if (wall === null) return null
    const instant = wallToInstants(wall, tz).find(i => i > afterMs)
    if (instant !== undefined) return new Date(instant)
    wallCursor = wall + MINUTE
  }
}

/**
 * Convert a cron expression to a human-readable description.
 */
export function cronToHumanReadable(expression: string): string {
  try {
    const fields = parseCronExpression(expression)
    const parts: string[] = []

    const domIsWild = fields.daysOfMonth.length === 31
    const dowIsWild = fields.daysOfWeek.length === 7
    const monthIsWild = fields.months.length === 12
    const hourIsWild = fields.hours.length === 24
    const minuteIsWild = fields.minutes.length === 60

    // Time description
    if (!hourIsWild && !minuteIsWild) {
      if (fields.hours.length === 1 && fields.minutes.length === 1) {
        parts.push(`At ${pad(fields.hours[0])}:${pad(fields.minutes[0])}`)
      } else {
        parts.push(`At ${fields.hours.map(h => `${pad(h)}:${fields.minutes.map(m => pad(m)).join(',')}`).join(', ')}`)
      }
    } else if (!minuteIsWild && hourIsWild) {
      if (fields.minutes.length === 1 && fields.minutes[0] === 0) {
        parts.push('Every hour')
      } else {
        parts.push(`At minute ${fields.minutes.join(', ')} of every hour`)
      }
    } else if (minuteIsWild && !hourIsWild) {
      parts.push(`Every minute during hour ${fields.hours.join(', ')}`)
    } else {
      // Check for step patterns
      const rawParts = expression.trim().split(/\s+/)
      if (rawParts[0].includes('/')) {
        const step = rawParts[0].split('/')[1]
        parts.push(`Every ${step} minutes`)
      } else {
        parts.push('Every minute')
      }
    }

    // Day-of-week description
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    if (!dowIsWild) {
      const names = fields.daysOfWeek.map(d => dayNames[d])
      parts.push(`on ${names.join(', ')}`)
    }

    // Day-of-month description
    if (!domIsWild) {
      parts.push(`on day ${fields.daysOfMonth.join(', ')}`)
    }

    // Month description
    if (!monthIsWild) {
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const names = fields.months.map(m => monthNames[m - 1])
      parts.push(`in ${names.join(', ')}`)
    }

    return parts.join(' ') || expression
  } catch {
    return expression
  }
}

function pad(n: number): string {
  return n.toString().padStart(2, '0')
}

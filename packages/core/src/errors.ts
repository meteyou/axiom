/**
 * Typed error classes for stable error identification.
 *
 * Use these instead of matching on error message strings so that
 * HTTP routes (and other callers) can reliably map errors to status codes.
 */

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND' as const

  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export class InvalidInputError extends Error {
  readonly code = 'INVALID_INPUT' as const

  constructor(message: string) {
    super(message)
    this.name = 'InvalidInputError'
  }
}

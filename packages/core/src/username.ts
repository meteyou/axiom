/**
 * Validate a username: must be alphanumeric only (a-zA-Z0-9).
 * Returns true if valid, false otherwise.
 */
export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9]+$/.test(username)
}

/**
 * Validate a username and throw an error if invalid.
 */
export function validateUsername(username: string): void {
  if (!isValidUsername(username)) {
    throw new Error(`Invalid username "${username}": only alphanumeric characters (a-zA-Z0-9) are allowed, no spaces, umlauts, or special characters.`)
  }
}

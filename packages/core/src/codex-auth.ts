// The ChatGPT (Codex) OAuth access token is a JWT whose account id lives under
// this namespaced claim. ChatGPT backend endpoints require that id next to the
// bearer token.
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

/**
 * Extract the ChatGPT account id from a Codex OAuth access token (JWT). The id
 * is stable across token refreshes, so deriving it from the current access
 * token avoids depending on a separately-stored copy.
 */
export function extractCodexAccountId(accessToken: string): string | null {
  try {
    const parts = accessToken.split('.')
    if (parts.length !== 3) return null

    const payloadBase64 = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(parts[1].length / 4) * 4, '=')

    const payloadText = Buffer.from(payloadBase64, 'base64').toString('utf-8')
    const payload = JSON.parse(payloadText) as {
      [JWT_CLAIM_PATH]?: { chatgpt_account_id?: string }
    }

    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id
    return typeof accountId === 'string' && accountId.length > 0 ? accountId : null
  } catch {
    return null
  }
}

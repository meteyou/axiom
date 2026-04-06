/**
 * Shared composable for the chat input field.
 * Plugins can call `setText()` to inject text into the chat input.
 * The chat input component watches `pendingText` and applies it.
 */
export const useChatInput = () => {
  const pendingText = useState<string | null>('chatInputPending', () => null)
  const setText = (text: string) => {
    pendingText.value = text
  }
  return { pendingText, setText }
}

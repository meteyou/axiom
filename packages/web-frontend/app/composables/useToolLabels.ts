import { formatToolName as formatToolLabel, type TranslateFn } from '~/utils/toolNameFormat'

/** Tool-call labels bound to the active UI locale. */
export function useToolLabels() {
  const { t } = useI18n()
  const translate: TranslateFn = key => t(key)

  function formatToolName(name: string, args?: unknown): string {
    return formatToolLabel(name, args, translate)
  }

  return { formatToolName, translate }
}

export interface PushDevice {
  id: number
  endpoint: string
  deviceLabel: string | null
  userAgent: string | null
  createdAt: string
  lastSuccessAt: string | null
}

export interface PushDeliveryResult {
  subscriptionId: number
  deviceLabel: string | null
  status: 'sent' | 'removed' | 'failed'
  statusCode: number | null
  error: string | null
}

export function usePushApi() {
  const { apiFetch } = useApi()

  const getPublicKey = () => apiFetch<{ publicKey: string }>('/api/push/vapid-public-key')
  const listDevices = () => apiFetch<{ devices: PushDevice[]; showPreview: boolean }>('/api/push/subscriptions')
  const subscribe = (subscription: PushSubscriptionJSON, deviceLabel: string, locale: string) =>
    apiFetch<{ device: PushDevice }>('/api/push/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ subscription, deviceLabel, locale }),
    })
  const removeDevice = (id: number) => apiFetch<{ removed: boolean }>(`/api/push/subscriptions/${id}`, { method: 'DELETE' })
  const sendTest = () => apiFetch<{ results: PushDeliveryResult[] }>('/api/push/test', { method: 'POST' })
  const setShowPreview = (showPreview: boolean) => apiFetch<{ showPreview: boolean }>('/api/push/preferences', {
    method: 'PUT',
    body: JSON.stringify({ showPreview }),
  })

  return { getPublicKey, listDevices, subscribe, removeDevice, sendTest, setShowPreview }
}

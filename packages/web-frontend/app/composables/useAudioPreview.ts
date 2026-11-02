/** Plays one audio blob at a time and frees its object URL when playback ends. */
export function useAudioPreview() {
  const playing = ref(false)
  let audio: HTMLAudioElement | null = null
  let blobUrl: string | null = null

  function stop() {
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audio = null
    }
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl)
      blobUrl = null
    }
    playing.value = false
  }

  async function play(blob: Blob) {
    stop()
    blobUrl = URL.createObjectURL(blob)
    audio = new Audio(blobUrl)
    audio.onended = stop
    audio.onerror = stop
    await audio.play()
    playing.value = true
  }

  onUnmounted(stop)

  return { playing, play, stop }
}

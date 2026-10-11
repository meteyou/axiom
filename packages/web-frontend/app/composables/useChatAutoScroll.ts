import { nextTick, ref, type Ref } from 'vue'

type ScrollContainer = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>

const REATTACH_THRESHOLD = 16

/**
 * Keeps a streaming transcript pinned to the bottom until the user scrolls up.
 *
 * Upward intent is taken from wheel/touch input before the browser scrolls:
 * tokens can arrive between the user's scroll and its `scroll` event, and a
 * programmatic jump to the bottom in that window would swallow the gesture.
 */
export function useChatAutoScroll(container: Ref<ScrollContainer | null>) {
  const following = ref(true)
  let lastScrollTop = 0
  let lastScrollHeight = 0
  let lastTouchY: number | null = null

  function isScrollable(el: ScrollContainer) {
    return el.scrollHeight > el.clientHeight
  }

  function remember(el: ScrollContainer) {
    lastScrollTop = el.scrollTop
    lastScrollHeight = el.scrollHeight
  }

  function scrollToBottom() {
    const el = container.value
    if (!el) return
    el.scrollTop = el.scrollHeight
    remember(el)
  }

  function detach() {
    const el = container.value
    if (el && isScrollable(el)) following.value = false
  }

  function onScroll() {
    const el = container.value
    if (!el) return
    // Shrinking content clamps scrollTop downwards without any user input.
    const movedUp = el.scrollTop < lastScrollTop && el.scrollHeight >= lastScrollHeight
    if (movedUp) {
      following.value = false
    } else if (el.scrollHeight - el.scrollTop - el.clientHeight <= REATTACH_THRESHOLD) {
      following.value = true
    }
    remember(el)
  }

  function onWheel(event: Pick<WheelEvent, 'deltaY'>) {
    if (event.deltaY < 0) detach()
  }

  function onTouchStart(event: Pick<TouchEvent, 'touches'>) {
    lastTouchY = event.touches[0]?.clientY ?? null
  }

  function onTouchMove(event: Pick<TouchEvent, 'touches'>) {
    const y = event.touches[0]?.clientY
    if (y === undefined) return
    if (lastTouchY !== null && y > lastTouchY) detach()
    lastTouchY = y
  }

  function followIfPinned() {
    if (following.value) nextTick(scrollToBottom)
  }

  function jumpToBottom() {
    following.value = true
    nextTick(scrollToBottom)
  }

  return {
    following,
    onScroll,
    onWheel,
    onTouchStart,
    onTouchMove,
    followIfPinned,
    jumpToBottom,
    scrollToBottom,
  }
}

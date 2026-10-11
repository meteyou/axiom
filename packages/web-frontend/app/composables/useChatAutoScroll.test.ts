import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import { useChatAutoScroll } from './useChatAutoScroll'

function setup({ scrollHeight = 2000, clientHeight = 500 } = {}) {
  const el = { scrollTop: 0, scrollHeight, clientHeight }
  const scroll = useChatAutoScroll(ref(el))
  scroll.scrollToBottom()
  return { el, scroll }
}

function touch(clientY: number) {
  return { touches: [{ clientY }] } as unknown as TouchEvent
}

describe('useChatAutoScroll', () => {
  it('keeps following streamed content while pinned', async () => {
    const { el, scroll } = setup()
    el.scrollHeight = 2400
    scroll.followIfPinned()
    await nextTick()
    expect(el.scrollTop).toBe(2400)
    expect(scroll.following.value).toBe(true)
  })

  it('stops following on an upward wheel before the scroll event lands', async () => {
    const { el, scroll } = setup()
    scroll.onWheel({ deltaY: -40 })
    el.scrollHeight = 2400
    scroll.followIfPinned()
    await nextTick()
    expect(scroll.following.value).toBe(false)
    expect(el.scrollTop).toBe(2000)
  })

  it('stops following on a downward swipe (content scrolls up)', () => {
    const { scroll } = setup()
    scroll.onTouchStart(touch(300))
    scroll.onTouchMove(touch(310))
    expect(scroll.following.value).toBe(false)
  })

  it('stops following when scrolled up by only a few pixels (e.g. scrollbar drag)', () => {
    const { el, scroll } = setup()
    el.scrollTop -= 10
    scroll.onScroll()
    expect(scroll.following.value).toBe(false)
  })

  it('does not treat content shrinking as scrolling up', () => {
    const { el, scroll } = setup()
    el.scrollHeight = 1800
    el.scrollTop = 1300
    scroll.onScroll()
    expect(scroll.following.value).toBe(true)
  })

  it('resumes following once the user scrolls back to the bottom', () => {
    const { el, scroll } = setup()
    scroll.onWheel({ deltaY: -40 })
    el.scrollTop = 1200
    scroll.onScroll()
    expect(scroll.following.value).toBe(false)
    el.scrollTop = 1490
    scroll.onScroll()
    expect(scroll.following.value).toBe(true)
  })

  it('ignores upward input when there is nothing to scroll', () => {
    const { scroll } = setup({ scrollHeight: 400, clientHeight: 500 })
    scroll.onWheel({ deltaY: -40 })
    expect(scroll.following.value).toBe(true)
  })

  it('jumpToBottom re-pins and scrolls', async () => {
    const { el, scroll } = setup()
    scroll.onWheel({ deltaY: -40 })
    scroll.jumpToBottom()
    await nextTick()
    expect(scroll.following.value).toBe(true)
    expect(el.scrollTop).toBe(2000)
  })
})

import type { Component } from 'vue'
import type { OpenAgentFrontendPlugin } from './types'

/** Registered plugin components per slot */
const slots: Record<string, Component[]> = {}

/**
 * Register a frontend plugin and add its components to the appropriate slots.
 */
export function registerPlugin(plugin: OpenAgentFrontendPlugin): void {
  for (const [slot, component] of Object.entries(plugin.slots)) {
    if (!component) continue
    if (!slots[slot]) {
      slots[slot] = []
    }
    slots[slot].push(component as Component)
  }
}

/**
 * Returns all registered components for a given slot name.
 */
export function getSlot(slot: string): Component[] {
  return slots[slot] ?? []
}

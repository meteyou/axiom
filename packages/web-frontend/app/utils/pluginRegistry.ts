import { ref } from 'vue'
import type { Ref } from 'vue'
import type { Component } from 'vue'
import type { OpenAgentFrontendPlugin } from './pluginTypes'

/** Components registered per plugin ID per slot */
const pluginSlots: Record<string, Record<string, Component>> = {}

/** Reactive map of plugin enabled states */
export const pluginEnabledStates: Ref<Record<string, boolean>> = ref({})

/**
 * Register a frontend plugin and store its slot components keyed by plugin ID.
 */
export function registerPlugin(plugin: OpenAgentFrontendPlugin): void {
  pluginSlots[plugin.id] = {}

  const slotMap = pluginSlots[plugin.id]!
  for (const [slot, component] of Object.entries(plugin.slots)) {
    if (!component) continue
    slotMap[slot] = component as Component
  }

  // Set default enabled state only if not already set
  if (pluginEnabledStates.value[plugin.id] === undefined) {
    pluginEnabledStates.value[plugin.id] = true
  }
}

/**
 * Enable or disable a plugin at runtime. Updates the reactive state.
 */
export function setPluginEnabled(id: string, enabled: boolean): void {
  pluginEnabledStates.value = {
    ...pluginEnabledStates.value,
    [id]: enabled,
  }
}

/**
 * Returns all registered components for a given slot name,
 * filtered to only enabled plugins.
 */
export function getSlot(slot: string): Component[] {
  const result: Component[] = []
  for (const [pluginId, slots] of Object.entries(pluginSlots)) {
    if (pluginEnabledStates.value[pluginId] === false) continue
    const component = slots[slot]
    if (component) {
      result.push(component)
    }
  }
  return result
}

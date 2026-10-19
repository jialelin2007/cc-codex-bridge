// Plugins' hooks nest in the order settings enable them, first outermost.
// The bridge answers codex's mirrored tool calls itself, so only plugins
// outside it (enabled before it) see those calls: it belongs last.

/** The enabled plugins after this one, which never see codex's tool calls. */
export function pluginsAfter(enabled: Record<string, unknown>, name: string): string[] {
  const ids = Object.keys(enabled).filter(id => enabled[id] === true && !id.endsWith('@builtin'))
  const at = ids.findIndex(id => id.startsWith(`${name}@`))
  return at < 0 ? [] : ids.slice(at + 1)
}

/** settings.json text with this plugin moved last in `enabledPlugins`; undefined when nothing moves. */
export function movedLast(settingsText: string, name: string): string | undefined {
  const settings = JSON.parse(settingsText) as { enabledPlugins?: Record<string, unknown> }
  const enabled = settings.enabledPlugins
  if (!enabled || pluginsAfter(enabled, name).length === 0) return undefined
  const id = Object.keys(enabled).find(key => key.startsWith(`${name}@`))!
  const value = enabled[id]
  delete enabled[id]
  enabled[id] = value
  return JSON.stringify(settings, null, 2) + '\n'
}

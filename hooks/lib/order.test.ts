import { describe, expect, test } from 'claude-code/testing'
import { movedLast, pluginsAfter } from './order'

const enabled = {
  'helper@builtin': true,
  'codex-bridge@claude-codex-bridge': true,
  'agent-radar@claude-code-mods': true,
  'old@claude-code-mods': false,
  'mission-control@claude-code-mods': true,
}

describe('plugin order', () => {
  test('names the enabled plugins after the bridge', () => {
    expect(pluginsAfter(enabled, 'codex-bridge')).toEqual(['agent-radar@claude-code-mods', 'mission-control@claude-code-mods'])
    expect(pluginsAfter({ 'a@m': true, 'codex-bridge@x': true }, 'codex-bridge')).toEqual([])
    expect(pluginsAfter({ 'a@m': true }, 'codex-bridge')).toEqual([])
  })

  test('moves the bridge last and keeps everything else', () => {
    const text = JSON.stringify({ model: 'opus', enabledPlugins: enabled, env: { A: '1' } }, null, 2)
    const moved = JSON.parse(movedLast(text, 'codex-bridge')!)
    expect(Object.keys(moved.enabledPlugins).at(-1)).toBe('codex-bridge@claude-codex-bridge')
    expect(Object.keys(moved.enabledPlugins)).toHaveLength(5)
    expect(moved.model).toBe('opus')
    expect(moved.env).toEqual({ A: '1' })
  })

  test('leaves a bridge already last alone', () => {
    expect(movedLast(JSON.stringify({ enabledPlugins: { 'a@m': true, 'codex-bridge@x': true } }), 'codex-bridge')).toBeUndefined()
  })
})

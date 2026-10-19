import { describe, expect, test } from 'claude-code/testing'
import { mirrorCommand, mirrorPatch, parseHunks } from './mirror'

describe('parseHunks', () => {
  test('reads hunk headers and lines', () => {
    expect(parseHunks('@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n')).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' alpha', '-beta', '+BETA', ' gamma'] },
    ])
  })

  test('takes several hunks and one-line counts', () => {
    const hunks = parseHunks('@@ -2 +2 @@\n-a\n+b\n@@ -10,2 +10,3 @@\n x\n+y\n z\n')
    expect(hunks.map(h => [h.oldStart, h.oldLines, h.newStart, h.newLines])).toEqual([
      [2, 1, 2, 1],
      [10, 2, 10, 3],
    ])
  })
})

describe('mirrorCommand', () => {
  test('a command that passed is a Bash call with its output', () => {
    const call = mirrorCommand({ type: 'command', command: 'ls', output: 'a\nb\n', exitCode: 0, status: 'completed', durationMs: 3 })
    expect(call).toEqual({ name: 'Bash', input: { command: 'ls' }, answer: { result: { stdout: 'a\nb\n', stderr: '', interrupted: false } } })
  })

  test('a failed or declined command says so on stderr', () => {
    expect(mirrorCommand({ type: 'command', command: 'false', output: 'x', exitCode: 1, status: 'failed', durationMs: 0 }).answer).toEqual({
      result: { stdout: 'x', stderr: 'Exit code 1', interrupted: false },
    })
    expect(mirrorCommand({ type: 'command', command: 'rm x', output: '', exitCode: null, status: 'declined', durationMs: 0 }).answer).toEqual({
      result: { stdout: '', stderr: 'Command declined by the codex sandbox', interrupted: false },
    })
  })

  test('a failed patch is refused with codex error', () => {
    const [call] = mirrorPatch({ type: 'patch', status: 'failed', changes: [{ path: '/p/a', kind: 'add', movePath: null, diff: 'x\n' }] })
    expect(call?.answer).toEqual({ deny: "codex's patch failed" })
  })
})

describe('mirrorPatch', () => {
  test('an update is one Edit per hunk', () => {
    const [edit, ...rest] = mirrorPatch({
      type: 'patch',
      status: 'completed',
      changes: [{ path: '/p/notes.txt', kind: 'update', movePath: null, diff: '@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n' }],
    })
    expect(rest).toEqual([])
    expect(edit?.name).toBe('Edit')
    expect(edit?.input).toEqual({ file_path: '/p/notes.txt', old_string: 'alpha\nbeta\ngamma', new_string: 'alpha\nBETA\ngamma' })
    expect((edit?.answer as { result: { structuredPatch: unknown[] } }).result.structuredPatch).toHaveLength(1)
  })

  test('an added file is a Write, a deleted one a Bash rm', () => {
    const calls = mirrorPatch({
      type: 'patch',
      status: 'completed',
      changes: [
        { path: '/p/new.txt', kind: 'add', movePath: null, diff: 'hi\n' },
        { path: '/p/old.txt', kind: 'delete', movePath: null, diff: 'bye\n' },
      ],
    })
    expect(calls.map(c => c.name)).toEqual(['Write', 'Bash'])
    expect(calls[0]?.input).toEqual({ file_path: '/p/new.txt', content: 'hi\n' })
    expect(calls[1]?.input).toEqual({ command: 'rm "/p/old.txt"', description: 'Delete the file (codex apply_patch)' })
  })
})

import { describe, expect, test } from 'claude-code/testing'
import { commandInput, mirrorCommand, mirrorPatch, parseHunks } from './mirror'

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
  test('start and completion use the same Bash input', () => {
    const command = 'printf "hello\\n"'
    expect(commandInput(command)).toEqual({ command })
    expect(mirrorCommand({ type: 'command', command, output: '', exitCode: 0, status: 'completed', durationMs: 0 }).input).toEqual(commandInput(command))
  })

  test('a command that passed is a Bash call with its output', () => {
    const call = mirrorCommand({ type: 'command', command: 'ls', output: 'a\nb\n', exitCode: 0, status: 'completed', durationMs: 3 })
    expect(call).toEqual({ name: 'Bash', input: { command: 'ls' }, answer: { result: { stdout: 'a\nb\n', stderr: '', interrupted: false } } })
  })

  for (const [status, exitCode, text] of [
    ['failed', 1, 'Exit code 1'],
    ['completed', 2, 'Exit code 2'],
    ['failed', null, 'Command failed'],
    ['failed', 0, 'Exit code 0'],
    ['declined', null, 'Command declined by the codex sandbox'],
    ['declined', 1, 'Command declined by the codex sandbox'],
  ] as const) {
    for (const output of ['', 'details\n']) {
      test(`${status} with exit code ${exitCode} and ${output ? 'output' : 'no output'} is refused`, () => {
        expect(mirrorCommand({ type: 'command', command: 'cmd', output, exitCode, status, durationMs: 0 }).answer).toEqual({
          deny: text + (output ? `\n${output}` : ''),
        })
      })
    }
  }
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
    expect(calls[1]?.input).toEqual({ command: 'rm "/p/old.txt"', description: 'Delete /p/old.txt (codex apply_patch)' })
    expect(calls[1]?.answer).toEqual({ result: { stdout: '', stderr: '', interrupted: false } })
  })

  test('a moved file names both paths and follows its edits', () => {
    const calls = mirrorPatch({
      type: 'patch',
      status: 'completed',
      changes: [{ path: '/p/old name.txt', kind: 'update', movePath: '/p/new name.txt', diff: '@@ -1 +1 @@\n-old\n+new\n' }],
    })
    expect(calls.map(c => c.name)).toEqual(['Edit', 'Bash'])
    expect(calls[1]).toEqual({
      name: 'Bash',
      input: { command: 'mv "/p/old name.txt" "/p/new name.txt"', description: 'Move /p/old name.txt to /p/new name.txt (codex apply_patch)' },
      answer: { result: { stdout: '', stderr: '', interrupted: false } },
    })
  })

  for (const status of ['failed', 'declined']) {
    test(`a ${status} patch refuses its writes, deletions, edits and moves`, () => {
      const calls = mirrorPatch({
        type: 'patch',
        status,
        changes: [
          { path: '/p/new.txt', kind: 'add', movePath: null, diff: 'hi\n' },
          { path: '/p/old.txt', kind: 'delete', movePath: null, diff: 'bye\n' },
          { path: '/p/a', kind: 'update', movePath: '/p/b', diff: '@@ -1 +1 @@\n-old\n+new\n' },
        ],
      })
      expect(calls.map(c => c.name)).toEqual(['Write', 'Bash', 'Edit', 'Bash'])
      expect(calls.map(c => c.answer)).toEqual(Array.from({ length: 4 }, () => ({ deny: `codex's patch ${status}` })))
    })
  }
})

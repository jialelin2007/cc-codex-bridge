// How codex's work shows in its Claude agent's transcript: each command and
// file change as the Claude tool call that does the same (Bash, Edit, Write),
// answered with what codex got; codex's messages and notes as the agent's text.

export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

/**
 * A tool call the bridge answers itself, with codex's outcome: the tool's own
 * result shape, or a refusal carrying codex's error.
 */
export type MirroredCall = {
  name: 'Bash' | 'Edit' | 'Write'
  input: Record<string, unknown>
  answer: { result: unknown } | { deny: string }
}

export type CommandEvent = {
  type: 'command'
  command: string
  output: string
  exitCode: number | null
  status: string
  durationMs: number | null
}

export type PatchEvent = {
  type: 'patch'
  status: string
  changes: readonly { path: string; kind: string; movePath: string | null; diff: string }[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** The hunks of a unified diff body, as Edit and Write record them. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | undefined
  for (const line of diff.split('\n')) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      }
      hunks.push(current)
    } else if (current && /^[ +\-\\]/.test(line)) {
      current.lines.push(line)
    }
  }
  return hunks
}

const side = (hunk: Hunk, keep: '-' | '+') =>
  hunk.lines
    .filter(line => line[0] === ' ' || line[0] === keep)
    .map(line => line.slice(1))
    .join('\n')

export function commandInput(command: string) {
  return { command }
}

export function mirrorCommand(event: CommandEvent): MirroredCall {
  const input = commandInput(event.command)
  const failed = event.status === 'declined' || event.status === 'failed' || (event.exitCode !== null && event.exitCode !== 0)
  if (failed) {
    const text = event.status === 'declined' ? 'Command declined by the codex sandbox' : event.exitCode === null ? 'Command failed' : `Exit code ${event.exitCode}`
    return { name: 'Bash', input, answer: { deny: text + (event.output ? `\n${event.output}` : '') } }
  }
  return { name: 'Bash', input, answer: { result: { stdout: event.output, stderr: '', interrupted: false } } }
}

/** One call per hunk of an update, a Write per added file, a Bash `rm` per deleted one. */
export function mirrorPatch(event: PatchEvent): MirroredCall[] {
  const failure = event.status === 'failed' || event.status === 'declined' ? { deny: `codex's patch ${event.status}` } : undefined
  return event.changes.flatMap((change): MirroredCall[] => {
    if (change.kind === 'add') {
      const input = { file_path: change.path, content: change.diff }
      const result = { type: 'create', filePath: change.path, content: change.diff, structuredPatch: [], originalFile: null }
      return [{ name: 'Write', input, answer: failure ?? { result } }]
    }
    if (change.kind === 'delete') {
      const input = { command: `rm ${JSON.stringify(change.path)}`, description: `Delete ${change.path} (codex apply_patch)` }
      return [{ name: 'Bash', input, answer: failure ?? { result: { stdout: '', stderr: '', interrupted: false } } }]
    }
    const hunks = parseHunks(change.diff)
    const calls = hunks.map((hunk): MirroredCall => {
      const input = { file_path: change.path, old_string: side(hunk, '-'), new_string: side(hunk, '+') }
      const result = {
        filePath: change.path,
        oldString: input.old_string,
        newString: input.new_string,
        originalFile: null,
        structuredPatch: [hunk],
        userModified: false,
        replaceAll: false,
      }
      return { name: 'Edit', input, answer: failure ?? { result } }
    })
    if (change.movePath) {
      const input = { command: `mv ${JSON.stringify(change.path)} ${JSON.stringify(change.movePath)}`, description: `Move ${change.path} to ${change.movePath} (codex apply_patch)` }
      calls.push({ name: 'Bash', input, answer: failure ?? { result: { stdout: '', stderr: '', interrupted: false } } })
    }
    return calls
  })
}

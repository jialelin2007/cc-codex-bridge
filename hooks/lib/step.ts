// What a codex agent's next model step should be, read off its transcript,
// and the report it hands back.

export const HANDBACK = 'SubagentHandback'

/** The rows `$.session.messages({ agentId })` returns, as far as they matter here. */
export type Row = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool_use_id: string; tool: string; input: Record<string, unknown>; text?: string }[]
  toolResults?: readonly { tool_use_id: string; text: string }[]
}

export type StepPlan =
  | { kind: 'run'; input: string }
  | { kind: 'handback'; report: string }
  | { kind: 'text'; text: string }

// Rows the engine writes itself, which are no instruction for codex.
const ENGINE_NOTE = /^\s*\[(?:handback-[a-z-]+|Request interrupted[^\]]*)\]/

export function lastReport(rows: readonly Row[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const use = rows[i]!.toolUses.find(u => u.tool === HANDBACK)
    if (use && typeof use.input.message === 'string') return use.input.message
  }
  return undefined
}

/**
 * New instructions since the agent last spoke run codex; an engine nudge
 * gets the last report again; anything else ends the turn quietly.
 */
export function planStep(rows: readonly Row[], knownReport?: string): StepPlan {
  let last = rows.length - 1
  while (last >= 0 && rows[last]!.role !== 'assistant') last--
  const fresh = rows.slice(last + 1).filter(r => r.role === 'user' && r.text.trim() !== '')
  const instructions = fresh.filter(r => !ENGINE_NOTE.test(r.text)).map(r => r.text.trim())
  if (instructions.length > 0) return { kind: 'run', input: instructions.join('\n\n') }

  const report = knownReport ?? lastReport(rows) ?? ''
  const handback = last >= 0 ? rows[last]!.toolUses.find(u => u.tool === HANDBACK) : undefined
  if (handback) {
    const answer =
      handback.text ??
      rows
        .slice(last + 1)
        .flatMap(r => r.toolResults ?? [])
        .find(t => t.tool_use_id === handback.tool_use_id)?.text ??
      ''
    // Hand-back is off for this agent: its plain text is the report.
    if (/not active/.test(answer)) return { kind: 'text', text: report }
    if (fresh.length > 0) return { kind: 'handback', report }
    return { kind: 'text', text: '' }
  }
  if (fresh.length > 0 && report) return { kind: 'handback', report }
  return { kind: 'text', text: report }
}

export type ThreadEvent = {
  threadId: string
  name: string | null
  resumed: boolean
  path: string | null
  model: string
  effort: string | null
  serviceTier: string | null
  sandbox: string | null
  approvalPolicy: string | null
  approvalsReviewer: string | null
}

export type Usage = { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number }

export type FinalEvent = {
  status: 'completed' | 'interrupted' | 'failed' | string
  text: string
  error: string | null
  usage: Usage | null
  lastUsage: Usage | null
}

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n))

/** One line naming the codex session, so Claude can find it again or read its rollout. */
export function threadLine(thread: ThreadEvent, usage: Usage | null): string {
  const parts = [`codex session ${thread.name ?? '(unnamed)'}`, `thread ${thread.threadId}`]
  parts.push([thread.model, thread.effort].filter(Boolean).join('/'))
  if (thread.serviceTier === 'priority') parts.push('fast')
  if (thread.sandbox) parts.push(`sandbox ${thread.sandbox}`)
  if (usage) {
    parts.push(
      `session tokens ${tokens(usage.inputTokens)} in (${tokens(usage.cachedInputTokens)} cached) / ${tokens(usage.outputTokens)} out`,
    )
  }
  if (thread.path) parts.push(`rollout ${thread.path}`)
  return `[codex-bridge] ${parts.join(' · ')}`
}

export function formatReport(final: FinalEvent, thread: ThreadEvent | undefined): string {
  const body = final.text.trim()
  let report: string
  if (final.status === 'completed') report = body || '(codex finished without a final message)'
  else if (final.status === 'interrupted') report = `⚠ The codex turn was interrupted.${body ? `\n\nLast message:\n${body}` : ''}`
  else report = `⚠ The codex turn failed: ${final.error ?? final.status}${body ? `\n\nLast message:\n${body}` : ''}`
  return thread ? `${report}\n\n${threadLine(thread, final.usage)}` : report
}

/** The thread id a report's `[codex-bridge]` line names, for a run that lost its state. */
export function threadIdFromReport(report: string | undefined): string | undefined {
  return report?.match(/\[codex-bridge\][^\n]*\bthread ([0-9a-f-]{36})/)?.[1]
}

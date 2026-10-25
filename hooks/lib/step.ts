// What a codex agent's next model step should be, read off its transcript,
// and the report it hands back.

export const HANDBACK = 'SubagentHandback'

/** The rows `$.session.messages({ agentId })` returns, as far as they matter here. */
export type Row = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool_use_id: string; tool: string; input: Record<string, unknown>; text?: string; isError?: true }[]
  toolResults?: readonly { tool_use_id: string; text: string }[]
}

/** The same conversation as the next request carries it (`as: 'api'`): reminders included. */
export type ApiMessage = { role: 'user' | 'assistant'; content: readonly { type: string; text?: string }[] }

export type StepPlan =
  | { kind: 'run'; input: string }
  | { kind: 'deliver'; report: string }
  | { kind: 'text'; text: string }

// Rows the engine writes itself, which are no instruction for codex.
const ENGINE_NOTE = /^\s*\[(?:handback-[a-z-]+|Request interrupted[^\]]*)\]/
// How a message sent to a busy agent reaches it: as a row, or as a reminder.
const RELAYED = /The coordinator sent a message while you were working:\n([\s\S]*?)\n\nAddress this before completing your current task\./

const lastAssistant = (messages: readonly { role: string }[]) => {
  let at = messages.length - 1
  while (at >= 0 && messages[at]!.role !== 'assistant') at--
  return at
}

/** True when the engine told this agent to report through SubagentHandback. */
export function handbackActive(api: readonly ApiMessage[]): boolean {
  return api.some(m => m.role === 'user' && m.content.some(b => b.type === 'text' && b.text?.includes(`${HANDBACK}(`)))
}

export function lastReport(rows: readonly Row[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const use = rows[i]!.toolUses.find(u => u.tool === HANDBACK)
    if (use && typeof use.input.message === 'string') return use.input.message
    if (rows[i]!.role === 'assistant' && rows[i]!.text.includes('[cc-codex-bridge]')) return rows[i]!.text
  }
  return undefined
}

/** What Claude asked since the agent last answered: new rows, and messages relayed as reminders. */
export function newInstructions(rows: readonly Row[], api: readonly ApiMessage[]): string[] {
  const fromRows = rows
    .slice(lastAssistant(rows) + 1)
    .filter(r => r.role === 'user' && r.text.trim() !== '' && !ENGINE_NOTE.test(r.text))
    .map(r => RELAYED.exec(r.text)?.[1] ?? r.text)
  const fromReminders = api
    .slice(lastAssistant(api) + 1)
    .flatMap(m => m.content)
    .flatMap(b => (b.type === 'text' && b.text?.trimStart().startsWith('<system-reminder') ? [RELAYED.exec(b.text)?.[1]] : []))
    .filter((text): text is string => text !== undefined)
  return [...new Set([...fromRows, ...fromReminders].map(text => text.trim()).filter(Boolean))]
}

/**
 * New instructions since the agent last answered run codex; an engine nudge
 * gets the last report again; anything else ends the turn quietly.
 */
export function planStep(rows: readonly Row[], api: readonly ApiMessage[], knownReport?: string): StepPlan {
  const instructions = newInstructions(rows, api)
  if (instructions.length > 0) return { kind: 'run', input: instructions.join('\n\n') }

  const last = lastAssistant(rows)
  const report = knownReport ?? lastReport(rows) ?? ''
  const nudged = rows.slice(last + 1).some(r => r.role === 'user' && ENGINE_NOTE.test(r.text))
  const handback = last >= 0 ? rows[last]!.toolUses.find(u => u.tool === HANDBACK) : undefined
  if (handback) {
    const answer =
      handback.text ??
      rows
        .slice(last + 1)
        .flatMap(r => r.toolResults ?? [])
        .find(t => t.tool_use_id === handback.tool_use_id)?.text ??
      ''
    // No hand-back for this agent after all: its plain text is the report.
    if (/not active|No such tool/.test(answer)) return { kind: 'text', text: report }
    if (nudged) return { kind: 'deliver', report }
    return { kind: 'text', text: '' }
  }
  if (nudged && report) return { kind: 'deliver', report }
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
  return `[cc-codex-bridge] ${parts.join(' · ')}`
}

export function formatReport(final: FinalEvent, thread: ThreadEvent | undefined): string {
  const body = final.text.trim()
  let report: string
  if (final.status === 'completed') report = body || '(codex finished without a final message)'
  else if (final.status === 'interrupted') report = `⚠ The codex turn was interrupted.${body ? `\n\nLast message:\n${body}` : ''}`
  else report = `⚠ The codex turn failed: ${final.error ?? final.status}${body ? `\n\nLast message:\n${body}` : ''}`
  return thread ? `${report}\n\n${threadLine(thread, final.usage)}` : report
}

/** The thread id a report's `[cc-codex-bridge]` line names, for a run that lost its state. */
export function threadIdFromReport(report: string | undefined): string | undefined {
  return report?.match(/\[cc-codex-bridge\][^\n]*\bthread ([0-9a-f-]{36})/)?.[1]
}

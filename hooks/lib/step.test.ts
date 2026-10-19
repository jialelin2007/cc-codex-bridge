import { describe, expect, test } from 'claude-code/testing'
import { formatReport, HANDBACK, planStep, type Row, threadIdFromReport } from './step'

const user = (text: string, toolResults?: Row['toolResults']): Row => ({ role: 'user', text, toolUses: [], toolResults })
const handback = (message: string, answer?: string): Row => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: 'toolu_1', tool: HANDBACK, input: { message }, text: answer }],
})
const delivered = '{"success":true,"message":"Report delivered to your caller."}'

describe('planStep', () => {
  test('a fresh agent runs its prompt', () => {
    expect(planStep([user('Fix the bug.')])).toEqual({ kind: 'run', input: 'Fix the bug.' })
  })

  test('a message after the report runs again, the tool result aside', () => {
    const rows = [user('Fix the bug.'), handback('Fixed.', delivered), user('', []), user('Now add a test.')]
    expect(planStep(rows)).toEqual({ kind: 'run', input: 'Now add a test.' })
  })

  test('several queued messages run together', () => {
    const rows = [user('Task.'), handback('Done.', delivered), user('One.'), user('Two.')]
    expect(planStep(rows)).toEqual({ kind: 'run', input: 'One.\n\nTwo.' })
  })

  test('an engine nudge gets the last report again', () => {
    const rows = [user('Task.'), { role: 'assistant', text: 'Report delivered.', toolUses: [] } as Row, user('[handback-send-enforce] Your report has not been delivered.')]
    expect(planStep(rows, 'The report.')).toEqual({ kind: 'handback', report: 'The report.' })
  })

  test('a hand-back that is not active turns into plain text', () => {
    const rows = [user('Task.'), handback('The report.', 'Nothing was sent: SubagentHandback is not active for this agent.')]
    expect(planStep(rows)).toEqual({ kind: 'text', text: 'The report.' })
  })

  test('a delivered report ends quietly', () => {
    expect(planStep([user('Task.'), handback('The report.', delivered)])).toEqual({ kind: 'text', text: '' })
  })
})

describe('reports', () => {
  const thread = {
    threadId: '01a153cd-1033-7570-ba49-24edd74a18dd',
    name: 'claude-subagent-auth-fix',
    resumed: false,
    path: '/home/u/.codex/sessions/rollout.jsonl',
    model: 'gpt-6-astra',
    effort: 'high',
    serviceTier: 'priority',
    sandbox: 'workspaceWrite',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
  }
  const usage = { inputTokens: 41410, cachedInputTokens: 20480, outputTokens: 53, reasoningOutputTokens: 0 }

  test('carry a line naming the codex session', () => {
    const report = formatReport({ status: 'completed', text: 'All done.', error: null, usage, lastUsage: null }, thread)
    expect(report).toContain('All done.')
    expect(report).toContain('[codex-bridge] codex session claude-subagent-auth-fix')
    expect(report).toContain('gpt-6-astra/high · fast')
    expect(threadIdFromReport(report)).toBe(thread.threadId)
  })

  test('say when the turn failed or was interrupted', () => {
    expect(formatReport({ status: 'failed', text: '', error: 'rate limited', usage: null, lastUsage: null }, undefined)).toBe(
      '⚠ The codex turn failed: rate limited',
    )
    expect(formatReport({ status: 'interrupted', text: 'half', error: null, usage: null, lastUsage: null }, undefined)).toContain(
      'interrupted',
    )
  })
})

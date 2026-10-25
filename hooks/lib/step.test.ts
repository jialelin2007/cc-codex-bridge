import { describe, expect, test } from 'claude-code/testing'
import { type ApiMessage, formatReport, HANDBACK, handbackActive, planStep, type Row, threadIdFromReport } from './step'

const user = (text: string, toolResults?: Row['toolResults']): Row => ({ role: 'user', text, toolUses: [], toolResults })
const said = (text: string): Row => ({ role: 'assistant', text, toolUses: [] })
const handback = (message: string, answer?: string): Row => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: 'toolu_1', tool: HANDBACK, input: { message }, text: answer }],
})
const delivered = '{"success":true,"message":"Report delivered to your caller."}'
const api = (...messages: [ApiMessage['role'], ...string[]][]): ApiMessage[] =>
  messages.map(([role, ...texts]) => ({ role, content: texts.map(text => ({ type: 'text', text })) }))
const relayed = (message: string) =>
  `The coordinator sent a message while you were working:\n${message}\n\nAddress this before completing your current task.`

describe('planStep', () => {
  test('a fresh agent runs its prompt, its reminders aside', () => {
    const messages = api(['user', '<system-reminder>\n# Environment\n</system-reminder>', 'Fix the bug.'])
    expect(planStep([user('Fix the bug.')], messages)).toEqual({ kind: 'run', input: 'Fix the bug.' })
  })

  test('a message after the report runs again, the tool result aside', () => {
    const rows = [user('Fix the bug.'), handback('Fixed.', delivered), user('', []), user('Now add a test.')]
    expect(planStep(rows, [])).toEqual({ kind: 'run', input: 'Now add a test.' })
  })

  test('a message relayed as a row is unwrapped', () => {
    const rows = [user('Task.'), said('Done.'), user(relayed('One more thing.'))]
    expect(planStep(rows, [])).toEqual({ kind: 'run', input: 'One more thing.' })
  })

  test('a message relayed as a reminder is picked up once', () => {
    const rows = [user('Task.'), said('Done.')]
    const reminder = `<system-reminder id="x">\n${relayed('Add a docstring.')}\n</system-reminder id="x">`
    const messages = api(['user', 'Task.'], ['assistant', 'Done.'], ['user', reminder, relayed('Add a docstring.')])
    expect(planStep(rows, messages)).toEqual({ kind: 'run', input: 'Add a docstring.' })
  })

  test('a reminder from before the last answer is not new', () => {
    const reminder = `<system-reminder>\n${relayed('Old.')}\n</system-reminder>`
    const messages = api(['user', 'Task.', reminder], ['assistant', 'Done.'])
    expect(planStep([user('Task.'), said('Done.')], messages, 'Done.')).toEqual({ kind: 'text', text: 'Done.' })
  })

  test('an engine nudge gets the last report again', () => {
    const rows = [user('Task.'), said('Report delivered.'), user('[handback-send-enforce] Your report has not been delivered.')]
    expect(planStep(rows, [], 'The report.')).toEqual({ kind: 'deliver', report: 'The report.' })
  })

  test('a refused hand-back turns into plain text', () => {
    const missing = '<tool_use_error>Error: No such tool available: SubagentHandback</tool_use_error>'
    expect(planStep([user('Task.'), handback('The report.', missing)], [])).toEqual({ kind: 'text', text: 'The report.' })
    const inactive = 'Nothing was sent: SubagentHandback is not active for this agent.'
    expect(planStep([user('Task.'), handback('The report.', inactive)], [])).toEqual({ kind: 'text', text: 'The report.' })
  })

  test('a delivered report ends quietly', () => {
    expect(planStep([user('Task.'), handback('The report.', delivered)], [])).toEqual({ kind: 'text', text: '' })
  })
})

describe('handbackActive', () => {
  test('reads the engine reminder', () => {
    const reminder = '<system-reminder>\nYour final report is delivered through SubagentHandback: call SubagentHandback({message: <your full report>}).\n</system-reminder>'
    expect(handbackActive(api(['user', reminder, 'Task.']))).toBe(true)
    expect(handbackActive(api(['user', 'Task.']))).toBe(false)
  })
})

describe('reports', () => {
  const thread = {
    threadId: '01900000-0000-7000-8000-000000000001',
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

import { describe, expect, test } from 'claude-code/testing'
import { followClaude, parseDirective, resolveSettings, sessionName, slug } from './policy'

describe('parseDirective', () => {
  test('reads and strips a leading @codex line', () => {
    const { directive, body } = parseDirective('@codex model=gpt-6-astra name=auth-fix effort=high fast=on new\nFix the login timeout.')
    expect(directive).toEqual({ model: 'gpt-6-astra', name: 'auth-fix', effort: 'high', fast: true, fresh: true })
    expect(body).toBe('Fix the login timeout.')
  })

  test('leaves a prompt without a directive alone', () => {
    const { directive, body } = parseDirective('Please look at @codex usage in docs.')
    expect(directive).toEqual({})
    expect(body).toBe('Please look at @codex usage in docs.')
  })

  test('ignores unknown keys and invalid values', () => {
    const { directive } = parseDirective('@codex effort=extreme sandbox=root color=blue fast=maybe\nx')
    expect(directive).toEqual({})
  })

  test('accepts ultra and read-only', () => {
    const { directive } = parseDirective('  @codex effort=ultra sandbox=read-only\nx')
    expect(directive).toEqual({ effort: 'ultra', sandbox: 'read-only' })
  })
})

describe('session names', () => {
  test('slugs keep letters of any script', () => {
    expect(slug('修复 登录超时!')).toBe('修复-登录超时')
    expect(slug('  Run the Tests  ')).toBe('run-the-tests')
  })

  test('always carry the prefix once', () => {
    expect(sessionName('auth-fix')).toBe('claude-subagent-auth-fix')
    expect(sessionName('claude-subagent-auth-fix')).toBe('claude-subagent-auth-fix')
    expect(sessionName('***')).toBe('claude-subagent-agent')
  })
})

describe('resolveSettings', () => {
  const inherit = { fast: 'inherit', model: '', effort: 'inherit', sandbox: 'inherit', approval: 'inherit' }

  test('inherits everything from codex when the options say so', () => {
    expect(resolveSettings({ options: inherit, directive: {} })).toEqual({})
  })

  test('the directive outranks the Agent effort, which outranks the options', () => {
    const options = { ...inherit, model: 'gpt-6-luna', effort: 'low' }
    expect(resolveSettings({ options, directive: { effort: 'max' }, agentEffort: 'high' })).toEqual({
      defaultModel: 'gpt-6-luna',
      defaultEffort: 'low',
      effort: 'max',
    })
    expect(resolveSettings({ options, directive: {}, agentEffort: 'high' }).effort).toBe('high')
    expect(resolveSettings({ options, directive: { model: 'gpt-6-sol' } }).model).toBe('gpt-6-sol')
  })

  test('lower and higher step from the default', () => {
    expect(resolveSettings({ options: inherit, directive: {}, agentEffort: 'lower' }).effortStep).toBe(-1)
    expect(resolveSettings({ options: inherit, directive: {}, agentEffort: 'higher' }).effortStep).toBe(1)
  })

  test('fast maps to service tiers', () => {
    expect(resolveSettings({ options: { ...inherit, fast: 'on' }, directive: {} }).serviceTier).toBe('priority')
    expect(resolveSettings({ options: { ...inherit, fast: 'on' }, directive: { fast: false } }).serviceTier).toBe('default')
  })

  test('sandbox and approvals follow Claude by default', () => {
    expect(resolveSettings({ options: {}, directive: {}, permissionMode: 'plan' })).toEqual(followClaude('plan'))
    expect(resolveSettings({ options: {}, directive: {}, permissionMode: 'auto' })).toEqual({
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    })
    expect(resolveSettings({ options: {}, directive: {}, permissionMode: 'bypassPermissions' }).sandbox).toBe(
      'danger-full-access',
    )
    expect(resolveSettings({ options: {}, directive: {}, permissionMode: 'default' }).sandbox).toBe('workspace-write')
  })

  test('the directive can tighten the sandbox but never widen it', () => {
    const options = { sandbox: 'workspace-write', approval: 'never' }
    expect(resolveSettings({ options, directive: { sandbox: 'read-only' } }).sandbox).toBe('read-only')
    expect(resolveSettings({ options, directive: { sandbox: 'danger-full-access' } }).sandbox).toBe('workspace-write')
    expect(resolveSettings({ options: inherit, directive: { sandbox: 'workspace-write' } }).sandbox).toBeUndefined()
    expect(resolveSettings({ options: inherit, directive: { sandbox: 'read-only' } }).sandbox).toBe('read-only')
  })
})

// Pure rules of the bridge: the `@codex` directive, session names, and how
// the plugin's options, the directive, the Agent call and Claude's
// permission mode turn into the settings of a codex run.

export const AGENT_NAME = 'codex'
export const NAME_PREFIX = 'claude-subagent-'
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export type Effort = (typeof EFFORTS)[number]
export type Sandbox = 'read-only' | 'workspace-write' | 'danger-full-access'

export type Directive = {
  model?: string
  name?: string
  effort?: Effort
  fast?: boolean
  sandbox?: Sandbox
  /** `new`: start a fresh codex session even when the name is taken. */
  fresh?: boolean
}

export type Options = {
  fast?: string
  model?: string
  effort?: string
  sandbox?: string
  approval?: string
  codexPath?: string
}

/**
 * What the helper's `run` op takes beyond the prompt, cwd and thread.
 * `model` and `effort` are Claude's own choice and apply to every run;
 * `defaultModel` and `defaultEffort` come from the options and apply only
 * when a new codex session starts, so a resumed one keeps its own.
 */
export type RunSettings = {
  model?: string
  defaultModel?: string
  effort?: Effort
  effortStep?: -1 | 1
  defaultEffort?: Effort
  serviceTier?: 'priority' | 'default'
  sandbox?: Sandbox
  approvalPolicy?: 'never' | 'on-request'
  approvalsReviewer?: 'user' | 'auto_review'
}

const SANDBOXES: readonly string[] = ['read-only', 'workspace-write', 'danger-full-access']
const DIRECTIVE = /^\s*@codex\b([^\n]*)(?:\n|$)/

/** Reads a leading `@codex key=value ...` line off a prompt. */
export function parseDirective(text: string): { directive: Directive; body: string } {
  const match = DIRECTIVE.exec(text)
  if (!match) return { directive: {}, body: text }
  const directive: Directive = {}
  for (const token of (match[1] ?? '').trim().split(/\s+/).filter(Boolean)) {
    const [rawKey = '', ...rest] = token.split('=')
    const key = rawKey.toLowerCase()
    const value = rest.join('=')
    if (key === 'new' && value === '') directive.fresh = true
    else if (key === 'model' && value) directive.model = value
    else if (key === 'name' && value) directive.name = value
    else if (key === 'effort' && (EFFORTS as readonly string[]).includes(value)) directive.effort = value as Effort
    else if (key === 'fast' && /^(on|off|true|false)$/.test(value)) directive.fast = value === 'on' || value === 'true'
    else if (key === 'sandbox' && SANDBOXES.includes(value)) directive.sandbox = value as Sandbox
  }
  return { directive, body: text.slice(match[0].length).replace(/^\s*\n/, '') }
}

/** A session-name slug: letters (any script), digits, `-` and `_`; at most 48. */
export function slug(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
    .replace(/-$/, '')
}

/** The codex session name, always `claude-subagent-<name>`. */
export function sessionName(name: string): string {
  const bare = name.startsWith(NAME_PREFIX) ? name.slice(NAME_PREFIX.length) : name
  return NAME_PREFIX + (slug(bare) || 'agent')
}

const isSet = (value: string | undefined) => value !== undefined && value !== '' && value !== 'inherit'

/** Sandbox and approval that follow Claude's permission mode, as a subagent's do. */
export function followClaude(permissionMode: string | undefined): Pick<RunSettings, 'sandbox' | 'approvalPolicy' | 'approvalsReviewer'> {
  switch (permissionMode) {
    case 'plan':
      return { sandbox: 'read-only', approvalPolicy: 'never' }
    case 'auto':
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' }
    case 'bypassPermissions':
      return { sandbox: 'danger-full-access', approvalPolicy: 'never' }
    default:
      return { sandbox: 'workspace-write', approvalPolicy: 'never' }
  }
}

/**
 * The settings of a codex run. A directive outranks the Agent call's own
 * `effort`, which outranks the plugin's options; anything left unset is
 * omitted, so codex's own config.toml decides it.
 */
export function resolveSettings(input: {
  options: Options
  directive: Directive
  agentEffort?: string
  permissionMode?: string
}): RunSettings {
  const { options, directive, agentEffort, permissionMode } = input
  const settings: RunSettings = {}

  if (directive.model) settings.model = directive.model
  else if (isSet(options.model)) settings.defaultModel = options.model!.trim()

  // "lower" and "higher" step from the default: the options', else codex's.
  if (isSet(options.effort) && (EFFORTS as readonly string[]).includes(options.effort!)) {
    settings.defaultEffort = options.effort as Effort
  }
  if (directive.effort) settings.effort = directive.effort
  else if (agentEffort === 'lower') settings.effortStep = -1
  else if (agentEffort === 'higher') settings.effortStep = 1
  else if (agentEffort && (EFFORTS as readonly string[]).includes(agentEffort)) settings.effort = agentEffort as Effort

  const fast = directive.fast ?? (options.fast === 'on' ? true : options.fast === 'off' ? false : undefined)
  if (fast !== undefined) settings.serviceTier = fast ? 'priority' : 'default'

  const followed = followClaude(permissionMode)
  const sandboxOption = options.sandbox ?? 'follow-claude'
  if (sandboxOption === 'follow-claude') settings.sandbox = followed.sandbox
  else if (SANDBOXES.includes(sandboxOption)) settings.sandbox = sandboxOption as Sandbox
  // The directive may only tighten the sandbox the user's settings allow.
  const ceiling = settings.sandbox ? SANDBOXES.indexOf(settings.sandbox) : 0
  if (directive.sandbox && SANDBOXES.indexOf(directive.sandbox) <= ceiling) settings.sandbox = directive.sandbox

  const approvalOption = options.approval ?? 'follow-claude'
  if (approvalOption === 'follow-claude') {
    settings.approvalPolicy = followed.approvalPolicy
    if (followed.approvalsReviewer) settings.approvalsReviewer = followed.approvalsReviewer
  } else if (approvalOption === 'never') {
    settings.approvalPolicy = 'never'
  } else if (approvalOption === 'auto-review') {
    settings.approvalPolicy = 'on-request'
    settings.approvalsReviewer = 'auto_review'
  }
  return settings
}

/** What codex is told about its place, on a new session only. */
export function roleInstructions(): string {
  return [
    'You are running as a subagent of Claude (Claude Code), the lead agent.',
    'Claude delegated the task in the user message to you and will read only your final message, so make it a self-contained report:',
    'what you did, what changed (files), how you verified it, and anything left open or uncertain.',
    'Messages that arrive while you work come from Claude: fold them into the task.',
    'Nobody can answer approval prompts or questions mid-task; decide for yourself and say what you assumed.',
  ].join(' ')
}

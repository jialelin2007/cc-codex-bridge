import type { EngineInterface, Register } from 'claude-code'
import {
  AGENT_NAME,
  NAME_PREFIX,
  type Options,
  parseDirective,
  resolveSettings,
  roleInstructions,
  sessionName,
  slug,
} from './lib/policy'
import {
  type ApiMessage,
  type FinalEvent,
  formatReport,
  HANDBACK,
  handbackActive,
  lastReport,
  planStep,
  type Row,
  type ThreadEvent,
  threadIdFromReport,
} from './lib/step'

type $ = EngineInterface

// What a codex agent carries between its turns. `socket` is set while a
// codex turn runs and reaches it (POST /steer).
type AgentState = { threadId?: string; sessionName?: string; report?: string; socket?: string }

// What the Agent call said that its loop does not: kept from `agent.spawn`.
type SpawnFacts = { description: string; permissionMode?: string; cwd?: string; effort?: string }

const HELPER = 'bin/codex-agent.mjs'

// If the bridge ever fails to answer a step, this is what the stand-in model reads.
const FALLBACK_PROMPT =
  'You stand in for an OpenAI Codex agent served by the codex-bridge plugin, which failed to take over this turn. ' +
  'Do no work. Your whole report is: "codex-bridge error: the Codex bridge did not handle this turn; check that the plugin is loaded and that node and codex are on PATH."'

const states = new Map<string, AgentState>()
const spawns = new Map<string, SpawnFacts>()
const spawnWaiters = new Map<string, () => void>()
const agentEfforts = new Map<string, string | undefined>()
const otherAgents = new Set<string>()

function describeAgent(options: Options): string {
  const show = (value: string | undefined, fallback: string) => (value && value !== 'inherit' ? value : fallback)
  return [
    'Delegates a task to OpenAI Codex: a separate coding agent working in this same project directory with its own tools, sandbox and context, which returns one self-contained report.',
    'Use it as any subagent: give a complete brief; SendMessage reaches the running codex turn at once, or continues the session once it finished; TaskStop interrupts it.',
    'Optional first line of the prompt: `@codex model=<codex model> name=<name> effort=<low|medium|high|xhigh|max|ultra> fast=<on|off> sandbox=<read-only|workspace-write> new`, each key optional.',
    `The codex session is named ${NAME_PREFIX}<name> (from \`name\`, else from the description); a \`name\` that already exists in this project resumes that codex session with its context, and \`new\` starts a fresh one.`,
    "The Agent tool's `effort` sets codex's reasoning effort; its `model` is ignored.",
    `Defaults: model ${show(options.model, "codex's own")}, effort ${show(options.effort, "codex's own")}, fast ${show(options.fast, "codex's own")}, sandbox ${show(options.sandbox, 'follow-claude')}.`,
  ].join(' ')
}

const isCodexType = ($: $, type: string | undefined) => type === `${$.plugin.name}:${AGENT_NAME}`

async function codexAgent($: $, agentId: string): Promise<{ description: string } | undefined> {
  const spawned = spawns.get(agentId)
  if (spawned) return { description: spawned.description }
  if (otherAgents.has(agentId)) return undefined
  const info = (await $.agent.list()).find(a => a.id === agentId)
  if (!info || !isCodexType($, info.type)) {
    if (info) otherAgents.add(agentId)
    return undefined
  }
  return { description: info.description }
}

// The first step of a fresh agent can run before its `agent.spawn` hook has
// heard the agent's id: give that hook a moment.
async function spawnFacts($: $, agentId: string, description: string): Promise<SpawnFacts> {
  if (!spawns.has(agentId)) {
    await Promise.race([new Promise<void>(r => spawnWaiters.set(agentId, r)), $.clock.sleep(3000)])
    spawnWaiters.delete(agentId)
  }
  return spawns.get(agentId) ?? { description }
}

async function loadState($: $, agentId: string, rows: readonly Row[]): Promise<AgentState> {
  let state = states.get(agentId)
  if (!state) {
    const stored = (await $.store.get(`agent:${agentId}`)) as AgentState | undefined
    const report = stored?.report ?? lastReport(rows)
    state = { ...stored, report, threadId: stored?.threadId ?? threadIdFromReport(report) }
    states.set(agentId, state)
  }
  return state
}

async function saveState($: $, agentId: string, state: AgentState) {
  const { threadId, sessionName: name, report } = state
  await $.store.set(`agent:${agentId}`, { threadId, sessionName: name, report })
}

async function notice($: $, agentId: string, text: string) {
  await $.session
    .append({ message: { type: 'system', content: [{ type: 'text', text }] }, agentId })
    .catch(() => undefined)
}

async function controlSocket($: $, agentId: string): Promise<string> {
  const runtime = (await $.env.get('XDG_RUNTIME_DIR')) || '/tmp'
  return `${runtime}/codex-bridge/${agentId}.sock`
}

function helperArgv($: $): string[] {
  return ['node', `${$.plugin.root}/${HELPER}`]
}

/** Runs one codex turn for the agent and returns the report it hands back. */
async function runCodex(
  $: $,
  options: Options,
  agentId: string,
  description: string,
  input: string,
  state: AgentState,
): Promise<string> {
  const facts = await spawnFacts($, agentId, description)
  const { directive, body } = parseDirective(input)
  const continuing = Boolean(state.threadId) && !directive.fresh
  const settings = resolveSettings({
    options,
    directive,
    agentEffort: continuing ? undefined : facts.effort,
    permissionMode: facts.permissionMode,
  })
  const name = sessionName(directive.name ?? (slug(facts.description || description) || agentId))
  const cwd = facts.cwd ?? (await $.session.cwd())
  const socket = await controlSocket($, agentId)
  const request = {
    op: 'run',
    codexPath: options.codexPath || 'codex',
    cwd,
    threadId: continuing ? state.threadId : undefined,
    name: continuing ? undefined : name,
    // An explicit name resumes the codex session that holds it; a name made
    // from the description only labels a new one.
    reuseName: !continuing && directive.name !== undefined && !directive.fresh,
    developerInstructions: roleInstructions(name),
    input: body.trim() || input,
    controlSocket: socket,
    ...settings,
  }

  let thread: ThreadEvent | undefined
  let final: FinalEvent | undefined
  let failure: string | undefined
  let stderr = ''
  let buffer = ''
  state.socket = socket
  try {
    for await (const piece of $.process.spawn({ argv: helperArgv($), input: JSON.stringify(request), cwd })) {
      if (piece.stream === 'stderr') {
        stderr = (stderr + piece.text).slice(-2000)
        continue
      }
      buffer += piece.text
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        let event: { type: string; [key: string]: unknown }
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (event.type === 'thread') {
          thread = event as unknown as ThreadEvent
          state.threadId = thread.threadId
          state.sessionName = thread.name ?? name
          await saveState($, agentId, state)
          const settingsLine = [thread.model, thread.effort].filter(Boolean).join('/')
          await notice(
            $,
            agentId,
            `codex session ${state.sessionName} (${thread.resumed ? 'resumed' : 'new'}) · ${settingsLine}` +
              `${thread.serviceTier === 'priority' ? ' · fast' : ''} · sandbox ${thread.sandbox ?? '?'} · thread ${thread.threadId}`,
          )
        } else if (event.type === 'progress') {
          await notice($, agentId, String(event.text))
        } else if (event.type === 'final') {
          final = event as unknown as FinalEvent
        } else if (event.type === 'error') {
          failure = String(event.message)
        }
      }
    }
  } finally {
    state.socket = undefined
  }

  const report = final
    ? formatReport(final, thread)
    : `⚠ codex-bridge could not run codex: ${failure ?? 'the helper ended without a result'}` +
      (stderr.trim() ? `\n\n${stderr.trim()}` : '')
  state.report = report
  await saveState($, agentId, state)
  return report
}

const answerId = () => `toolu_codexbridge_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

export const register: Register = (on, rawOptions) => {
  const options = rawOptions as Options

  on('session.start', async ($, e, next) => {
    await $.agent.register({
      name: AGENT_NAME,
      description: describeAgent(options),
      prompt: FALLBACK_PROMPT,
      tools: [],
      model: 'haiku',
    })
    await $.command.register({
      name: 'codex',
      description: 'codex-bridge: codex subagent sessions of this project, and the settings in force',
    })
    return next(e)
  })

  // The Agent call's own `effort` ("lower" and "higher" included), which the
  // subagent's loop only knows resolved for a Claude model.
  on('tool.call', { tool: 'Agent' }, ($, e, next) => {
    agentEfforts.set(e.tool_use_id, (e as { effort?: string }).effort)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    if (!isCodexType($, e.subagentType)) return next(e)
    const result = await next(e)
    const agentId = result.agentId
    if (agentId) {
      const known = spawns.get(agentId)
      spawns.set(agentId, {
        description: e.description || known?.description || '',
        permissionMode: e.permissionMode ?? known?.permissionMode,
        cwd: e.cwd ?? known?.cwd,
        effort: e.resume ? known?.effort : agentEfforts.get(e.tool_use_id),
      })
      agentEfforts.delete(e.tool_use_id)
      spawnWaiters.get(agentId)?.()
    }
    return result
  }).catch(($, e, next) => next(e))

  // SendMessage to a codex agent mid-turn goes straight into that turn;
  // otherwise it queues as for any agent, and the next run picks it up.
  on('session.send', async ($, e, next) => {
    let agentId = states.get(e.to)?.socket ? e.to : undefined
    if (!agentId) {
      const named = (await $.agent.list()).find(a => a.name === e.to || a.id === e.to)
      if (named && states.get(named.id)?.socket) agentId = named.id
    }
    const socket = agentId ? states.get(agentId)?.socket : undefined
    if (!agentId || !socket) return next(e)
    try {
      const sent = await $.http.fetch('http://codex-bridge/steer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: e.text }),
        socketPath: socket,
      })
      if (sent.ok) return { isDelivered: true }
    } catch {}
    return next(e)
  }).catch(($, e, next) => next(e))

  // A codex agent's model steps never reach a model: codex answers them.
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (!agentId) return yield* next(e)
    const agent = await codexAgent($, agentId)
    if (!agent) return yield* next(e)

    let report: string
    let viaHandback = false
    try {
      const rows = (await $.session.messages({ agentId })) as readonly Row[]
      const api = await $.session.messages({ agentId, as: 'api' })
      const messages = Array.isArray(api) ? (api as readonly ApiMessage[]) : []
      viaHandback = handbackActive(messages)
      const state = await loadState($, agentId, rows)
      const plan = planStep(rows, messages, state.report)
      if (plan.kind === 'text') {
        const text = plan.text || 'Report delivered.'
        yield { kind: 'text', index: 0, text }
        yield { kind: 'stop', stopReason: 'end_turn', usage: null }
        return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
      }
      report = plan.kind === 'deliver' ? plan.report : await runCodex($, options, agentId, agent.description, plan.input, state)
    } catch (err) {
      if (next.signal.aborted) return
      report = `⚠ codex-bridge failed: ${err instanceof Error ? err.message : String(err)}`
    }
    if (next.signal.aborted) return

    // Where the engine asks for SubagentHandback the report goes through it;
    // elsewhere an agent's last text is its result.
    if (!viaHandback) {
      yield { kind: 'text', index: 0, text: report }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: report, toolUses: [], stopReason: 'end_turn', usage: null }
    }
    const input = { message: report }
    yield { kind: 'tool', index: 0, id: answerId(), name: HANDBACK }
    yield { kind: 'input', index: 0, json: JSON.stringify(input) }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: HANDBACK, input }], stopReason: 'tool_use', usage: null }
  })

  on('command.run', { command: 'codex' }, async $ => {
    const cwd = await $.session.cwd()
    const ask = async (op: string) => {
      const ran = await $.process.run(helperArgv($), {
        stdin: JSON.stringify({ op, cwd, codexPath: options.codexPath || 'codex' }),
        timeoutMs: 60_000,
      })
      const events = ran.stdout
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { type: string; [key: string]: unknown })
      const failed = events.find(event => event.type === 'error')
      if (failed) throw new Error(String(failed.message))
      return events[0]
    }
    const [config, listed] = await Promise.all([ask('config'), ask('list')])
    const c = (config?.config ?? {}) as Record<string, string | null>
    const threads = (listed?.data ?? []) as { id: string; name: string; model: string | null; updatedAt: number }[]
    const option = (key: keyof Options, fallback = 'inherit') => options[key] || fallback
    const lines = [
      'codex-bridge settings (/config):',
      `  model ${option('model')} · effort ${option('effort')} · fast ${option('fast')} · sandbox ${option('sandbox', 'follow-claude')} · approval ${option('approval', 'follow-claude')}`,
      "codex's own config (what `inherit` means here):",
      `  model ${c.model ?? '?'} · effort ${c.effort ?? '?'} · service tier ${c.serviceTier ?? 'default'} · sandbox ${c.sandbox ?? '?'} · approval ${c.approvalPolicy ?? '?'}`,
      `codex subagent sessions in ${cwd}:`,
      ...(threads.length
        ? threads.map(t => `  ${t.name}  ${t.id}  ${t.model ?? ''}  ${new Date(t.updatedAt * 1000).toLocaleString()}`)
        : ['  (none yet)']),
      'Open one in Codex: codex resume <name>',
    ]
    return { text: lines.join('\n') }
  })
}

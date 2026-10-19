import type { EngineInterface, ProcessSpawnChunk, Register, TurnStepChunk, TurnStepResult, TurnUsage } from 'claude-code'
import { type CommandEvent, type MirroredCall, mirrorCommand, mirrorPatch, type PatchEvent } from './lib/mirror'
import { movedLast, pluginsAfter } from './lib/order'
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
  newInstructions,
  planStep,
  type Row,
  type ThreadEvent,
  threadIdFromReport,
  type Usage,
} from './lib/step'

type $ = EngineInterface
type HelperEvent = { type: string; [key: string]: unknown }
type StepAnswer = AsyncGenerator<TurnStepChunk, TurnStepResult | void>

const HELPER = 'bin/codex-agent.mjs'
// The Claude tools a codex agent's transcript shows: codex's work mirrored as
// Bash, Edit and Write, and its own reach to Claude through SendMessage,
// which runs for real, as a subagent's does.
const AGENT_TOOLS = ['Bash', 'Edit', 'Write', 'SendMessage']
const OUTBOUND: Record<string, string> = { send_message: 'SendMessage' }

// If the bridge ever fails to answer a step, this is what the stand-in model reads.
const FALLBACK_PROMPT =
  'You stand in for an OpenAI Codex agent served by the codex-bridge plugin, which failed to take over this turn. ' +
  'Call no tool. Your whole report is: "codex-bridge error: the Codex bridge did not handle this turn; check that the plugin is loaded and that node and codex are on PATH."'

// What the Agent call said that its loop does not: kept from `agent.spawn`.
type SpawnFacts = { description: string; permissionMode?: string; cwd?: string; effort?: string }

/**
 * A helper process running one codex turn. The agent's steps read it in
 * turn, each pulling the stream itself: a pull is the engine's call in
 * flight, so a long wait on codex costs no step its time budget.
 */
class Runner {
  private queue: HelperEvent[] = []
  private buffer = ''
  private pieces: AsyncIterator<ProcessSpawnChunk>
  ready = false
  ended = false
  stderr = ''
  thread: ThreadEvent | undefined

  constructor(
    private stream: ReturnType<EngineInterface['process']['spawn']>,
    readonly socket: string,
    private onReady: () => void,
  ) {
    this.pieces = (stream as AsyncIterable<ProcessSpawnChunk>)[Symbol.asyncIterator]()
  }

  private read(piece: ProcessSpawnChunk) {
    if (piece.stream === 'stderr') {
      this.stderr = (this.stderr + piece.text).slice(-2000)
      return
    }
    this.buffer += piece.text
    for (let nl = this.buffer.indexOf('\n'); nl >= 0; nl = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      let event: HelperEvent
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === 'ready') {
        this.ready = true
        this.onReady()
      } else {
        this.queue.push(event)
      }
    }
  }

  /** Every event so far, waiting for one when there is none; [] once the helper ended. */
  async take(signal: AbortSignal): Promise<HelperEvent[]> {
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error('aborted'))
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    aborted.catch(() => undefined)
    while (this.queue.length === 0 && !this.ended) {
      try {
        const pulled = await Promise.race([this.pieces.next(), aborted])
        if (pulled.done) this.ended = true
        else this.read(pulled.value)
      } catch (err) {
        if (signal.aborted) throw err
        this.queue.push({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        this.ended = true
      }
    }
    return this.queue.splice(0)
  }

  putBack(events: HelperEvent[]) {
    this.queue.unshift(...events)
  }

  stop() {
    this.ended = true
    void (this.stream as unknown as AsyncGenerator<unknown, unknown, unknown>).return(undefined)
  }
}

// What a codex agent carries between its steps and turns.
type AgentState = {
  threadId?: string
  sessionName?: string
  report?: string
  /** From the agent's start to its report: Claude's messages are codex's to take. */
  live: boolean
  /** Messages taken while no codex turn could take them yet. */
  pending: string[]
  runner?: Runner
  /** The report of this run's earlier codex turns, when late messages ran more. */
  carried?: string
  /** SendMessage calls made for codex: tool_use_id -> codex call id. */
  calls: Map<string, string>
  usage?: TurnUsage
}

const states = new Map<string, AgentState>()
const spawns = new Map<string, SpawnFacts>()
const spawnWaiters = new Map<string, () => void>()
const agentEfforts = new Map<string, string | undefined>()
const otherAgents = new Set<string>()
const busyNames = new Map<string, string>()
// Answers for the mirrored tool calls, by tool_use_id.
const mirrored = new Map<string, MirroredCall['answer']>()

function describeAgent(options: Options): string {
  const show = (value: string | undefined, fallback: string) => (value && value !== 'inherit' ? value : fallback)
  return [
    'Delegates a task to OpenAI Codex: a separate coding agent working in this same project directory with its own sandbox and context, which returns one self-contained report.',
    'Use it as any subagent: give a complete brief; SendMessage reaches the running codex turn at once, or continues the session once it finished; TaskStop interrupts it; it can SendMessage you too.',
    'Optional first line of the prompt: `@codex model=<codex model> name=<name> effort=<low|medium|high|xhigh|max|ultra> fast=<on|off> sandbox=<read-only|workspace-write> new`, each key optional.',
    `The codex session is named ${NAME_PREFIX}<name> (from \`name\`, else from the description); a \`name\` that already exists in this project resumes that codex session with its context, and \`new\` starts a fresh one.`,
    "The Agent tool's `effort` sets codex's reasoning effort; its `model` is ignored.",
    `Defaults: model ${show(options.model, "codex's own")}, effort ${show(options.effort, "codex's own")}, fast ${show(options.fast, "codex's own")}, sandbox ${show(options.sandbox, 'follow-claude')}.`,
  ].join(' ')
}

const isCodexType = ($: $, type: string | undefined) => type === `${$.plugin.name}:${AGENT_NAME}`

function stateOf(agentId: string): AgentState {
  let state = states.get(agentId)
  if (!state) {
    state = { live: false, pending: [], calls: new Map() }
    states.set(agentId, state)
  }
  return state
}

// The first step of a fresh agent can run before its `agent.spawn` hook has
// heard the agent's id: give that hook a moment.
async function awaitSpawn($: $, agentId: string) {
  if (spawns.has(agentId)) return
  await Promise.race([new Promise<void>(r => spawnWaiters.set(agentId, r)), $.clock.sleep(3000)])
  spawnWaiters.delete(agentId)
}

async function codexAgent($: $, agentId: string): Promise<{ description: string } | undefined> {
  if (otherAgents.has(agentId)) return undefined
  let spawned = spawns.get(agentId)
  if (spawned) return { description: spawned.description }
  const info = (await $.agent.list()).find(a => a.id === agentId)
  if (info) {
    if (isCodexType($, info.type)) return { description: info.description }
    otherAgents.add(agentId)
    return undefined
  }
  await awaitSpawn($, agentId)
  spawned = spawns.get(agentId)
  return spawned && { description: spawned.description }
}

async function spawnFacts($: $, agentId: string, description: string): Promise<SpawnFacts> {
  await awaitSpawn($, agentId)
  return spawns.get(agentId) ?? { description }
}

async function loadState($: $, agentId: string, rows: readonly Row[]): Promise<AgentState> {
  const state = stateOf(agentId)
  if (state.threadId === undefined && state.report === undefined) {
    const stored = (await $.store.get(`agent:${agentId}`)) as Partial<AgentState> | undefined
    state.report = stored?.report ?? lastReport(rows)
    state.sessionName = stored?.sessionName
    state.threadId = stored?.threadId ?? threadIdFromReport(state.report)
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

async function post($: $, socket: string, route: string, body: unknown): Promise<number> {
  try {
    const sent = await $.http.fetch(`http://codex-bridge${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      socketPath: socket,
    })
    return sent.status
  } catch {
    return 0
  }
}

/** Hands Claude's message to the running codex turn, or keeps it for the next. */
async function steer($: $, state: AgentState, text: string): Promise<'steered' | 'pending'> {
  const runner = state.runner
  if (runner?.ready && !runner.ended) {
    const status = await post($, runner.socket, '/steer', { text })
    if (status === 200 || status === 202) return 'steered'
  }
  state.pending.push(text)
  return 'pending'
}

/** Starts the helper for one codex turn of the agent. */
async function startRun($: $, options: Options, agentId: string, description: string, input: string, state: AgentState) {
  const facts = await spawnFacts($, agentId, description)
  const { directive, body } = parseDirective(input)
  const continuing = Boolean(state.threadId) && !directive.fresh
  // Two agents of this session never drive one codex session at once: claim
  // the name before the next await.
  const claim = continuing ? state.sessionName : directive.name !== undefined && !directive.fresh ? sessionName(directive.name) : undefined
  const holder = claim ? busyNames.get(claim) : undefined
  if (claim && holder !== undefined && holder !== agentId && !continuing) {
    directive.fresh = true
    await notice($, agentId, `codex session ${claim} is busy with agent ${holder}: starting a new one`)
  } else if (claim) {
    busyNames.set(claim, agentId)
  }
  const settings = resolveSettings({
    options,
    directive,
    agentEffort: continuing ? undefined : facts.effort,
    permissionMode: facts.permissionMode,
  })
  const name = sessionName(directive.name ?? (slug(facts.description || description) || agentId))
  const socket = await controlSocket($, agentId)
  const request = {
    op: 'run',
    codexPath: options.codexPath || 'codex',
    cwd: facts.cwd ?? (await $.session.cwd()),
    threadId: continuing ? state.threadId : undefined,
    name: continuing ? undefined : name,
    // An explicit name resumes the codex session that holds it; a name made
    // from the description only labels a new one.
    reuseName: !continuing && directive.name !== undefined && !directive.fresh,
    developerInstructions: roleInstructions(),
    claudeTools: true,
    input: body.trim() || input,
    controlSocket: socket,
    ...settings,
  }
  const stream = $.process.spawn({ argv: helperArgv($), input: JSON.stringify(request), cwd: request.cwd })
  const runner: Runner = new Runner(stream, socket, () => {
    // Messages that came while the helper started: the turn takes them first.
    for (const text of state.pending.splice(0)) void steer($, state, text)
  })
  state.runner = runner
  state.usage = undefined
}

function releaseName(agentId: string, state: AgentState) {
  if (state.sessionName && busyNames.get(state.sessionName) === agentId) busyNames.delete(state.sessionName)
  for (const [name, holder] of busyNames) if (holder === agentId) busyNames.delete(name)
}

function addUsage(state: AgentState, last: Usage & { cacheWriteInputTokens?: number }) {
  const into = state.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: '' }
  into.input_tokens += Math.max(0, last.inputTokens - last.cachedInputTokens)
  into.cache_read_input_tokens += last.cachedInputTokens
  into.cache_creation_input_tokens += last.cacheWriteInputTokens ?? 0
  into.output_tokens += last.outputTokens
  into.model = state.runner?.thread?.model ?? into.model
  state.usage = into
}

function takeUsage(state: AgentState): TurnUsage | null {
  const usage = state.usage ?? null
  state.usage = undefined
  return usage
}

const callId = () => `toolu_codexbridge_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/**
 * Streams the running codex turn into this step: codex's messages as text,
 * its commands and edits as mirrored tool calls, its reach to Claude as real
 * ones. The step ends at the first tool calls, or with the report.
 */
async function* streamRun(
  $: $,
  options: Options,
  e: { turnId: string; index: number },
  signal: AbortSignal,
  agentId: string,
  state: AgentState,
  viaHandback: boolean,
): StepAnswer {
  let index = 0
  const toolUses: { name: string; input: unknown }[] = []
  let text = ''
  const yieldTool = function* (name: string, input: unknown, id = callId()): Generator<TurnStepChunk, string> {
    yield { kind: 'tool', index, id, name }
    yield { kind: 'input', index, json: JSON.stringify(input) }
    index++
    toolUses.push({ name, input })
    return id
  }

  for (;;) {
    const runner = state.runner!
    const events = await runner.take(signal)
    let final: FinalEvent | undefined
    let failure: string | undefined
    for (let i = 0; i < events.length; i++) {
      const event = events[i]!
      // Text after a tool call waits for the next step, as a model's would.
      if ((event.type === 'message' || event.type === 'note') && toolUses.length > 0) {
        runner.putBack(events.slice(i))
        break
      }
      switch (event.type) {
        case 'thread': {
          const thread = event as unknown as ThreadEvent
          runner.thread = thread
          state.threadId = thread.threadId
          state.sessionName = thread.name ?? state.sessionName
          if (state.sessionName) busyNames.set(state.sessionName, agentId)
          await saveState($, agentId, state)
          const settings = [thread.model, thread.effort].filter(Boolean).join('/')
          await notice(
            $,
            agentId,
            `codex session ${state.sessionName ?? '(unnamed)'} (${thread.resumed ? 'resumed' : 'new'}) · ${settings}` +
              `${thread.serviceTier === 'priority' ? ' · fast' : ''} · sandbox ${thread.sandbox ?? '?'} · thread ${thread.threadId}`,
          )
          break
        }
        case 'message':
        case 'note': {
          const block = String(event.text ?? '').trim()
          if (!block) break
          yield { kind: 'text', index, text: block }
          text += (text ? '\n\n' : '') + block
          index++
          break
        }
        case 'command': {
          const call = mirrorCommand(event as unknown as CommandEvent)
          const id = yield* yieldTool(call.name, call.input)
          mirrored.set(id, call.answer)
          break
        }
        case 'patch':
          for (const call of mirrorPatch(event as unknown as PatchEvent)) {
            const id = yield* yieldTool(call.name, call.input)
            mirrored.set(id, call.answer)
          }
          break
        case 'call': {
          const args = (event.arguments ?? {}) as Record<string, unknown>
          const tool = OUTBOUND[String(event.tool)]
          if (!tool) {
            await post($, runner.socket, '/tool-result', { callId: event.callId, text: `Unknown tool ${event.tool}`, isError: true })
            break
          }
          const message = String(args.message ?? '')
          const input =
            tool === 'SendMessage'
              ? { to: String(args.to || 'main'), message, summary: String(args.summary || message.split('\n')[0]!.slice(0, 80)) }
              : {}
          const id = yield* yieldTool(tool, input)
          state.calls.set(id, String(event.callId))
          break
        }
        case 'steered':
          await notice($, agentId, `Claude → codex: ${String(event.text ?? '')}`)
          break
        case 'usage':
          addUsage(state, event.last as Usage)
          break
        case 'final':
          final = event as unknown as FinalEvent
          break
        case 'error':
          failure = String(event.message)
          break
      }
      if (final || failure) {
        runner.putBack(events.slice(i + 1))
        break
      }
    }

    const ended = final !== undefined || failure !== undefined || (runner.ended && events.length === 0)
    if (toolUses.length > 0) {
      // The report waits until the engine has run these calls.
      if (final) runner.putBack([final as unknown as HelperEvent])
      if (failure) runner.putBack([{ type: 'error', message: failure }])
      yield { kind: 'stop', stopReason: 'tool_use', usage: takeUsage(state) }
      return { turnId: e.turnId, index: e.index, answer: text, toolUses, stopReason: 'tool_use', usage: null }
    }
    if (!ended) continue

    runner.stop()
    state.runner = undefined
    const thread = runner.thread
    let report = final
      ? formatReport(final, thread)
      : `⚠ codex-bridge could not run codex: ${failure ?? 'the helper ended without a result'}` +
        (runner.stderr.trim() ? `\n\n${runner.stderr.trim()}` : '')
    if (state.carried) report = `${state.carried}\n\n---\n\n${report}`

    // Messages that came as the turn ended run one more turn, in this same step.
    if (final && state.pending.length > 0 && state.threadId) {
      state.carried = report
      const input = state.pending.splice(0).join('\n\n')
      await startRun($, options, agentId, '', input, state)
      continue
    }

    state.carried = undefined
    state.report = report
    state.live = false
    releaseName(agentId, state)
    await saveState($, agentId, state)
    const usage = takeUsage(state)
    if (viaHandback) {
      const input = { message: report }
      yield* yieldTool(HANDBACK, input)
      yield { kind: 'stop', stopReason: 'tool_use', usage }
      return { turnId: e.turnId, index: e.index, answer: text, toolUses, stopReason: 'tool_use', usage: null }
    }
    yield { kind: 'text', index, text: report }
    yield { kind: 'stop', stopReason: 'end_turn', usage }
    return { turnId: e.turnId, index: e.index, answer: report, toolUses: [], stopReason: 'end_turn', usage: null }
  }
}

/** Codex's outcome for a mirrored call. Nothing else runs these tools in a codex agent's loop. */
async function answerMirrored($: $, e: { tool_use_id: string; agentId?: string }, run: () => Promise<unknown>) {
  const answer = mirrored.get(e.tool_use_id)
  if (answer) {
    mirrored.delete(e.tool_use_id)
    return answer
  }
  if (e.agentId && (await codexAgent($, e.agentId))) return { deny: 'codex-bridge: a codex agent runs no Claude tool of its own.' }
  return run()
}

/** Gives codex what the SendMessage calls made for it answered last step. */
async function answerCalls($: $, state: AgentState, rows: readonly Row[]) {
  if (state.calls.size === 0 || !state.runner) return
  for (const row of rows.slice(-4)) {
    for (const use of row.toolUses) {
      const codexCall = state.calls.get(use.tool_use_id)
      if (codexCall === undefined || use.text === undefined) continue
      state.calls.delete(use.tool_use_id)
      await post($, state.runner.socket, '/tool-result', { callId: codexCall, text: use.text, isError: use.isError === true })
    }
  }
}


export const register: Register = (on, rawOptions) => {
  const options = rawOptions as Options

  on('session.start', async ($, e, next) => {
    await $.agent.register({
      name: AGENT_NAME,
      description: describeAgent(options),
      prompt: FALLBACK_PROMPT,
      tools: AGENT_TOOLS,
      model: 'haiku',
    })
    await $.command.register({
      name: 'codex',
      description: 'codex-bridge: codex subagent sessions of this project, the settings in force; `order` puts the bridge last',
      argumentHint: '[order]',
    })
    return next(e)
  })

  // The Agent call's own `effort` ("lower" and "higher" included), which the
  // subagent's loop only knows resolved for a Claude model.
  on('tool.call', { tool: 'Agent' }, ($, e, next) => {
    agentEfforts.set(e.tool_use_id, (e as { effort?: string }).effort)
    return next(e)
  }).catch(($, e, next) => next(e))

  // A mirrored call already ran inside codex: answer it with codex's outcome.
  on('tool.call', { tool: 'Bash' }, ($, e, next) => answerMirrored($, e, () => next(e)) as never)
  on('tool.call', { tool: 'Edit' }, ($, e, next) => answerMirrored($, e, () => next(e)) as never)
  on('tool.call', { tool: 'Write' }, ($, e, next) => answerMirrored($, e, () => next(e)) as never)

  // A SendMessage the bridge makes for codex was codex's own decision, which
  // no request of Claude's model carries for auto mode's classifier to judge.
  on('tool.check', { tool: 'SendMessage' }, ($, e, next) => {
    const state = e.agentId ? states.get(e.agentId) : undefined
    if (e.tool_use_id && state?.calls.has(e.tool_use_id)) return { decision: 'allow', reason: 'codex-bridge: a message from the codex agent' }
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
      stateOf(agentId).live = true
      spawnWaiters.get(agentId)?.()
    }
    return result
  }).catch(($, e, next) => next(e))

  // SendMessage to a codex agent from its start to its report goes to codex:
  // straight into the running turn, or into the next one when none runs yet.
  on('session.send', async ($, e, next) => {
    let agentId = states.has(e.to) ? e.to : undefined
    if (!agentId) {
      const named = (await $.agent.list()).find(a => (a.name === e.to || a.id === e.to) && isCodexType($, a.type))
      agentId = named?.id
    }
    const state = agentId ? states.get(agentId) : undefined
    if (!state?.live) return next(e)
    if ((await steer($, state, e.text)) === 'pending' && !state.live) {
      // The report went out meanwhile: deliver as to any finished agent.
      state.pending = state.pending.filter(text => text !== e.text)
      return next(e)
    }
    return { isDelivered: true }
  }).catch(($, e, next) => next(e))

  // A codex agent's model steps never reach a model: codex answers them.
  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    if (!agentId) return yield* next(e)
    const agent = await codexAgent($, agentId)
    if (!agent) return yield* next(e)

    let state: AgentState | undefined
    let viaHandback = false
    try {
      const rows = (await $.session.messages({ agentId })) as readonly Row[]
      const api = await $.session.messages({ agentId, as: 'api' })
      const messages = Array.isArray(api) ? (api as readonly ApiMessage[]) : []
      viaHandback = handbackActive(messages)
      state = await loadState($, agentId, rows)

      if (state.runner) {
        await answerCalls($, state, rows)
        const waiting = [...newInstructions(rows, messages), ...(state.runner.ready ? state.pending.splice(0) : [])]
        for (const text of waiting) await steer($, state, text)
        return yield* streamRun($, options, e, next.signal, agentId, state, viaHandback)
      }

      const plan = planStep(rows, messages, state.report)
      if (plan.kind === 'run') {
        state.live = true
        const input = [plan.input, ...state.pending.splice(0)].join('\n\n')
        await startRun($, options, agentId, agent.description, input, state)
        return yield* streamRun($, options, e, next.signal, agentId, state, viaHandback)
      }
      state.live = false
      if (plan.kind === 'deliver' && viaHandback) {
        const input = { message: plan.report }
        yield { kind: 'tool', index: 0, id: callId(), name: HANDBACK }
        yield { kind: 'input', index: 0, json: JSON.stringify(input) }
        yield { kind: 'stop', stopReason: 'tool_use', usage: null }
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: HANDBACK, input }], stopReason: 'tool_use', usage: null }
      }
      const text = (plan.kind === 'deliver' ? plan.report : plan.text) || 'Report delivered.'
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
    } catch (err) {
      if (state?.runner) {
        state.runner.stop()
        state.runner = undefined
      }
      if (state) {
        state.live = false
        releaseName(agentId, state)
      }
      if (next.signal.aborted) return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: null, usage: null }
      const text = `⚠ codex-bridge failed: ${err instanceof Error ? err.message : String(err)}`
      yield { kind: 'text', index: 0, text }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
    }
  })

  // An agent stopped between its steps leaves no step to end its codex turn.
  on('turn.complete', async ($, e, next) => {
    const state = e.agentId ? states.get(e.agentId) : undefined
    if (state?.runner && e.isAborted) {
      state.runner.stop()
      state.runner = undefined
      state.live = false
      releaseName(e.agentId!, state)
    }
    return next(e)
  })

  on('command.run', { command: 'codex' }, async ($, e) => {
    const settingsFile = `${(await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`}/settings.json`
    if (e.args.trim() === 'order') {
      const moved = movedLast(String(await $.fs.read(settingsFile)), $.plugin.name)
      if (!moved) return { text: `${$.plugin.name} already comes last in ${settingsFile}.` }
      await $.fs.write(settingsFile, moved)
      return { text: `Moved ${$.plugin.name} last in enabledPlugins of ${settingsFile}. Restart Claude Code to apply.` }
    }
    const userSettings = (await $.settings.read({ source: 'user' })) as { enabledPlugins?: Record<string, unknown> }
    const after = pluginsAfter(userSettings?.enabledPlugins ?? {}, $.plugin.name)
    const cwd = await $.session.cwd()
    const ask = async (op: string) => {
      const ran = await $.process.run(helperArgv($), {
        stdin: JSON.stringify({ op, cwd, codexPath: options.codexPath || 'codex' }),
        timeoutMs: 60_000,
      })
      const events = ran.stdout
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as HelperEvent)
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
      after.length === 0
        ? 'Plugin order: codex-bridge comes last, so every mod sees codex tool calls.'
        : `Plugin order: ${after.join(', ')} come after codex-bridge and see no codex tool calls; /codex order moves it last.`,
    ]
    return { text: lines.join('\n') }
  })
}

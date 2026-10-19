#!/usr/bin/env node
// Drives `codex app-server` (JSON-RPC over stdio) for the codex-bridge plugin.
//
// Reads one JSON request on stdin and writes JSONL events on stdout:
//   op "run"    -> thread, turn, progress*, usage*, final   (one codex turn)
//   op "list"   -> threads                                   (claude-subagent-* threads of a cwd)
//   op "config" -> config                                    (codex's effective config for a cwd)
// While a run is in flight, POST /steer {text} or POST /interrupt on the
// unix socket named by `controlSocket` reaches the running turn.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const VERSION = '0.1.0'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const TEXT_LIMIT = 600
// thread/list only shows interactive sources unless told otherwise.
const SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'unknown']

const emit = event => {
  try {
    process.stdout.write(JSON.stringify(event) + '\n')
  } catch {}
}
const clip = (text, limit = TEXT_LIMIT) => {
  const flat = String(text ?? '').trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

class AppServer {
  constructor(codexPath, cwd) {
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.child = spawn(codexPath, ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.stderr = ''
    this.child.stderr.on('data', d => {
      this.stderr = (this.stderr + d).slice(-4000)
    })
    this.exited = new Promise(resolve => this.child.on('exit', (code, signal) => resolve({ code, signal })))
    this.child.on('error', err => {
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
    })
    this.exited.then(({ code, signal }) => {
      const err = new Error(`codex app-server exited (${signal ?? code}): ${clip(this.stderr, 400)}`)
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
    })
    createInterface({ input: this.child.stdout }).on('line', line => this.onLine(line))
  }

  onLine(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)))
      else waiter.resolve(msg.result)
    } else if (msg.method !== undefined && msg.id !== undefined) {
      this.respond(msg.id, answerServerRequest(msg.method, msg.params))
    } else if (msg.method !== undefined) {
      for (const listener of this.listeners) listener(msg.method, msg.params ?? {})
    }
  }

  send(message) {
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ id, method, params })
    })
  }

  respond(id, answer) {
    if (answer.error) this.send({ id, error: answer.error })
    else this.send({ id, result: answer.result })
  }

  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'claude-codex-bridge', title: 'Claude Code codex-bridge', version: VERSION },
    })
    this.codexHome = result?.codexHome
    this.send({ method: 'initialized' })
  }

  close() {
    try {
      this.child.stdin.end()
    } catch {}
    setTimeout(() => this.child.kill('SIGTERM'), 500).unref()
  }
}

// Nobody can answer codex's prompts from a Claude subagent: decline them all.
function answerServerRequest(method, params) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { result: { decision: 'decline' } }
    case 'applyPatchApproval':
    case 'execCommandApproval':
      return { result: { decision: 'denied' } }
    case 'item/permissions/requestApproval':
      return { result: { permissions: {}, scope: 'turn' } }
    case 'item/tool/requestUserInput':
      return { result: { answers: {} } }
    case 'mcpServer/elicitation/request':
      return { result: { action: 'decline' } }
    default:
      return { error: { code: -32601, message: `codex-bridge does not handle ${method}` } }
  }
}

function describeItem(item) {
  switch (item.type) {
    case 'commandExecution': {
      const seconds = item.durationMs != null ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ''
      const outcome =
        item.status === 'declined' ? 'declined' : item.exitCode != null ? `exit ${item.exitCode}` : item.status
      return `$ ${clip(item.command, 300)}  → ${outcome}${seconds}`
    }
    case 'fileChange': {
      const files = (item.changes ?? []).map(c => `${c.kind?.type ?? 'update'} ${c.path}`)
      return `✎ ${files.join(', ') || 'files changed'}${item.status === 'completed' ? '' : ` (${item.status})`}`
    }
    case 'mcpToolCall':
      return `⚙ ${item.server}.${item.tool} (${item.status})`
    case 'dynamicToolCall':
      return `⚙ ${item.tool} (${item.status})`
    case 'webSearch':
      return `🔎 ${clip(item.query, 200)}`
    case 'collabAgentToolCall':
      return `👥 ${item.tool}${item.prompt ? `: ${clip(item.prompt, 200)}` : ''}`
    case 'imageView':
      return `🖼 ${item.path}`
    case 'contextCompaction':
      return '⋯ context compacted'
    default:
      return undefined
  }
}

function describePlan(plan) {
  const mark = { completed: '✓', inProgress: '→', pending: '·' }
  return '📋 plan\n' + plan.map(s => `  ${mark[s.status] ?? '·'} ${s.step}`).join('\n')
}

function shiftEffort(effort, step) {
  const at = EFFORTS.indexOf(effort ?? 'medium')
  if (at < 0) return effort
  return EFFORTS[Math.min(EFFORTS.length - 1, Math.max(0, at + step))]
}

async function findThreadByName(server, cwd, name) {
  const listed = await server.request('thread/list', { cwd, searchTerm: name, limit: 50, sourceKinds: SOURCE_KINDS })
  return (listed.data ?? []).find(t => t.name === name)
}

// Helpers started side by side would pick the same free name: one at a time.
async function withNameLock(task) {
  const lock = path.join(os.tmpdir(), `codex-bridge-names-${os.userInfo().uid}.lock`)
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { recursive: true, force: true })
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100))
    }
  }
  try {
    return await task()
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

// thread/list leaves out threads that have no turn on disk yet, such as one
// a helper beside this one named a moment ago; codex's name index has them.
function indexedNames(codexHome) {
  try {
    return fs
      .readFileSync(path.join(codexHome, 'session_index.jsonl'), 'utf8')
      .split('\n')
      .flatMap(line => {
        try {
          return [JSON.parse(line).thread_name]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

async function nameThread(server, cwd, threadId, base) {
  return withNameLock(async () => {
    const listed = await server.request('thread/list', { cwd, searchTerm: base, limit: 100, sourceKinds: SOURCE_KINDS })
    const taken = new Set([...(listed.data ?? []).map(t => t.name), ...(server.codexHome ? indexedNames(server.codexHome) : [])])
    let name = base
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`
    await server.request('thread/name/set', { threadId, name })
    return name
  })
}

// `model` is the caller's own choice; `defaultModel` applies to a new thread only.
function threadOverrides(req, isNew) {
  const overrides = {}
  const model = req.model ?? (isNew ? req.defaultModel : undefined)
  if (model) overrides.model = model
  if (req.serviceTier) overrides.serviceTier = req.serviceTier
  if (req.sandbox) overrides.sandbox = req.sandbox
  if (req.approvalPolicy) overrides.approvalPolicy = req.approvalPolicy
  if (req.approvalsReviewer) overrides.approvalsReviewer = req.approvalsReviewer
  return overrides
}

async function openThread(server, req) {
  let thread = req.threadId ? { id: req.threadId } : undefined
  if (!thread && req.name && req.reuseName) thread = await findThreadByName(server, req.cwd, req.name)
  if (thread) {
    const resumed = await server.request('thread/resume', {
      threadId: thread.id,
      cwd: req.cwd,
      ...threadOverrides(req, false),
    })
    return { resumed: true, response: resumed, name: resumed.thread?.name ?? req.name }
  }
  const started = await server.request('thread/start', {
    cwd: req.cwd,
    developerInstructions: req.developerInstructions || null,
    ...threadOverrides(req, true),
  })
  const name = req.name ? await nameThread(server, req.cwd, started.thread.id, req.name) : undefined
  return { resumed: false, response: started, name }
}

async function run(req) {
  const server = new AppServer(req.codexPath || 'codex', req.cwd)
  let threadId
  let turnId
  let finished = false
  let usage
  let pendingMessage
  let lastMessage = ''
  let resolveDone
  const done = new Promise(resolve => (resolveDone = resolve))

  const flushMessage = () => {
    if (pendingMessage) emit({ type: 'progress', text: `💬 ${clip(pendingMessage)}` })
    pendingMessage = undefined
  }

  server.listeners.add((method, params) => {
    if (params.threadId && threadId && params.threadId !== threadId) return
    switch (method) {
      case 'item/started':
        if (params.item?.type !== 'agentMessage' && params.item?.type !== 'reasoning') flushMessage()
        break
      case 'item/completed': {
        const item = params.item
        if (item?.type === 'agentMessage') {
          flushMessage()
          lastMessage = item.text ?? ''
          if (item.phase === 'commentary') emit({ type: 'progress', text: `💬 ${clip(lastMessage)}` })
          else pendingMessage = lastMessage
          break
        }
        const line = item && describeItem(item)
        if (line) emit({ type: 'progress', text: line })
        break
      }
      case 'turn/plan/updated':
        if (params.plan?.length) emit({ type: 'progress', text: describePlan(params.plan) })
        break
      case 'thread/tokenUsage/updated':
        usage = params.tokenUsage
        break
      case 'error':
        emit({ type: 'progress', text: `⚠ ${clip(params.error?.message ?? JSON.stringify(params))}` })
        break
      case 'turn/completed':
        if (turnId && params.turn?.id !== turnId) break
        finished = true
        resolveDone(params.turn)
        break
    }
  })

  const interrupt = async () => {
    if (!threadId || !turnId || finished) return
    await server.request('turn/interrupt', { threadId, turnId }).catch(() => {})
  }

  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await Promise.race([interrupt().then(() => done), new Promise(r => setTimeout(r, 5000))])
    server.close()
    process.exit(130)
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop)
  process.stdout.on('error', stop)

  let control
  if (req.controlSocket) {
    fs.mkdirSync(path.dirname(req.controlSocket), { recursive: true, mode: 0o700 })
    fs.rmSync(req.controlSocket, { force: true })
    control = http.createServer(async (request, response) => {
      let body = ''
      for await (const chunk of request) body += chunk
      const reply = (status, payload) => {
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      try {
        if (request.url === '/steer') {
          const { text } = JSON.parse(body || '{}')
          if (!threadId || !turnId || finished) return reply(409, { ok: false, reason: 'no active turn' })
          await server.request('turn/steer', {
            threadId,
            expectedTurnId: turnId,
            input: [{ type: 'text', text, text_elements: [] }],
          })
          emit({ type: 'progress', text: `📨 Claude: ${clip(text)}` })
          return reply(200, { ok: true })
        }
        if (request.url === '/interrupt') {
          await interrupt()
          return reply(200, { ok: true })
        }
        reply(404, { ok: false })
      } catch (err) {
        reply(500, { ok: false, reason: err.message })
      }
    })
    control.listen(req.controlSocket)
  }

  try {
    await server.initialize()
    const opened = await openThread(server, req)
    const { response } = opened
    threadId = response.thread.id
    const effort =
      req.effort ??
      (req.effortStep ? shiftEffort(req.defaultEffort ?? response.reasoningEffort, req.effortStep) : undefined) ??
      (opened.resumed ? undefined : req.defaultEffort)
    emit({
      type: 'thread',
      threadId,
      name: opened.name ?? response.thread.name ?? null,
      resumed: opened.resumed,
      path: response.thread.path ?? null,
      model: response.model,
      effort: effort ?? response.reasoningEffort ?? null,
      serviceTier: response.serviceTier ?? null,
      sandbox: response.sandbox?.type ?? null,
      approvalPolicy: response.approvalPolicy ?? null,
      approvalsReviewer: response.approvalsReviewer ?? null,
    })

    const started = await server.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: req.input, text_elements: [] }],
      ...(effort ? { effort } : {}),
    })
    turnId = started.turn.id
    emit({ type: 'turn', turnId })

    const turn = await Promise.race([
      done,
      server.exited.then(({ code, signal }) => {
        throw new Error(`codex app-server exited (${signal ?? code}): ${clip(server.stderr, 400)}`)
      }),
    ])
    const final = pendingMessage ?? lastMessage
    pendingMessage = undefined
    emit({
      type: 'final',
      status: turn.status,
      text: final,
      error: turn.error?.message ?? null,
      usage: usage?.total ?? null,
      lastUsage: usage?.last ?? null,
    })
  } catch (err) {
    emit({ type: 'error', message: err.message })
    process.exitCode = 1
  } finally {
    control?.close()
    if (req.controlSocket) fs.rmSync(req.controlSocket, { force: true })
    server.close()
  }
}

async function list(req) {
  const server = new AppServer(req.codexPath || 'codex', req.cwd)
  try {
    await server.initialize()
    const listed = await server.request('thread/list', {
      cwd: req.cwd,
      searchTerm: req.prefix ?? 'claude-subagent-',
      limit: req.limit ?? 50,
      sourceKinds: SOURCE_KINDS,
    })
    emit({
      type: 'threads',
      data: (listed.data ?? [])
        .filter(t => t.name?.startsWith(req.prefix ?? 'claude-subagent-'))
        .map(t => ({ id: t.id, name: t.name, model: t.model, updatedAt: t.updatedAt, path: t.path })),
    })
  } catch (err) {
    emit({ type: 'error', message: err.message })
    process.exitCode = 1
  } finally {
    server.close()
  }
}

async function config(req) {
  const server = new AppServer(req.codexPath || 'codex', req.cwd)
  try {
    await server.initialize()
    const read = await server.request('config/read', { cwd: req.cwd })
    const c = read.config ?? {}
    emit({
      type: 'config',
      config: {
        model: c.model ?? null,
        effort: c.model_reasoning_effort ?? null,
        serviceTier: c.service_tier ?? null,
        sandbox: c.sandbox_mode ?? null,
        approvalPolicy: c.approval_policy ?? null,
        approvalsReviewer: c.approvals_reviewer ?? null,
      },
    })
  } catch (err) {
    emit({ type: 'error', message: err.message })
    process.exitCode = 1
  } finally {
    server.close()
  }
}

const req = JSON.parse(await readStdin())
const ops = { run, list, config }
if (!ops[req.op]) {
  emit({ type: 'error', message: `unknown op ${req.op}` })
  process.exit(2)
}
await ops[req.op](req)

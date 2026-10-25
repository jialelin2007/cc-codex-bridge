# cc-codex-bridge

[![CI](https://github.com/jialelin2007/cc-codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/jialelin2007/cc-codex-bridge/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/package-json/v/jialelin2007/cc-codex-bridge?filename=.claude-plugin%2Fplugin.json&label=version)](.claude-plugin/plugin.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 简体中文

一个 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 插件：让 Claude 像使用自己的子智能体一样使用 [OpenAI Codex](https://github.com/openai/codex)，由 Claude 主导协作。

插件不给模型新增任何工具，codex 子智能体就是一个普通的 agent 类型 `cc-codex-bridge:codex`：

- Claude 用原生的 **Agent** 启动它。
- 用 **SendMessage** 和它双向通信：运行中实时注入，结束后续接同一个 codex 会话；codex 也能主动给 Claude 发消息。
- 用 **ListAgents** 查看它，用 **TaskStop** 中断它。
- 它的工作过程和原生子智能体一样，以 Bash / Edit / Write 调用的形式出现在记录里，监测类 mod 也能看到。

活由 codex 用它自己的模型和账号来干，Claude 只负责写任务说明、读报告。对大块、独立的任务，这是一种节省 Claude 用量的办法。

## 目录

- [依赖](#依赖)
- [安装](#安装)
- [快速上手](#快速上手)
- [用法](#用法)
- [配置](#配置)
- [和其他 mod 一起用（插件顺序）](#和其他-mod-一起用插件顺序)
- [工作原理](#工作原理)
- [会消耗 Claude 额度吗？](#会消耗-claude-额度吗)
- [安全](#安全)
- [已知限制](#已知限制)
- [开发](#开发)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

## 依赖

- **Claude Code 2.1.303 或更新**：插件是一个基于函数钩子的 mod，这套 API 目前是 early access。
- **codex CLI 0.163 或更新**，并已登录（`codex login`）：插件通过 `codex app-server` 驱动 codex。
- **Node.js 18 或更新**，在 `PATH` 上：用来运行和 `codex app-server` 通信的 helper。
- **Linux 或 macOS**：插件在 Linux 上开发和测试。Windows 未测试，因为 helper 通过 Unix socket 接收消息。

## 安装

在 Claude Code 里：

```
/plugin marketplace add jialelin2007/cc-codex-bridge
/plugin install cc-codex-bridge@cc-codex-bridge
```

或在 shell 里一步完成：

```sh
claude plugin install cc-codex-bridge --marketplace jialelin2007/cc-codex-bridge
```

装好后开一个新的 Claude Code 会话，钩子才会加载。安装时会弹出一次设置页，所有设置都可以保持默认（见[配置](#配置)）。

更新或卸载：

```sh
claude plugin update cc-codex-bridge@cc-codex-bridge
claude plugin uninstall cc-codex-bridge@cc-codex-bridge
```

### 从 0.2.x 升级

0.3.0 把仓库、marketplace 和插件都从 `claude-codex-bridge` / `codex-bridge` 改名为 `cc-codex-bridge`，agent 类型随之变为 `cc-codex-bridge:codex`。直接更新不会沿用旧的安装，需要按新名字重装，然后在 `/config` 里重新设置一遍（设置按插件名保存）：

```sh
claude plugin uninstall codex-bridge@claude-codex-bridge
claude plugin marketplace remove claude-codex-bridge
claude plugin marketplace add jialelin2007/cc-codex-bridge
claude plugin install cc-codex-bridge@cc-codex-bridge
```

codex 会话不受影响，`name=` 仍会续接已有的 `claude-subagent-<name>` 会话。切换前启动的 agent，切换后不能再用 SendMessage 续接。

## 快速上手

直接用自然语言告诉 Claude：

> 用 codex 子智能体查一下 `packages/api` 里 `npm test` 为什么失败，并修好。

Claude 会调用：

```js
Agent({
  subagent_type: "cc-codex-bridge:codex",
  description: "修复 api 测试",
  prompt: "查一下 packages/api 里 `npm test` 为什么失败，并修好。…"
})
```

想让 Claude 主动把任务交给 codex，可以在 `CLAUDE.md` 里加一行：

```
Actively use codex subagents (cc-codex-bridge:codex) for self-contained tasks to save Claude usage.
```

运行 `/codex` 可以看到本项目的 codex 会话和当前生效的设置。

## 用法

```js
Agent({
  subagent_type: "cc-codex-bridge:codex",
  description: "修复登录超时",
  effort: "high",                      // 可选，映射为 codex 的 reasoning effort
  prompt: "@codex model=gpt-6-astra name=auth-timeout\n修复 …"
})
```

### `@codex` 指令

prompt 第一行可以写 `@codex` 指令，每个键都可省略，插件解析后会把这一行剥掉。

| 键 | 含义 |
|---|---|
| `model=<id>` | codex 模型，例如 `gpt-6-astra`、`gpt-6-luna` |
| `name=<name>` | 会话名，实际名字为 `claude-subagent-<name>`。同一项目里已有同名会话时续接它，上下文都在，跨 Claude 会话也可以 |
| `effort=<low\|medium\|high\|xhigh\|max\|ultra>` | 思考强度，优先于 Agent 的 `effort` 参数 |
| `fast=<on\|off>` | fast 模式（priority service tier） |
| `sandbox=<read-only\|workspace-write>` | 只能比配置允许的更严，不能放宽 |
| `new` | 即使名字已存在也新建会话（自动加 `-2` 之类的后缀） |

不写 `name` 时，会话名由 description 生成，例如 `claude-subagent-修复登录超时`。这种名字只用来标识新会话，重名时自动加后缀，不会续接已有会话。

Agent 的 `model` 参数只接受 Claude 模型别名，对 codex 子智能体无效，请用 `@codex model=`。

### 会话、消息和中断

- codex 的工作目录和 Claude 相同。Agent 传了 `isolation: "worktree"` 时，codex 在那个 worktree 里工作。
- 从启动到交回报告，`SendMessage({to: <agentId>, message})` 都直接交给 codex：
  - codex 正在跑时，通过 `turn/steer` 立即注入；
  - codex 还在启动、这一轮尚未开始时，消息并入第一轮的输入；
  - codex 这一轮刚结束、报告还没交回时，立刻在同一会话里再跑一轮处理它，两轮的报告合并交回。
- 子智能体结束后再发消息，会在同一个 codex 线程里开新的一轮。
- codex 有一个 `send_message` 工具。codex 调用它时，插件在子智能体里发起一次真正的 `SendMessage`（默认发给 `main`，也可以发给其他 agent），结果再交回 codex。
- `TaskStop` 中断正在运行的 codex 这一轮（`turn/interrupt`）。
- 报告末尾附一行 `[cc-codex-bridge] codex session … · thread … · rollout …`，Claude 可以据此读取 codex 的完整 rollout。
- `/codex` 列出本项目的 `claude-subagent-*` 会话。在 Codex 里可以用 `codex resume claude-subagent-<name>` 打开其中任意一个。

## 配置

插件的设置在 Claude Code 的 `/config` 里，每一项占一行，保存在 settings.json 的 `pluginConfigs` 下。值为 `inherit` 或留空时，沿用 `~/.codex/config.toml`。

| 项 | 取值 | 默认 |
|---|---|---|
| Codex fast mode | `inherit` / `on` / `off` | `inherit` |
| Codex default model | 模型 id，留空表示继承 | 空 |
| Codex default reasoning effort | `inherit` / `low` … `ultra` | `inherit` |
| Codex sandbox | `follow-claude` / `inherit` / `read-only` / `workspace-write` / `danger-full-access` | `follow-claude` |
| Codex approvals | `follow-claude` / `inherit` / `never` / `auto-review` | `follow-claude` |
| codex executable | codex CLI 的路径 | `codex` |

优先级：`@codex` 指令 > Agent 的 `effort` 参数 > 插件配置 > `~/.codex/config.toml`。配置里的默认模型和默认思考强度只在新建会话时生效，续接的会话保留它自己的设置。

`follow-claude` 让 codex 跟随 Claude 当前的权限模式，和 Claude 子智能体继承父级权限模式的做法一致：

| Claude 权限模式 | codex 沙箱 | codex 审批 |
|---|---|---|
| `plan` | read-only | never |
| `default` / `acceptEdits` / `dontAsk` | workspace-write | never |
| `auto` | workspace-write | on-request，交给 codex auto-review |
| `bypassPermissions` | danger-full-access | never |

子智能体运行时没人能回答 codex 的审批请求或提问，插件会一律拒绝，所以审批只能是 never 或 auto-review。

## 和其他 mod 一起用（插件顺序）

插件的钩子按 settings.json 里 `enabledPlugins` 的顺序嵌套，排在前面的在外层。codex 的镜像工具调用由 cc-codex-bridge 自己作答，所以只有排在它**前面**的 mod 能看到这些调用。agent-radar、mission-control 这类监测子智能体的 mod 要排在前面，也就是 cc-codex-bridge 应当排在最后：

- `/codex` 的最后一行会说明当前顺序，以及哪些插件排在它后面。
- `/codex order` 把 cc-codex-bridge 移到 `~/.claude/settings.json` 的 `enabledPlugins` 末尾，重启 Claude Code 后生效。之后再安装新的 mod，可以再运行一次。

顺序正确时，这类 mod 看到的 codex 子智能体和原生子智能体一样：启动、结束、每次工具调用、正在运行的命令、命令的成败和耗时、改动的文件。

## 工作原理

```
Claude
  │ Agent(subagent_type: "cc-codex-bridge:codex")
  ▼
原生子智能体循环
  │ 每次模型请求（turn.step）
  ▼
cc-codex-bridge 钩子接管并作答，不发给 Claude 模型
  │ node bin/codex-agent.mjs
  ▼
codex app-server（JSON-RPC）── codex 线程
  thread/start · thread/name/set · turn/start
  turn/steer         ◄── SendMessage（运行中）
  turn/interrupt     ◄── TaskStop
  send_message 工具  ──► 子智能体的 SendMessage
```

- 插件是一个 Claude Code mod（函数钩子插件）。它注册 agent 类型 `cc-codex-bridge:codex`，用 `turn.step` 钩子接管这个子智能体的每一次模型请求，改由 codex 回答。
- **工作过程和原生子智能体一样可见。** codex 执行的每条命令显示为一次 `Bash` 调用：命令一开始就出现，跑完时填入输出，所以长命令运行期间能看到它正在跑什么。失败的命令和原生 Bash 一样显示为错误（`Exit code N` 加输出）。
  - 文件改动显示为带 diff 的 `Edit`，新建文件显示为 `Write`，删除和移动显示为带路径的 `Bash`。
  - codex 的中间说明显示为子智能体的文字。
  - 这些调用已经在 codex 里执行过，插件直接用 codex 的结果作答，Claude 侧不会再执行一遍。
- codex 的回答作为子智能体的最终报告交回。如果当前会话要求子智能体通过 SubagentHandback 交付（例如 auto 模式），就走 SubagentHandback；否则作为子智能体的最后一条文本交回。

## 会消耗 Claude 额度吗？

codex 子智能体自己干的活不消耗。插件亲自回答 codex 子智能体的每一步，这些步骤不会发出任何 Claude 请求，Claude Code 的会话费用里也不包含 codex 的 token。

Claude 侧仍有的消耗：

- **主对话本身**：写任务说明、读报告，以及后台子智能体结束时 Claude Code 触发的那一轮。这和使用任何子智能体一样，长会话里这是大头。
- **进度摘要**：交互会话中，子智能体在后台运行时，Claude Code 大约每 30 秒请一个小模型生成一行状态。codex 子智能体用的是它注册的模型 Haiku，实测约占会话费用的 1%。插件拦不下这类请求。前台运行（`run_in_background: false`）的子智能体没有进度摘要，但主对话要一直等它跑完。
- **兜底**：插件没有接管某一步时（例如插件没能加载），由 Haiku 代答一句简短的报错。

`/cost` 下方的 "What's contributing to your limits usage?" 是根据本地记录估算的。插件把 codex 的 token 记在子智能体的消息上，方便监测 mod 显示，这个估算会把它们算成子智能体用量。真实额度（5 小时和每周的百分比）来自服务器，不受影响。

## 安全

在给 codex 宽松权限之前，请先读这一节：

- **codex 的操作不经过 Claude 的权限系统。** codex 用自己的工具干活：shell、apply_patch，以及它自己的 MCP 和 skills。Claude 的权限规则和 PreToolUse 等钩子管不到这些操作，它们只受 codex 自己的沙箱和审批设置约束。
- **沙箱默认跟随 Claude。** 默认的 `follow-claude` 下，`bypassPermissions` 模式会给 codex `danger-full-access`。想不论 Claude 处于什么模式都给它设上限，可以把 **Codex sandbox** 设为 `workspace-write` 或 `read-only`。`@codex sandbox=` 指令只能收紧这个上限。
- **镜像出来的工具调用只是记录，不是操作。** 记录里的 Bash / Edit / Write 调用已经在 codex 里执行过了，对它们设置 allow 或 deny 规则拦不住任何东西。

报告安全漏洞请见 [SECURITY.md](SECURITY.md)。

## 已知限制

- codex 能用的 Claude 能力只有 `send_message`，对应原生子智能体的 SendMessage；原生子智能体同样没有 ListAgents。
- codex 的 web 搜索、MCP 调用、计划更新等没有对应的 Claude 工具，在记录里显示为一行文字。
- `isolation: "remote"` 不适用：远端会话不会加载本机插件。
- codex 这一轮本身失败时（例如额度用完、模型报错），报告里会写明失败原因，但子智能体在监测 mod 里显示为「完成」而不是「失败」：mod API 目前没有让子智能体以错误结束的方式。
- codex 用 shell 读文件、搜索时显示为 `Bash`，不会换成 `Read`、`Grep`，所以监测 mod 的文件列表里只有 codex 改动过的文件。
- mod API 和 `codex app-server` 协议都还在演进。升级 Claude Code 或 codex 后如有问题，先运行 `claude plugin validate .` 和测试，再[提交 issue](https://github.com/jialelin2007/cc-codex-bridge/issues/new/choose)。

## 开发

从本地目录加载插件，而不是从 marketplace 安装：

```sh
git clone https://github.com/jialelin2007/cc-codex-bridge
claude --plugin-dir ./cc-codex-bridge
```

校验和测试。没有构建步骤，也不需要 `npm install`，Claude Code 直接运行 TypeScript 钩子。

```sh
claude plugin validate .      # 校验清单和钩子模块
claude plugin test .          # 运行 hooks/lib/*.test.ts
node --check bin/codex-agent.mjs
```

目录结构：

| 路径 | 作用 |
|---|---|
| `hooks/register.ts` | 钩子接线：注册 agent 类型和 `/codex`；处理 `turn.step` 接管、镜像工具调用的应答（`tool.call`）、消息投递（`session.send`）和启动参数采集（`agent.spawn`） |
| `hooks/lib/policy.ts` | `@codex` 指令、会话名、设置优先级、权限映射 |
| `hooks/lib/step.ts` | 从子智能体记录判断下一步该做什么；报告格式 |
| `hooks/lib/order.ts` | 插件顺序检查和 `/codex order` 的改写 |
| `hooks/lib/mirror.ts` | 把 codex 的命令和文件改动换成对应的 Bash / Edit / Write 调用及其结果 |
| `bin/codex-agent.mjs` | 驱动 `codex app-server` 的 Node helper：提供 `run` / `list` / `config` 三个操作，并在 Unix socket 上提供 `/steer`、`/tool-result` 和 `/interrupt` |

## 参与贡献

欢迎提交 bug、想法和 pull request。环境搭建、测试和提交流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，各版本改动见 [CHANGELOG.md](CHANGELOG.md)。所有参与者都应遵守[行为准则](CODE_OF_CONDUCT.md)。

## 许可证

[MIT](LICENSE) © Jiale Lin

本项目是独立的社区项目，与 Anthropic 和 OpenAI 没有关联，也未获得其认可或赞助。Claude 和 Claude Code 是 Anthropic 的商标；OpenAI 和 Codex 是 OpenAI 的商标。

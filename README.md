# codex-bridge

让 Claude Code 像使用自己的子智能体一样使用 OpenAI Codex，由 Claude 主导协作。

不新增任何给模型调用的工具：codex 子智能体就是一个普通的 agent 类型 `codex-bridge:codex`。Claude 用原生的 **Agent** 启动它，用 **SendMessage** 和它双向通信（运行中实时注入，结束后续接同一个 codex 会话；codex 也能主动发消息给 Claude），用 **ListAgents** 查看它，用 **TaskStop** 中断它；它的工作过程像原生子智能体一样，以 Bash / Edit / Write 调用的形式出现在记录里。

## 工作原理

```
Claude ──Agent(subagent_type: "codex-bridge:codex")──► 原生子智能体循环
                                                        │ 每次模型请求（turn.step）
                                                        ▼
                              codex-bridge 钩子接管：不发给 Claude 模型
                                                        │ node bin/codex-agent.mjs
                                                        ▼
                                    codex app-server（JSON-RPC）── codex 线程
                                    thread/start · thread/name/set · turn/start
                                    turn/steer ◄── SendMessage（运行中）
                                    turn/interrupt ◄── TaskStop
                                    send_message 工具 ──► 子智能体的 SendMessage
```

- 插件是一个 Claude Code mod（函数钩子插件）。它注册 agent 类型 `codex-bridge:codex`，并用 `turn.step` 钩子接管这个子智能体的每一次模型请求，改由 codex 回答。Claude 侧不消耗模型 token。
- **工作过程和原生子智能体一样可见**：codex 执行的每条命令显示为一次 `Bash` 调用（带输出），每处文件改动显示为 `Edit`（带 diff），新建文件显示为 `Write`，codex 的中间说明显示为子智能体的文字。这些调用已经在 codex 里执行过，插件直接用 codex 的结果回答，不会在 Claude 侧再执行一遍。
- **codex 能主动联系 Claude**：codex 有一个 `send_message` 工具，调用它时插件在子智能体里发起一次真正的 `SendMessage`（默认发给 `main`，也可以发给其他 agent），和原生子智能体发消息完全一样，结果再交回 codex。
- codex 的回答作为子智能体的最终报告交回。如果当前会话要求子智能体通过 SubagentHandback 交付（例如 auto 模式），就走 SubagentHandback；否则作为子智能体的最后一条文本交回。
- 报告末尾附一行 `[codex-bridge] codex session … · thread … · rollout …`，Claude 可以据此读取 codex 的完整 rollout。

## 用法（Claude 侧）

```
Agent({
  subagent_type: "codex-bridge:codex",
  description: "修复登录超时",
  effort: "high",                       // 可选，映射为 codex 的 reasoning effort
  prompt: "@codex model=gpt-6-astra name=auth-timeout\n修复 …"
})
```

prompt 第一行可以写 `@codex` 指令，每个键都可省略，插件解析后会把这一行剥掉：

| 键 | 含义 |
|---|---|
| `model=<id>` | codex 模型，例如 `gpt-6-astra`、`gpt-6-luna` |
| `name=<name>` | 会话名，实际名字为 `claude-subagent-<name>`。同一项目里已有同名会话时续接它，上下文都在，跨 Claude 会话也可以 |
| `effort=<low\|medium\|high\|xhigh\|max\|ultra>` | 思考强度，优先于 Agent 的 `effort` 参数 |
| `fast=<on\|off>` | fast 模式（priority service tier） |
| `sandbox=<read-only\|workspace-write>` | 只能比配置允许的更严，不能放宽 |
| `new` | 即使名字已存在也新建会话（自动加 `-2` 之类的后缀） |

- 不写 `name` 时，会话名由 description 生成，例如 `claude-subagent-修复登录超时`。这种名字只用来标识新会话，重名时自动加后缀，不会续接已有会话。
- Agent 的 `model` 参数只接受 Claude 模型别名，对 codex 子智能体无效，请用 `@codex model=`。
- codex 的工作目录和 Claude 相同。Agent 传了 `isolation: "worktree"` 时，codex 在那个 worktree 里工作。
- 从子智能体启动到交回报告，`SendMessage({to: <agentId>, message})` 都直接交给 codex：codex 正在跑时通过 `turn/steer` 立即注入；codex 还在启动、这一轮尚未开始时，消息并入第一轮的输入；codex 这一轮刚结束、报告还没交回时，立刻在同一会话里再跑一轮处理它，两轮的报告合并交回。子智能体结束后再发，会在同一个 codex 线程里开新的一轮。
- `/codex` 斜杠命令列出本项目的 `claude-subagent-*` 会话，并显示当前生效的设置。在 Codex 里可以用 `codex resume claude-subagent-<name>` 打开其中任意一个。

### 和其他 mod 一起用（插件顺序）

插件的钩子按 settings.json 里 `enabledPlugins` 的顺序嵌套，排在前面的在外层。codex 的镜像工具调用由 codex-bridge 自己作答，所以只有排在它**前面**的 mod（例如 agent-radar、mission-control 这类监测子智能体的 mod）能看到这些调用；排在它后面的看不到。codex-bridge 应当排在最后：

- `/codex` 的最后一行会说明当前顺序，以及哪些插件排在它后面。
- `/codex order` 把 codex-bridge 移到 `~/.claude/settings.json` 的 `enabledPlugins` 末尾，重启 Claude Code 后生效。之后再安装新的 mod，也可以再运行一次。

## 配置（/config）

插件的设置在 Claude Code 的 `/config` 里，每一项占一行；安装时也会弹出一次设置页。设置保存在 settings.json 的 `pluginConfigs` 下。值为 `inherit` 或留空时，沿用 `~/.codex/config.toml`。

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

## 安装

依赖：Claude Code 2.1.303 或更新（需要 mod / 函数钩子，这套 API 目前是 early access）、codex CLI 0.163 或更新（需要 `codex app-server`）、Node.js 18 或更新，并且 `codex` 已登录。

在 Claude Code 终端里：

```
/plugin install codex-bridge --marketplace jialelin2007/claude-codex-bridge
```

或在 shell 里：

```
claude plugin install codex-bridge --marketplace jialelin2007/claude-codex-bridge
```

仓库是私有的：安装的机器上需要有能读取它的 GitHub 凭据（例如先运行 `gh auth login`，再运行 `gh auth setup-git`），安装过程不会提示输入凭据。

开发时直接从目录加载：

```
claude --plugin-dir /path/to/claude-codex-bridge
```

## 已知限制

- codex 用自己的工具干活（shell、apply_patch、它自己的 MCP 和 skills）。Claude 侧的权限规则和 PreToolUse 等钩子管不到这些操作，它们只受 codex 的沙箱和审批约束。
- codex 能用的 Claude 能力只有 `send_message`，对应原生子智能体的 SendMessage；原生子智能体同样没有 ListAgents。
- codex 的 web 搜索、MCP 调用、计划更新等没有对应的 Claude 工具，在记录里显示为一行文字。
- `isolation: "remote"` 不适用：远端会话不会加载本机插件。
- mod API 和 `codex app-server` 协议都还在演进，升级 Claude Code 或 codex 后如有问题，先运行 `claude plugin validate` 和下面的测试。

## 开发

```
claude plugin validate .      # 校验清单和钩子模块
claude plugin test .          # 运行 hooks/lib/*.test.ts
```

- `hooks/register.ts`：钩子接线。注册 agent 类型和 `/codex`，处理 `turn.step` 接管、镜像工具调用的应答（`tool.call`）、`session.send` 消息投递和 `agent.spawn` 参数采集。
- `hooks/lib/policy.ts`：`@codex` 指令、会话名、设置优先级、权限映射。
- `hooks/lib/step.ts`：从子智能体记录判断下一步该做什么，以及报告格式。
- `hooks/lib/order.ts`：插件顺序检查和 `/codex order` 的改写。
- `hooks/lib/mirror.ts`：把 codex 的命令和文件改动换成对应的 Bash / Edit / Write 调用及其结果。
- `bin/codex-agent.mjs`：驱动 `codex app-server` 的 Node helper，提供 run / list / config 三个操作，并在 unix socket 上提供 `/steer`、`/tool-result` 和 `/interrupt`。

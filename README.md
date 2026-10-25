# claude-codex-bridge

[![CI](https://github.com/jialelin2007/claude-codex-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/jialelin2007/claude-codex-bridge/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/package-json/v/jialelin2007/claude-codex-bridge?filename=.claude-plugin%2Fplugin.json&label=version)](.claude-plugin/plugin.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [简体中文](README.zh-CN.md)

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that lets Claude use [OpenAI Codex](https://github.com/openai/codex) the way it uses its own subagents, with Claude leading the work.

It adds no new tools for the model. The codex subagent is an ordinary agent type, `codex-bridge:codex`:

- Claude starts it with the native **Agent** tool.
- **SendMessage** talks to it both ways. A message reaches a running codex turn at once, or continues the same codex session after it finished, and codex can message Claude too.
- **ListAgents** shows it and **TaskStop** interrupts it.
- Its work appears in the transcript as Bash / Edit / Write calls, just like a native subagent's, so monitoring mods see it too.

Codex does the work with its own model and account, so Claude only writes the brief and reads the report. This makes it a way to save Claude usage on large, self-contained tasks.

## Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [Using it with other mods (plugin order)](#using-it-with-other-mods-plugin-order)
- [How it works](#how-it-works)
- [Does it use my Claude quota?](#does-it-use-my-claude-quota)
- [Security](#security)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

## Requirements

- **Claude Code 2.1.303 or later.** The plugin is a mod built on function hooks, an API that is still in early access.
- **Codex CLI 0.163 or later**, signed in (`codex login`). The plugin drives `codex app-server`.
- **Node.js 18 or later** on `PATH`, to run the helper that talks to `codex app-server`.
- **Linux or macOS.** The plugin is developed and tested on Linux. Windows is untested: the helper takes messages on a Unix socket.

## Installation

In Claude Code:

```
/plugin marketplace add jialelin2007/claude-codex-bridge
/plugin install codex-bridge@claude-codex-bridge
```

Or from a shell, in one step:

```sh
claude plugin install codex-bridge --marketplace jialelin2007/claude-codex-bridge
```

The repository and marketplace are called `claude-codex-bridge`, but the plugin itself is `codex-bridge`: Claude Code reserves plugin names starting with `claude-` for Anthropic's own.

Start a new Claude Code session afterwards so the hooks load. The plugin's settings page opens once on install; every setting can stay at its default (see [Configuration](#configuration)).

To update or remove it:

```sh
claude plugin update codex-bridge@claude-codex-bridge
claude plugin uninstall codex-bridge@claude-codex-bridge
```

## Quick start

Ask Claude in plain words:

> Use the codex subagent to find out why `npm test` fails in `packages/api` and fix it.

Claude then calls:

```js
Agent({
  subagent_type: "codex-bridge:codex",
  description: "Fix failing api tests",
  prompt: "Find out why `npm test` fails in packages/api and fix it. …"
})
```

To have Claude delegate to codex on its own, add a line like this to your `CLAUDE.md`:

```
Actively use codex subagents (codex-bridge:codex) for self-contained tasks to save Claude usage.
```

Run `/codex` to see this project's codex sessions and the settings in effect.

## Usage

```js
Agent({
  subagent_type: "codex-bridge:codex",
  description: "Fix the login timeout",
  effort: "high",                      // optional: codex's reasoning effort
  prompt: "@codex model=gpt-6-astra name=auth-timeout\nFix …"
})
```

### The `@codex` directive

The first line of the prompt may be an `@codex` directive. Every key is optional, and the plugin strips the line before codex sees the prompt.

| Key | Meaning |
|---|---|
| `model=<id>` | Codex model, for example `gpt-6-astra` or `gpt-6-luna` |
| `name=<name>` | Session name; the codex session is called `claude-subagent-<name>`. If one by that name already exists in this project, it is resumed with its context, even from another Claude session |
| `effort=<low\|medium\|high\|xhigh\|max\|ultra>` | Reasoning effort; takes precedence over the Agent tool's `effort` |
| `fast=<on\|off>` | Fast mode (the priority service tier) |
| `sandbox=<read-only\|workspace-write>` | Can only tighten the sandbox your settings allow, never widen it |
| `new` | Start a fresh session even if the name exists (a suffix such as `-2` is added) |

Without `name`, the session name comes from the description, for example `claude-subagent-fix-the-login-timeout`. Such a name only labels a new session: a clash adds a suffix instead of resuming the existing session.

The Agent tool's `model` parameter only takes Claude model aliases and has no effect on codex subagents. Use `@codex model=` instead.

### Sessions, messages and interrupts

- Codex works in the same directory as Claude. With `isolation: "worktree"`, it works in that worktree.
- From launch until the report is delivered, `SendMessage({to: <agentId>, message})` goes straight to codex:
  - while codex is running, it is injected into the turn at once (`turn/steer`);
  - while codex is still starting, it joins the first turn's input;
  - if codex has just finished but the report is not delivered yet, codex runs another turn in the same session and both reports are delivered together.
- A message sent after the subagent finished starts a new turn in the same codex thread.
- Codex has a `send_message` tool. When codex calls it, the plugin makes a real `SendMessage` from the subagent (to `main` by default, or to another agent) and hands the result back to codex.
- `TaskStop` interrupts the running codex turn (`turn/interrupt`).
- The report ends with a line `[codex-bridge] codex session … · thread … · rollout …`, which Claude can use to read codex's full rollout.
- `/codex` lists this project's `claude-subagent-*` sessions. Open any of them in Codex with `codex resume claude-subagent-<name>`.

## Configuration

The settings are in Claude Code's `/config`, one row each, and are stored under `pluginConfigs` in `settings.json`. `inherit` or an empty value means "use `~/.codex/config.toml`".

| Setting | Values | Default |
|---|---|---|
| Codex fast mode | `inherit` / `on` / `off` | `inherit` |
| Codex default model | a model id; empty inherits | empty |
| Codex default reasoning effort | `inherit` / `low` … `ultra` | `inherit` |
| Codex sandbox | `follow-claude` / `inherit` / `read-only` / `workspace-write` / `danger-full-access` | `follow-claude` |
| Codex approvals | `follow-claude` / `inherit` / `never` / `auto-review` | `follow-claude` |
| codex executable | path to the codex CLI | `codex` |

Precedence: `@codex` directive > the Agent tool's `effort` > plugin settings > `~/.codex/config.toml`. The default model and effort apply only to new sessions; a resumed session keeps its own.

`follow-claude` makes codex follow Claude's current permission mode, the way a Claude subagent inherits its parent's:

| Claude permission mode | Codex sandbox | Codex approvals |
|---|---|---|
| `plan` | read-only | never |
| `default` / `acceptEdits` / `dontAsk` | workspace-write | never |
| `auto` | workspace-write | on-request, decided by codex auto-review |
| `bypassPermissions` | danger-full-access | never |

Nobody can answer codex's approval prompts or questions while it runs as a subagent, so the plugin declines them all. That is why approvals can only be `never` or `auto-review`.

## Using it with other mods (plugin order)

Plugin hooks nest in the order of `enabledPlugins` in `settings.json`, earlier ones outside. codex-bridge answers the mirrored tool calls itself, so only mods listed **before** it see them. Monitoring mods such as agent-radar or mission-control need to come first, so codex-bridge should come last:

- The last line of `/codex` tells you the current order and which plugins come after codex-bridge.
- `/codex order` moves codex-bridge to the end of `enabledPlugins` in `~/.claude/settings.json`. Restart Claude Code to apply it, and run it again after installing new mods.

With the right order, those mods see a codex subagent the same as a native one: its start and end, every tool call, the command running now, each command's result and duration, and the files it changed.

## How it works

```
Claude
  │ Agent(subagent_type: "codex-bridge:codex")
  ▼
native subagent loop
  │ each model request (turn.step)
  ▼
codex-bridge hook: answers it, nothing is sent to Claude's model
  │ node bin/codex-agent.mjs
  ▼
codex app-server (JSON-RPC) ── codex thread
  thread/start · thread/name/set · turn/start
  turn/steer         ◄── SendMessage (while running)
  turn/interrupt     ◄── TaskStop
  send_message tool  ──► the subagent's SendMessage
```

- The plugin is a Claude Code mod (a function-hook plugin). It registers the agent type `codex-bridge:codex` and uses a `turn.step` hook to answer every model request of that subagent with codex instead.
- **The work shows like a native subagent's.** Each command codex runs appears as a `Bash` call. It shows up when the command starts and gets its output when it ends, so you can see what a long command is doing. Failed commands show as errors (`Exit code N` plus output), as with native Bash.
  - File changes appear as `Edit` with a diff, and new files as `Write`. Deletes and moves appear as `Bash` with the paths.
  - Codex's progress notes appear as the subagent's text.
  - These calls already ran inside codex. The plugin answers them with codex's results; Claude does not run them again.
- Codex's answer comes back as the subagent's final report. If the session asks subagents to deliver through SubagentHandback (for example in auto mode), the report goes that way; otherwise it is the subagent's last text.

## Does it use my Claude quota?

The codex agent's own work does not. The plugin answers each model step of a codex subagent itself, so no Claude request is made for them. Claude Code's session cost leaves codex's tokens out.

Claude usage that remains:

- **The main conversation.** Writing the brief, reading the report, and the turn Claude Code starts when a background agent finishes. This is the same as with any subagent, and in long sessions it is most of the cost.
- **Progress summaries.** While a subagent runs in the background of an interactive session, Claude Code asks a small model about every 30 seconds for a one-line status. For a codex agent this is Haiku, the agent's registered model. In a test this came to about 1% of the session's cost. Plugins cannot intercept these requests. Agents run in the foreground (`run_in_background: false`) get no summaries, but the main conversation waits for them.
- **Fallback.** If the plugin does not take a step, for example because it failed to load, the Haiku stand-in answers with one short error message.

The "What's contributing to your limits usage?" estimate under `/cost` is computed from local transcripts. It counts codex's tokens, which the plugin records on the subagent's messages so monitors can show them, as subagent usage. Your actual limits, the 5-hour and weekly percentages, come from the server and are not affected.

## Security

Read this before running codex with broad permissions:

- **Codex acts outside Claude's permission system.** Codex works with its own tools: shell, apply_patch, and its own MCP servers and skills. Claude's permission rules and hooks such as PreToolUse do not apply to these actions. Only codex's sandbox and approval settings limit them.
- **The sandbox follows Claude by default.** With the default `follow-claude`, `bypassPermissions` mode gives codex `danger-full-access`. Set **Codex sandbox** to `workspace-write` or `read-only` to cap it whatever Claude's mode is. A `@codex sandbox=` directive can only tighten the cap.
- **The mirrored tool calls are records, not actions.** The Bash / Edit / Write calls in the transcript already ran in codex, so allow or deny rules on them do not stop anything.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Known limitations

- The only Claude capability codex can use is `send_message`, which maps to a native subagent's SendMessage. Native subagents have no ListAgents either.
- Codex's web searches, MCP calls and plan updates have no matching Claude tool, so they appear as one line of text.
- `isolation: "remote"` does not work: remote sessions do not load local plugins.
- When a codex turn itself fails (for example out of quota, or a model error), the report says why, but monitoring mods show the subagent as finished rather than failed. The mod API has no way yet to end a subagent with an error.
- Codex reads and searches files through the shell. Those show as `Bash`, not `Read` or `Grep`, so monitoring mods list only the files codex changed.
- Both the mod API and the `codex app-server` protocol are still changing. If something breaks after upgrading Claude Code or codex, run `claude plugin validate .` and the tests first, then [open an issue](https://github.com/jialelin2007/claude-codex-bridge/issues/new/choose).

## Development

Load the plugin from a checkout instead of the marketplace:

```sh
git clone https://github.com/jialelin2007/claude-codex-bridge
claude --plugin-dir ./claude-codex-bridge
```

Check and test it. There is no build step or `npm install`; Claude Code runs the TypeScript hooks directly.

```sh
claude plugin validate .      # check the manifests and the hooks module
claude plugin test .          # run hooks/lib/*.test.ts
node --check bin/codex-agent.mjs
```

Layout:

| Path | What it does |
|---|---|
| `hooks/register.ts` | Hook wiring: registers the agent type and `/codex`. It handles the `turn.step` takeover, answers mirrored tool calls (`tool.call`), delivers messages (`session.send`) and collects spawn options (`agent.spawn`) |
| `hooks/lib/policy.ts` | The `@codex` directive, session names, settings precedence and permission mapping |
| `hooks/lib/step.ts` | Decides the next step from the subagent's transcript; formats reports |
| `hooks/lib/order.ts` | The plugin order check and the `/codex order` rewrite |
| `hooks/lib/mirror.ts` | Turns codex commands and file changes into Bash / Edit / Write calls and their results |
| `bin/codex-agent.mjs` | Node helper that drives `codex app-server`: `run` / `list` / `config` operations, with `/steer`, `/tool-result` and `/interrupt` on a Unix socket |

## Contributing

Bug reports, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for how to set up, test and send changes, and [CHANGELOG.md](CHANGELOG.md) for what changed in each version. Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © Jiale Lin

This is an independent community project. It is not affiliated with, endorsed by or sponsored by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic; OpenAI and Codex are trademarks of OpenAI.

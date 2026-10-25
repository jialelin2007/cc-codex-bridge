# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The project is open source under the MIT License, as claude-codex-bridge. The plugin keeps the name `codex-bridge`, since Claude Code reserves plugin names starting with `claude-`.
- An English README with a Chinese translation, contribution and security guides, a code of conduct, issue and pull request templates, and CI that validates and tests the plugin.
- `license`, `homepage` and `repository` in the plugin manifest.

## [0.2.3] - 2026-10-20

### Fixed

- Some long commands appeared twice, the second time empty. This happened when a code-mode script started a command with `yield_time_ms` and returned while it still ran. A command now counts as reported from its start.

## [0.2.2] - 2026-10-20

### Changed

- A command codex starts appears as a Bash call right away and gets its output when it ends, so the agent view and monitoring mods show what is running and for how long.
- Failed and declined commands answer with the same error a native Bash failure gives.
- Delete and move calls name their paths, and a failed move shows as failed.

### Fixed

- A continuation run keeps usage that was not reported yet.
- If the mirrored tool hooks fail, they refuse the call instead of falling through to Claude Code's own tools.

## [0.2.1] - 2026-10-19

### Added

- A plugin order check, so mods listed after the bridge are reported in `/codex`, since they cannot see codex tool calls.
- `/codex order` moves the bridge last in `enabledPlugins`.

## [0.2.0] - 2026-10-19

### Added

- Codex work is mirrored as native tool calls: commands as Bash, file changes as Edit with a diff, new files as Write.
- Codex can message Claude through a `send_message` tool, which the plugin answers with a real SendMessage from the subagent.
- Messages sent before the first codex turn starts, or after it ends but before the report is delivered, are taken in.
- Code-mode commands that the app server leaves out are recovered from the rollout.

### Changed

- The helper's event stream is read inside each step.
- A SendMessage the bridge makes for codex is allowed past auto mode's classifier, since it is codex's own decision.

## [0.1.0] - 2026-10-19

### Added

- The first release: OpenAI Codex as a native Claude Code subagent. The `turn.step` hook answers the agent's model requests with codex through `codex app-server`.
- The `@codex` directive, with model, name, effort, fast, sandbox and new.
- Named sessions that can be resumed, kept unique across parallel helpers.
- SendMessage steers a running codex turn. TaskStop interrupts it.
- Reports are delivered with or without SubagentHandback.
- The `/codex` command, plugin settings in `/config`, and a marketplace manifest.

[Unreleased]: https://github.com/jialelin2007/claude-codex-bridge/compare/7521856...HEAD
[0.2.3]: https://github.com/jialelin2007/claude-codex-bridge/compare/16d8548...7521856
[0.2.2]: https://github.com/jialelin2007/claude-codex-bridge/compare/52b4d36...16d8548
[0.2.1]: https://github.com/jialelin2007/claude-codex-bridge/compare/d8e292e...52b4d36
[0.2.0]: https://github.com/jialelin2007/claude-codex-bridge/compare/1dd4529...d8e292e
[0.1.0]: https://github.com/jialelin2007/claude-codex-bridge/commits/1dd4529

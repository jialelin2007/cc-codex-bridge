# Contributing

Thanks for helping improve claude-codex-bridge. Bug reports, ideas and pull requests are all welcome, in English or Chinese.

## Reporting a bug

[Open an issue](https://github.com/jialelin2007/claude-codex-bridge/issues/new/choose) using the bug report form. Please include:

- the versions of Claude Code (`claude --version`), codex (`codex --version`), Node.js and the plugin;
- what you asked Claude to do, and what happened instead;
- the output of `/codex`;
- if you can, a debug log (`claude --debug-file <path>`) with secrets removed.

For security problems, do not open an issue; follow [SECURITY.md](SECURITY.md) instead.

## Setting up

You need the same tools as a user: Claude Code 2.1.303 or later, codex CLI 0.163 or later (signed in), and Node.js 18 or later.

```sh
git clone https://github.com/jialelin2007/claude-codex-bridge
cd claude-codex-bridge
claude --plugin-dir .
```

If you also have the plugin installed from the marketplace, disable it while you work on a checkout, so that only one copy registers hooks.

There is no build step and nothing to install. Claude Code runs the TypeScript hooks directly, and the helper in `bin/` is plain Node.js with no dependencies.

## Checks

Run these before you open a pull request. CI runs the same checks:

```sh
claude plugin validate .
claude plugin test .
node --check bin/codex-agent.mjs
```

The unit tests live next to the code they test (`hooks/lib/*.test.ts`). Put new logic that does not need Claude Code or codex in `hooks/lib/` and test it there; keep `hooks/register.ts` to wiring.

The tests cannot cover the parts that talk to a real Claude Code session and a real `codex app-server`. For changes there, also try it by hand in a scratch directory:

1. Start `claude --plugin-dir <checkout>` and ask Claude to run a codex subagent on a small task, in the background.
2. While it runs, send it a message with SendMessage, and check that codex picks it up.
3. Check that the commands and file changes show as Bash / Edit / Write calls, and that the report comes back with its `[codex-bridge]` line.
4. Start another one and stop it with TaskStop.

Say in the pull request what you tried.

## Pull requests

- Keep a pull request to one change, and describe what it fixes or adds and why.
- Match the surrounding code: TypeScript without semicolons, single quotes, two-space indentation, and short comments that explain why rather than what.
- Write commit messages as a short summary in the imperative ("Show codex commands live"), with a body when the reason is not obvious.
- Update both `README.md` and `README.zh-CN.md` when behaviour or settings change.
- Add an entry to `CHANGELOG.md`.

## Releases

The maintainer cuts releases:

1. Bump `version` in `.claude-plugin/plugin.json` and `VERSION` in `bin/codex-agent.mjs`.
2. Move the changelog entries under the new version.
3. After merging, tag the release with `claude plugin tag --push`, which creates `codex-bridge--v<version>`, and publish a GitHub release from the tag.

## Code of Conduct

Everyone taking part in this project is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

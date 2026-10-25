# Security Policy

## Supported versions

Only the latest release gets security fixes. Update with `claude plugin update cc-codex-bridge@cc-codex-bridge`.

## Reporting a vulnerability

Please report vulnerabilities privately through [GitHub's private vulnerability reporting](https://github.com/jialelin2007/cc-codex-bridge/security/advisories/new), not in a public issue.

Include what an attacker could do, the steps to reproduce it, and the versions of the plugin, Claude Code and codex. The maintainer aims to reply within a week. Once a fix is released, the advisory will be published, with credit to you unless you ask otherwise.

## Scope

The plugin connects two agents that can run commands on your machine, so please keep its trust model in mind:

- **In scope:** problems in this plugin's code that let something happen that its settings say should not. Examples:
  - codex gets a wider sandbox or approval policy than the settings and directive allow;
  - another local user can reach or drive the helper's control socket (under `$XDG_RUNTIME_DIR/cc-codex-bridge/`, or `/tmp/cc-codex-bridge/` without it);
  - the plugin's own handling of transcripts, rollouts or settings leaks or corrupts data.
- **Out of scope:** behaviour that is documented and works as intended. Examples:
  - codex's actions not being covered by Claude's permission rules or PreToolUse hooks;
  - `bypassPermissions` giving codex `danger-full-access` under the default `follow-claude` setting;
  - what codex or Claude decides to do inside the sandbox it was given.

See the [Security section of the README](README.md#security) for that model. Report vulnerabilities in Claude Code itself to Anthropic, and those in codex to OpenAI.

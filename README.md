# flowai-workflow — Claude Code / Codex plugin marketplace

This repository is the public plugin marketplace for
[`flowai-workflow`](https://github.com/korchasa/flowai-workflow), a
domain-agnostic DAG engine for orchestrating AI agents. Workflows are
declared in YAML; the engine handles execution, inter-agent
communication, validation, loops, resume, and HITL.

> **Read-only mirror.** Source of truth is the engine repo
> [`korchasa/flowai-workflow`](https://github.com/korchasa/flowai-workflow).
> This repo is rebuilt and force-overwritten on every `v*` tag of the
> engine — open issues and PRs there, not here.

## Prerequisite

[Deno](https://deno.com/) 2.x on `$PATH`. The plugin bundles the engine
TypeScript source; the host runs it via local Deno.

## Install

### Claude Code

```
/plugin marketplace add korchasa/flowai-workflow-plugins
/plugin install flowai-workflow@flowai-workflow
```

### Codex

```
codex plugin marketplace add korchasa/flowai-workflow-plugins
codex plugin install flowai-workflow@flowai-workflow
```

No `~/.codex/config.toml` `[mcp_servers.*]` block is required —
`flowai-workflow` is not an MCP server, so the plugin manager wires the
launcher skills directly.

## What's installed

Skills invocable from inside the IDE:

- `/flowai-workflow:run <workflow>` — execute a bundled or project-local
  DAG. Forwards `--prompt`, `--dry-run`, `--cycles`, `-v` / `-s` / `-q`,
  `--resume <run-id>`, etc.
- `/flowai-workflow:init [<workflow>|--list]` — scaffold a bundled
  workflow into the current project under `.flowai-workflow/<name>/`.
- `/flowai-workflow:scaffold` — adapt or wire up an existing
  `.flowai-workflow/<name>` (validate `workflow.yaml`, fix agent
  prompts/scripts).
- `/flowai-workflow:supervise` — live supervisor for a single in-flight
  run; resumes after failure, patches root causes from run artefacts.
- `/flowai-workflow:orchestrate` — long-cycle policy loop that picks
  the next workflow per `ORCHESTRATION.md`.

Bundled workflows (under `$CLAUDE_PLUGIN_ROOT/.flowai-workflow/`,
copyable into your project via `/flowai-workflow:init`):

- `github-inbox` — GitHub Issue → PR pipeline driven by Claude Code.
- `github-inbox-opencode` — same pipeline on OpenCode + GLM-4.7.
- `github-inbox-opencode-test` — smoke variant.
- `autonomous-sdlc` — fully local pipeline (no PR, no `gh`), PM
  generates and scores tasks autonomously.

## Quick start

After install, in Claude Code or Codex:

```
/flowai-workflow:init github-inbox
/flowai-workflow:run github-inbox --prompt "implement issue #42"
```

The first command copies `github-inbox/` into your project; the second
launches the pipeline against it.

## Layout

```
.claude-plugin/marketplace.json     <- marketplace manifest
plugins/flowai-workflow/
  .claude-plugin/plugin.json
  skills/                            <- launcher skills (run, init, scaffold, ...)
  agents/                            <- supervisor, orchestrator
  engine/                            <- bundled engine TypeScript
  .flowai-workflow/<name>/           <- bundled workflows
```

`$CLAUDE_PLUGIN_ROOT/engine/cli.ts` is the engine entry point that the
launcher skills invoke. Don't edit files here — they're regenerated on
every release.

## Versioning

The plugin version tracks the engine `deno.json#version` exactly. Every
sync produces a matching `vX.Y.Z` tag in this repo.

## Links

- Source / docs / issues: <https://github.com/korchasa/flowai-workflow>
- Latest release: <https://github.com/korchasa/flowai-workflow-plugins/releases/latest>

## License

MIT.

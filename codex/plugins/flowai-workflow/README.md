# flowai-workflow plugin

Shared skills, agents, and bundled workflows for the host-specific
Claude Code and Codex plugin payloads.

## Skills

- `run` — execute a bundled or project-local DAG.
- `init` — copy a bundled workflow into the current project.
- `scaffold` — adapt a `.flowai-workflow/<name>` folder.
- `supervise` — monitor and resume one live run.
- `orchestrate` — execute the long-cycle workflow policy loop.

## Runtime

The `flowai-workflow` binary is a plugin precondition (FR-E78). The
plugin's `.mcp.json` invokes `flowai-workflow mcp` directly; skills
shell out to `flowai-workflow run` / `flowai-workflow init`. Install
the binary from a GitHub release asset (`sha256` sidecar provided)
or via `deno install -A jsr:@korchasa/flowai-workflow`.

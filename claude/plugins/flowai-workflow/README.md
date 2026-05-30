# flowai-workflow plugin

Shared skills, agents, launcher, engine sources, and bundled workflows
for the host-specific Claude Code and Codex plugin payloads.

## Skills

- `run` — execute a bundled or project-local DAG.
- `init` — copy a bundled workflow into the current project.
- `scaffold` — adapt a `.flowai-workflow/<name>` folder.
- `supervise` — monitor and resume one live run.
- `orchestrate` — execute the long-cycle workflow policy loop.

## Runtime

`bin/launch.ts` is the plugin entry point. It resolves the plugin root
from host environment when present, otherwise from its own `import.meta.url`.
On first invocation it compiles `engine/cli.ts` into a host data
directory; later invocations reuse the cached binary.

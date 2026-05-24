---
name: run
description: Execute a bundled or project-local flowai-workflow DAG. Use to launch a workflow run from inside Claude Code without installing the CLI separately.
argument-hint: workflow name or path (e.g. github-inbox or .flowai-workflow/<name>)
effort: low
---

# Run flowai-workflow

Execute a flowai-workflow DAG via the plugin-bundled engine. The plugin
ships the engine TypeScript source under `$CLAUDE_PLUGIN_ROOT/engine/`
and the canonical bundled workflows under
`$CLAUDE_PLUGIN_ROOT/.flowai-workflow/<name>/`. Runs use the host's
locally-installed Deno 2.x.

## Preflight

Before launching, verify Deno is on PATH:

```bash
command -v deno >/dev/null 2>&1 || { echo "Error: Deno 2.x is required — install from https://deno.com/ then retry." >&2; exit 127; }
```

If Deno is missing, stop and report the install link. Do not silently
fall back to a different runtime or skip the run.

## Resolve the workflow

The first positional argument names the workflow. Resolve it in this
order:

1. If the argument is an existing directory containing `workflow.yaml`,
   use it as-is.
2. If the argument matches a sibling under
   `$CLAUDE_PLUGIN_ROOT/.flowai-workflow/`, use that bundled folder.
3. If the argument matches a sibling under
   `<project-root>/.flowai-workflow/`, use the project-local copy.
4. Otherwise, list available workflows and ask the user which one to
   run.

## Launch

```bash
FLOWAI_SUPPRESS_DEPRECATION=1 \
  deno run -A "$CLAUDE_PLUGIN_ROOT/engine/cli.ts" run "<resolved-workflow-path>" [extra args]
```

`FLOWAI_SUPPRESS_DEPRECATION=1` silences the legacy JSR/binary
deprecation banner — irrelevant inside the plugin install.

Forward any additional CLI flags the user provides (e.g. `--prompt`,
`--dry-run`, `--cycles`). Stream output back to the user in normal
verbosity unless they asked for `-v` / `-q`.

## Common flags

- `--prompt "<text>"` — extra context for the PM agent
- `--resume <run-id>` — resume a previous run
- `--dry-run` — print the execution plan without running
- `-v` / `-s` / `-q` — verbose / semi-verbose / quiet
- `--cycles <N>` — repeat the run N times sequentially

## Errors

- "Missing workflow.yaml" → the resolved path is wrong; list candidates
  again and re-prompt.
- "Workflow validation failed" → surface the engine's error verbatim;
  point the user at `scaffold` to adapt the config.
- "Permission denied: …" — the engine writes under
  `<workflow>/runs/<run-id>/` and the per-run worktree; if the
  workflow lives under `$CLAUDE_PLUGIN_ROOT/.flowai-workflow/` (which
  is read-only by convention), instruct the user to first
  `flowai-workflow:init` into their project so runs can write into
  the project-local copy.

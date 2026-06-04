---
name: run
description: Execute a bundled or project-local flowai-workflow DAG. Use to launch a workflow run from inside the host IDE.
argument-hint: workflow name or path (e.g. github-inbox or .flowai-workflow/<name>)
effort: low
---

# Run flowai-workflow

Execute a flowai-workflow DAG via the `flowai-workflow` engine binary
(plugin precondition — FR-E78). The binary itself bundles the canonical
workflows; the operator may also adapt a project-local copy under
`<project-root>/.flowai-workflow/<name>/`.

## Preflight

Before launching, verify the engine is on PATH:

```bash
command -v flowai-workflow >/dev/null 2>&1 || { echo "Error: flowai-workflow is required — see https://github.com/korchasa/flowai-workflow#install" >&2; exit 127; }
```

If the binary is missing, stop and surface the install link. Do not
silently fall back to a different runtime.

## Resolve the workflow

The first positional argument names the workflow. Resolve it in this
order:

1. If the argument is an existing directory containing `workflow.yaml`,
   use it as-is.
2. If the argument matches a sibling under
   `<project-root>/.flowai-workflow/`, use the project-local copy.
3. Otherwise, treat the argument as a bundled workflow name and rely on
   the engine's built-in catalogue (see `flowai-workflow init --list`).
4. If none of the above resolves, list available workflows and ask the
   user which one to run.

## Launch

```bash
flowai-workflow run "<resolved-workflow-path>" [extra args]
```

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
  workflow lives in a read-only location, instruct the user to first
  `/flowai-workflow:init` into their project so runs can write into
  the project-local copy.

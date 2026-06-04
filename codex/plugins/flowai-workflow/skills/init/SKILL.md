---
name: init
description: Copy a bundled flowai-workflow into the user's project so they can adapt and run it locally. Use when the user wants to start using flowai-workflow in a new repo.
argument-hint: workflow name (default github-inbox) or --list
effort: low
---

# Init a flowai-workflow into the user's project

Copy one of the engine-bundled workflows into the user's current
project at `<project-root>/.flowai-workflow/<name>/`. Adaptation
(project-specific commands, paths, prompts) happens after copy via
the `scaffold` skill — `init` itself is a verbatim copy.

The `flowai-workflow` binary is a plugin precondition (FR-E78) and
embeds the canonical workflow catalogue at compile time.

## Preflight

```bash
command -v flowai-workflow >/dev/null 2>&1 || { echo "Error: flowai-workflow is required — see https://github.com/korchasa/flowai-workflow#install" >&2; exit 127; }
```

## List bundled workflows

```bash
flowai-workflow init --list
```

This enumerates the workflows shipped in the binary. Pick one by
intent (issue-driven SDLC → `github-inbox`; autonomous local SDLC →
`autonomous-sdlc`; smoke check → `github-inbox-opencode-test`).

## Scaffold into the project

```bash
flowai-workflow init --workflow <name>
```

Add `--dry-run` first when the user wants to preview writes.

The scaffold lands under `<cwd>/.flowai-workflow/<name>/`. After it
completes, hand off to the `scaffold` skill to adapt placeholders and
project-specific commands.

## Follow-up

`init` is a copy operation, not a completion. Always remind the user:

1. The copied workflow needs project-specific adaptation (commands,
   secrets, paths) — run `/flowai-workflow:scaffold <name>` next.
2. To execute the workflow, use `/flowai-workflow:run
   .flowai-workflow/<name>` from the project root.

---
name: supervise
description: Live flowai-workflow run supervisor. Use only for requests to run, monitor, continue, or resume a current workflow now. Exclude last-night, finished, post-mortem, root-cause-report, and conceptual questions.
argument-hint: workflow folder path (e.g., .flowai-workflow/github-inbox)
effort: high
---

# Supervised Workflow Run Entry

Drive one `flowai-workflow` run to a clear terminal state by delegating the run
to `supervisor`.

## Delegate

Launch `supervisor` with the host's real subagent mechanism:

- Claude Code: use the `Agent` / `Task` tool with
  `subagent_type=supervisor`;
- OpenCode: use the `@supervisor <task prompt>` mention
  syntax.
- Codex: spawn a native `worker` subagent (the parent dispatches; Codex
  `max_depth=1` forbids nested spawns) and instruct it — by skill name — to
  invoke the `supervisor` skill and return the `SUPERVISOR_REPORT` block as
  its final message. The worker, not the parent, reads all run artifacts.

Pass:

- workflow folder path;
- run id or `--resume <run-id>`, if the user provided one;
- requested polling cadence or stop limit, if provided;
- the user's exact supervision goal.

Ask the supervisor to return only a concise stop report: workflow, run id,
final state, failed/stalled node, evidence paths read, fix surface, resume
command, and remaining blocker.

If the host has neither a native subagent mechanism (Claude `subagent_type`,
OpenCode `@mention`) nor Codex-style `worker` dispatch, say that
context-isolated supervision is unavailable in this IDE and stop. Do not
silently run the full diagnosis loop in the parent context. Do not simulate
delegation with `bash`, `echo`, heredocs, or placeholder text.

## Parent Boundaries

The parent session may locate the requested workflow folder, but must not:

- choose among multiple workflows without the user naming one;
- read `.flowai-workflow/ORCHESTRATION.md`;
- interpret orchestration policy;
- diagnose node artifacts in the parent context;
- run `flowai-workflow` directly unless the user explicitly rejects subagent
  delegation and asks for inline supervision.

## Out of Scope

- Workflow policy loops -> use `orchestrate`.
- First-time workflow creation or broad adaptation -> use `scaffold`.
- Post-mortem of a completed run without intent to resume -> use an
  investigation workflow.
- Editing the flowai-workflow engine source unless the user explicitly asks.

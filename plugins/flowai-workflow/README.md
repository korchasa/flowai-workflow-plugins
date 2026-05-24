# flowai-workflow — Claude Code plugin

Skills and agents for driving [`flowai-workflow`](https://github.com/korchasa/flowai-workflow) — a DAG-based engine for orchestrating AI agents — from inside Claude Code.

## Install

Automatic local install from a checkout of this repository:

```shell
deno task sync-claude-plugin
```

The task re-points the `flowai-workflow-local` marketplace at
`./claude-plugin` and installs (or updates) the plugin at user scope. Re-run
after editing any skill or agent — Claude Code picks up the new content on
the next session.

Manual equivalent:

```shell
claude plugin marketplace add ./claude-plugin
claude plugin install flowai-workflow@flowai-workflow-local --scope user
```

## Skills

- `scaffold` — set up or adapt a `flowai-workflow` DAG in a project (workflow.yaml, agents, scripts).
- `supervise` — drive a single live run to a terminal state; diagnose, fix, resume.
- `orchestrate` — run the policy loop that selects which workflow to execute next.

## Agents

- `orchestrator` — long-cycle policy executor; chooses the next workflow from `ORCHESTRATION.md` and delegates to `supervisor`.
- `supervisor` — owns one run; resumes after failure, patches root causes from run artifacts.

## Layout

```
claude-plugin/
  .claude-plugin/marketplace.json     <- single-plugin local marketplace
  plugins/flowai-workflow/
    .claude-plugin/plugin.json
    skills/
      scaffold/    SKILL.md + references/
      supervise/   SKILL.md
      orchestrate/ SKILL.md
    agents/
      orchestrator.md
      supervisor.md
```

## Source

Skill and agent contents are mirrored from the [`flowai`](https://github.com/korchasa/flowai) framework (`framework/workflow/`). Two normalizations are applied for the Claude Code runtime:

- OpenCode-only frontmatter keys removed (`mode`, `opencode_tools`).
- Flowai model tier `smart` mapped to Claude `sonnet`.

## License

MIT.

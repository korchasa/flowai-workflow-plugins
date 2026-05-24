# Reflection Protocol — Two-Layer Agent Memory

All workflow agents follow this two-layer reflection protocol to accumulate
operative knowledge across runs.

## Layer 1: MEMORY (Edit-in-place)

**Path:** `.flowai-workflow/memory/<agent>.md`
**Format:** Full-snapshot rewrite. ≤50 lines. Categories:

- **Anti-patterns:** recurring mistakes encountered this run.
- **Effective strategies:** approaches that worked well.
- **Environment quirks:** tool behaviors, edge cases, gotchas.
- **Baseline metrics:** turns, cost, time vs prior baseline.

**Rules:**

- Rewrite entire file at session end (not append).
- Keep compressed — no fluff, high-info density.
- Prioritize lessons from the current run; prune stale entries.

## Layer 2: HISTORY (Append-only log)

**Path:** `.flowai-workflow/memory/<agent>-history.md`
**Format:** One entry per run appended at session end:

```
## Run <timestamp>

- Issue: #<N>
- Turns: <N>
- Cost: $<X.XX>
- Outcome: PASS | FAIL
- Key learnings: <1-3 bullet points>
```

**Rules:**

- Append only — never edit existing entries.
- Keep ≤20 most recent entries (FIFO trim: remove oldest when >20).

## Lifecycle (per agent session)

1. **Session start:** Read MEMORY + HISTORY files (both, in parallel).
2. **Execute task** per agent-specific responsibilities.
3. **Session end:**
   a. Append one entry to HISTORY (≤20 entries total, trim if needed).
   b. Rewrite MEMORY with current-state snapshot (≤50 lines).
   c. **Commit MEMORY + HISTORY files** in the worktree before exiting the
      session. Use a focused commit (`git add` only the memory/history
      paths) with a `chore(memory):` or scope-appropriate prefix. Skipping
      this step means the reflection is lost on worktree teardown.
      **Per-agent override:** loop-body agents (e.g. `build`) may set
      `memory_commit_deferred: true` in `workflow.yaml`, which tells the
      engine NOT to fail the node when memory is left dirty. Use only
      when the agent will commit in a subsequent iteration.

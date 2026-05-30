#!/usr/bin/env bash
set -euo pipefail

# rollback-uncommitted.sh — Rollback staged and unstaged modifications.
# Does NOT run git clean — preserves untracked files.
# Used as on_failure_script in workflow.yaml.

git reset HEAD
git checkout -- .

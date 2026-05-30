/**
 * @module
 * Shared types for the init scaffolder. The scaffolder is now a pure
 * verbatim-copy operation: no wizard answers, no placeholder substitution,
 * no autodetection. Project-specific configuration is delegated to the
 * agents themselves at first run via prompt.
 */

/** Names of workflow folders shipped under `<package-root>/.flowai-workflow/`. */
export type WorkflowName = string;

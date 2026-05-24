/**
 * @module
 * Barrel re-export for `deno doc --lint` entry point. Not imported by runtime code.
 */

export type {
  AttemptJournalEvent,
  CliRunOutput,
  EngineOptions,
  ErrorCategory,
  HitlConfig,
  HumanInputOption,
  HumanInputRequest,
  LoopIterationJournalEvent,
  NodeBudget,
  NodeConfig,
  NodeDeclaredJournalEvent,
  NodeDirectoryDeclaredJournalEvent,
  NodeLifecycleCallback,
  NodeLifecycleEvent,
  NodeLifecycleJournalEvent,
  NodeLifecycleMetadata,
  NodeSettings,
  NodeState,
  NodeStatus,
  PermissionDenial,
  PermissionMode,
  ReasoningEffort,
  RunJournalEvent,
  RunJournalEventBase,
  RunJournalEventKind,
  RunJournalReplayResult,
  RunMetadataUpdatedJournalEvent,
  RunStartedJournalEvent,
  RunState,
  RunTerminalJournalEvent,
  RuntimeId,
  TemplateContext,
  ValidationRule,
  Verbosity,
  WorkflowConfig,
  WorkflowDefaults,
  WorkflowLoadedJournalEvent,
} from "./types.ts";
export { REASONING_EFFORT_VALUES } from "./types.ts";

export { interpolate } from "./template.ts";
export {
  DEFAULT_SETTINGS,
  extractWorktreeDisabled,
  loadConfig,
  parseConfig,
} from "./config.ts";
export { buildLevels, buildLoopBodyOrder } from "./dag.ts";
export type { ExecutionLevels } from "./dag.ts";
export { allPassed, formatFailures, runValidations } from "./validate.ts";
export type { ValidationResult } from "./validate.ts";
export {
  createRunState,
  generateRunId,
  getJournalFilePath,
  getNodeDir,
  getRunDir,
  PhaseRegistry,
} from "./state.ts";
export {
  getJournalPath,
  loadStateFromJournal,
  replayRunJournal,
  resultExcerpt,
  RunJournalWriter,
} from "./run-journal.ts";
export type { NewRunJournalEvent } from "./run-journal.ts";
export { installSignalHandlers, ProcessRegistry } from "./process-registry.ts";
export { runAgent } from "./agent.ts";
export type { AgentResult, AgentRunOptions } from "./agent.ts";
// Runtime adapter types re-exported from @korchasa/ai-ide-cli so engine's
// public AgentRunOptions / HitlRunOptions / ClaudeRunner remain self-contained
// from deno doc --lint's point of view.
export type {
  ExtraArgsMap,
  InteractiveOptions,
  InteractiveResult,
  OnRuntimeToolUseObservedCallback,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeInitInfo,
  RuntimeInvokeOptions,
  RuntimeInvokeResult,
  RuntimeLifecycleHooks,
  RuntimeSession,
  RuntimeSessionEvent,
  RuntimeSessionOptions,
  RuntimeSessionStatus,
  RuntimeToolUseDecision,
  RuntimeToolUseInfo,
} from "@korchasa/ai-ide-cli/runtime/types";
export type { SettingSource } from "@korchasa/ai-ide-cli/runtime/setting-sources";
export type {
  CapabilityInventory,
  CapabilityRef,
  FetchCapabilitiesOptions,
} from "@korchasa/ai-ide-cli/runtime/capabilities";
export type { SkillDef, SkillFrontmatter } from "@korchasa/ai-ide-cli/skill";
export { isHitlConfigured, runHitlLoop } from "./hitl.ts";
export type {
  ClaudeRunner,
  HitlQuestion,
  HitlRunOptions,
  ScriptRunner,
} from "./hitl.ts";
export { markNodeWaiting } from "./state.ts";
export { saveAgentLog } from "./log.ts";
export { extractFrontmatterField, runLoop } from "./loop.ts";
export type { LoopExitReason, LoopResult, LoopRunOptions } from "./loop.ts";
export { runHuman } from "./human.ts";
export type { HumanResult, UserInput } from "./human.ts";
export { OutputManager } from "./output.ts";
export type {
  RunSummary,
  VerboseInput,
  VerboseValidationResult,
} from "./output.ts";
export { Engine } from "./engine.ts";
export { buildUpdateCommand, checkForUpdate, VERSION } from "./version.ts";
export type { CheckForUpdateOptions, VersionCheckResult } from "./version.ts";
export { extractCliFlags, getVersionString, parseArgs } from "./cli.ts";
export type { CliFlags } from "./cli.ts";
export { applyJsonPointerOp, runMcpServer } from "./mcp-server.ts";
export type { JsonPointerOp, RunMcpServerOptions } from "./mcp-server.ts";

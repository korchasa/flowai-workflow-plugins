/**
 * @module
 * Workflow config loading, schema validation, and default merging.
 * Entry points: {@link loadConfig} (file → WorkflowConfig) and
 * {@link parseConfig} (YAML string → WorkflowConfig).
 * Defaults are applied in a 3-tier cascade: hardcoded → workflow-level → node-level.
 */

import { parse as parseYaml } from "@std/yaml";
import { dirname } from "@std/path";
import { resolveRuntimeConfig } from "@korchasa/ai-ide-cli/runtime";
import { validateTemplateVars } from "./template.ts";
import {
  REASONING_EFFORT_VALUES,
  VALID_PERMISSION_MODES,
  VALID_RUNTIME_IDS,
} from "./types.ts";
import type {
  NodeBudget,
  NodeConfig,
  NodeSettings,
  WorkflowConfig,
  WorkflowDefaults,
} from "./types.ts";

/** Default node settings applied when not specified. */
export const DEFAULT_SETTINGS: Required<NodeSettings> = {
  max_continuations: 3,
  timeout_seconds: 1800,
  on_error: "fail",
  max_retries: 3,
  retry_delay_seconds: 5,
};

/** Default workflow-level settings. Fields intentionally excluded from
 * Required<> because undefined carries semantic meaning ("not set"):
 * `permission_mode`, `effort`, `budget`, `allowed_tools`,
 * `disallowed_tools`, `memory_paths`. */
export const DEFAULT_WORKFLOW_DEFAULTS: Required<
  Omit<
    WorkflowDefaults,
    | "permission_mode"
    | "effort"
    | "budget"
    | "allowed_tools"
    | "disallowed_tools"
    | "memory_paths"
  >
> = {
  ...DEFAULT_SETTINGS,
  worktree_disabled: false,
  max_parallel: 0,
  runtime: "claude",
  runtime_args: {},
  model: "",
  hitl: {
    ask_script: "",
    check_script: "",
    poll_interval: 60,
    timeout: 7200,
  },
  on_failure_script: "",
  prepare_command: "",
};

/**
 * Extract only `worktree_disabled` from YAML without full config parsing.
 * Used for two-phase loading: check worktree_disabled → create worktree → load full config from worktree.
 */
export function extractWorktreeDisabled(yaml: string): boolean {
  const raw = parseYaml(yaml);
  if (!raw || typeof raw !== "object") return false;
  const config = raw as Record<string, unknown>;
  if (!config.defaults || typeof config.defaults !== "object") return false;
  const defaults = config.defaults as Record<string, unknown>;
  return defaults.worktree_disabled === true;
}

/** Parse YAML string into WorkflowConfig, validate schema, merge defaults.
 * @param workDir — base directory for resolving {{file()}} references.
 * @param workflowDir — workDir-relative directory containing the workflow.yaml,
 *   used for resolving {{flow_file()}} references. Defaults to "" (workDir root). */
export function parseConfig(
  yaml: string,
  workDir?: string,
  workflowDir?: string,
): WorkflowConfig {
  const raw = parseYaml(yaml);
  if (!raw || typeof raw !== "object") {
    throw new Error("Workflow config must be a YAML object");
  }
  const config = raw as Record<string, unknown>;
  validateSchema(config);
  return mergeDefaults(
    config as unknown as WorkflowConfig,
    workDir,
    workflowDir,
  );
}

/** Load and parse workflow config from a file path.
 * @param workDir — base directory for resolving {{file()}} references.
 *   `{{flow_file()}}` references resolve against `workDir/dirname(path)`. */
export async function loadConfig(
  path: string,
  workDir?: string,
): Promise<WorkflowConfig> {
  const yaml = await Deno.readTextFile(path);
  const wfDir = workflowDirFromConfigPath(path, workDir);
  return parseConfig(yaml, workDir, wfDir);
}

/** Compute the workDir-relative workflow directory from a (possibly
 * workDir-prefixed) config path. Returns "" when the config sits at workDir
 * root. Strips the leading workDir prefix when present so the result is
 * always workDir-relative — matching the contract on TemplateContext. */
function workflowDirFromConfigPath(
  configPath: string,
  workDir?: string,
): string {
  let p = configPath;
  if (workDir && workDir !== "." && p.startsWith(`${workDir}/`)) {
    p = p.slice(workDir.length + 1);
  }
  const d = dirname(p);
  return d === "." || d === "/" ? "" : d;
}

/** Validate required fields and node type constraints. */
function validateSchema(config: Record<string, unknown>): void {
  // Reject removed pre_run field with migration message
  if ("pre_run" in config) {
    throw new Error(
      "pre_run removed; worktree isolation replaces it. Set defaults.worktree_disabled: true to opt out.",
    );
  }
  if (typeof config.name !== "string" || !config.name) {
    throw new Error("Workflow config requires a non-empty 'name' field");
  }
  if (config.version !== "1") {
    throw new Error(
      `Unsupported workflow config version: ${config.version}. Expected "1"`,
    );
  }
  if (
    !config.nodes || typeof config.nodes !== "object" ||
    Array.isArray(config.nodes)
  ) {
    throw new Error("Workflow config requires a 'nodes' object");
  }

  const nodes = config.nodes as Record<string, unknown>;
  const nodeIds = Object.keys(nodes);

  if (nodeIds.length === 0) {
    throw new Error("Workflow config must have at least one node");
  }

  for (const [id, rawNode] of Object.entries(nodes)) {
    if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) {
      throw new Error(`Node '${id}' must be an object`);
    }
    const node = rawNode as Record<string, unknown>;
    validateNode(id, node, nodeIds);
  }

  // Validate phases if present
  if (config.phases) {
    if (typeof config.phases !== "object" || Array.isArray(config.phases)) {
      throw new Error(
        "'phases' must be an object mapping phase names to node arrays",
      );
    }
    const phases = config.phases as Record<string, unknown>;
    const seenNodes = new Map<string, string>(); // nodeId → phaseName
    for (const [phaseName, phaseNodes] of Object.entries(phases)) {
      if (!Array.isArray(phaseNodes)) {
        throw new Error(`Phase '${phaseName}' must be an array of node IDs`);
      }
      for (const nodeId of phaseNodes) {
        if (!nodeIds.includes(nodeId as string)) {
          throw new Error(
            `Phase '${phaseName}' references unknown node '${nodeId}'`,
          );
        }
        const existing = seenNodes.get(nodeId as string);
        if (existing) {
          throw new Error(
            `Node '${nodeId}' appears in multiple phases: '${existing}' and '${phaseName}'`,
          );
        }
        seenNodes.set(nodeId as string, phaseName);
      }
    }
  }

  // Validate defaults.permission_mode if present
  if (config.defaults && typeof config.defaults === "object") {
    const defaults = config.defaults as Record<string, unknown>;
    if (
      defaults.runtime !== undefined &&
      !VALID_RUNTIME_IDS.includes(defaults.runtime as "claude" | "opencode")
    ) {
      throw new Error(
        `defaults.runtime has invalid value '${defaults.runtime}'. Must be one of: ${
          VALID_RUNTIME_IDS.join(", ")
        }`,
      );
    }
    if (defaults.runtime_args !== undefined) {
      validateRuntimeArgs("defaults", defaults.runtime_args);
    }
    if (defaults.hitl !== undefined) {
      validateHitlConfig(defaults.hitl);
    }
    if (defaults.permission_mode !== undefined) {
      if (
        !VALID_PERMISSION_MODES.includes(defaults.permission_mode as string)
      ) {
        throw new Error(
          `defaults.permission_mode has invalid value '${defaults.permission_mode}'. Must be one of: ${
            VALID_PERMISSION_MODES.join(", ")
          }`,
        );
      }
    }
    // FR-E42: validate defaults.effort enum
    if (defaults.effort !== undefined) {
      if (
        !REASONING_EFFORT_VALUES.includes(
          defaults.effort as typeof REASONING_EFFORT_VALUES[number],
        )
      ) {
        throw new Error(
          `defaults.effort has invalid value '${defaults.effort}'. Must be one of: ${
            REASONING_EFFORT_VALUES.join(", ")
          }`,
        );
      }
    }
    if (defaults.budget !== undefined) {
      validateBudget("defaults", defaults.budget);
    }
    validateToolFilterLevel("defaults", defaults);

    // Validate memory_paths if present (FR-S28)
    if (defaults.memory_paths !== undefined) {
      if (!Array.isArray(defaults.memory_paths)) {
        throw new Error(
          `defaults.memory_paths must be an array of glob strings`,
        );
      }
      for (const pat of defaults.memory_paths) {
        if (typeof pat !== "string" || pat.length === 0) {
          throw new Error(
            `defaults.memory_paths entries must be non-empty strings`,
          );
        }
      }
    }
  }

  // Validate mutual exclusivity: phases block and per-node phase field cannot coexist
  if (config.phases) {
    const nodesWithPhaseField: string[] = [];
    for (const [nid, rawNode] of Object.entries(nodes)) {
      if ((rawNode as Record<string, unknown>).phase !== undefined) {
        nodesWithPhaseField.push(nid);
      }
    }
    if (nodesWithPhaseField.length > 0) {
      throw new Error(
        `Phase assignment conflict: top-level 'phases:' block and per-node 'phase:' field cannot coexist. ` +
          `Affected node(s): ${
            nodesWithPhaseField.join(", ")
          }. Use one mechanism only.`,
      );
    }
  }
}

/**
 * Validate a single node's required fields and type-specific constraints.
 *
 * Why recursive with widened ID set: loop body nodes may reference each other
 * (for intra-body ordering) in addition to top-level nodes. When we recurse
 * into loop body nodes we pass `[...allNodeIds, ...bodyNodeIds]` so that
 * inputs can resolve against both namespaces. Passing only `allNodeIds` would
 * falsely reject valid body-node cross-references.
 */
function validateNode(
  id: string,
  node: Record<string, unknown>,
  allNodeIds: string[],
): void {
  const validTypes = ["agent", "merge", "loop", "human"];
  if (!validTypes.includes(node.type as string)) {
    throw new Error(
      `Node '${id}' has invalid type '${node.type}'. Must be one of: ${
        validTypes.join(", ")
      }`,
    );
  }

  if (typeof node.label !== "string" || !node.label) {
    throw new Error(`Node '${id}' requires a non-empty 'label' field`);
  }

  // Validate inputs reference existing nodes
  if (node.inputs) {
    if (!Array.isArray(node.inputs)) {
      throw new Error(`Node '${id}' inputs must be an array`);
    }
    for (const inputId of node.inputs) {
      if (typeof inputId !== "string") {
        throw new Error(`Node '${id}' inputs must be strings`);
      }
      if (!allNodeIds.includes(inputId)) {
        throw new Error(
          `Node '${id}' references unknown input node '${inputId}'`,
        );
      }
      if (inputId === id) {
        throw new Error(`Node '${id}' cannot reference itself as input`);
      }
    }
  }

  // Type-specific validation
  const type = node.type as string;

  if (type === "agent") {
    if (!node.prompt) {
      throw new Error(
        `Agent node '${id}' requires a 'prompt' field`,
      );
    }
  }

  if (type === "loop") {
    if (
      !node.nodes || typeof node.nodes !== "object" ||
      Array.isArray(node.nodes) || Object.keys(node.nodes).length === 0
    ) {
      throw new Error(
        `Loop node '${id}' requires a non-empty 'nodes' sub-object`,
      );
    }
    if (typeof node.condition_node !== "string") {
      throw new Error(`Loop node '${id}' requires 'condition_node'`);
    }
    if (typeof node.condition_field !== "string") {
      throw new Error(`Loop node '${id}' requires 'condition_field'`);
    }
    if (typeof node.exit_value !== "string") {
      throw new Error(`Loop node '${id}' requires 'exit_value'`);
    }

    const bodyNodes = node.nodes as Record<string, unknown>;
    const bodyNodeIds = Object.keys(bodyNodes);

    // condition_node must reference a key in nodes
    if (!bodyNodeIds.includes(node.condition_node as string)) {
      throw new Error(
        `Loop node '${id}' condition_node '${node.condition_node}' must be a key in 'nodes'`,
      );
    }

    // Validate body nodes: if >1 entry, at least one must declare inputs referencing another body node
    if (bodyNodeIds.length > 1) {
      let hasInternalInput = false;
      for (const bodyId of bodyNodeIds) {
        const bodyNode = bodyNodes[bodyId] as Record<string, unknown>;
        if (Array.isArray(bodyNode.inputs)) {
          for (const inp of bodyNode.inputs) {
            if (bodyNodeIds.includes(inp as string)) {
              hasInternalInput = true;
            }
          }
        }
      }
      if (!hasInternalInput) {
        throw new Error(
          `Loop node '${id}' has >1 body node: at least one body node must declare 'inputs' referencing another body node for ordering`,
        );
      }
    }

    // Validate each body node (using combined top-level + body node IDs for input resolution)
    const validInputIds = [...allNodeIds, ...bodyNodeIds];
    for (const [bodyId, rawBody] of Object.entries(bodyNodes)) {
      if (
        !rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)
      ) {
        throw new Error(
          `Loop node '${id}' body node '${bodyId}' must be an object`,
        );
      }
      const bodyNode = rawBody as Record<string, unknown>;
      validateNode(bodyId, bodyNode, validInputIds);
    }

    // Validate loop input forwarding (FR-E35): body nodes referencing external inputs
    // must declare those inputs in the enclosing loop node's own inputs list.
    const loopInputs = new Set((node.inputs as string[] | undefined) ?? []);
    for (const [bodyId, rawBody] of Object.entries(bodyNodes)) {
      const bodyNode = rawBody as Record<string, unknown>;
      if (!Array.isArray(bodyNode.inputs)) continue;
      const missing = (bodyNode.inputs as string[]).filter(
        (inp: string) => !bodyNodeIds.includes(inp) && !loopInputs.has(inp),
      );
      if (missing.length > 0) {
        throw new Error(
          `Loop '${id}' body node '${bodyId}' references external input(s) [${
            missing.join(", ")
          }] not listed in loop inputs`,
        );
      }
    }

    // Validate condition_field vs frontmatter_field in condition node (FR-E36):
    // If condition node declares a validate block, it must include a frontmatter_field
    // rule whose 'field' matches condition_field — fail fast on misconfigured workflows.
    // Skip if condition node has no validate block (no contract to enforce).
    const condNodeRaw = bodyNodes[node.condition_node as string] as Record<
      string,
      unknown
    >;
    if (
      Array.isArray(condNodeRaw.validate) && condNodeRaw.validate.length > 0
    ) {
      const rules = condNodeRaw.validate as Array<Record<string, unknown>>;
      const hasMatchingRule = rules.some(
        (r) =>
          r.type === "frontmatter_field" && r.field === node.condition_field,
      );
      if (!hasMatchingRule) {
        throw new Error(
          `Loop '${id}' condition_field '${node.condition_field}' is not declared as a frontmatter_field in condition node '${node.condition_node}' validate block`,
        );
      }
    }
  }

  if (type === "human") {
    if (typeof node.question !== "string" || !node.question) {
      throw new Error(
        `Human node '${id}' requires a non-empty 'question' field`,
      );
    }
  }

  // Validate hook template variables (FR-E7)
  if (typeof node.before === "string" && node.before) {
    const errors = validateTemplateVars(node.before, allNodeIds);
    if (errors.length > 0) {
      throw new Error(
        `Node '${id}' before hook has invalid template variables: ${
          errors.join("; ")
        }`,
      );
    }
  }
  if (typeof node.after === "string" && node.after) {
    const errors = validateTemplateVars(node.after, allNodeIds);
    if (errors.length > 0) {
      throw new Error(
        `Node '${id}' after hook has invalid template variables: ${
          errors.join("; ")
        }`,
      );
    }
  }

  // Validate run_on enum if present
  if (node.run_on !== undefined) {
    const validRunOn = ["always", "success", "failure"];
    if (!validRunOn.includes(node.run_on as string)) {
      throw new Error(
        `Node '${id}' has invalid run_on value '${node.run_on}'. Must be one of: always, success, failure`,
      );
    }
  }

  // Validate settings if present
  if (node.settings) {
    validateSettings(id, node.settings as Record<string, unknown>);
  }

  // Validate validation rules if present
  if (node.validate) {
    if (!Array.isArray(node.validate)) {
      throw new Error(`Node '${id}' validate must be an array`);
    }
    for (const rule of node.validate) {
      validateValidationRule(id, rule as Record<string, unknown>);
    }
  }

  // Validate permission_mode if present
  if (node.permission_mode !== undefined) {
    if (!VALID_PERMISSION_MODES.includes(node.permission_mode as string)) {
      throw new Error(
        `Node '${id}' has invalid permission_mode '${node.permission_mode}'. Must be one of: ${
          VALID_PERMISSION_MODES.join(", ")
        }`,
      );
    }
  }

  // FR-E42: validate node.effort enum
  if (node.effort !== undefined) {
    if (
      !REASONING_EFFORT_VALUES.includes(
        node.effort as typeof REASONING_EFFORT_VALUES[number],
      )
    ) {
      throw new Error(
        `Node '${id}' has invalid effort '${node.effort}'. Must be one of: ${
          REASONING_EFFORT_VALUES.join(", ")
        }`,
      );
    }
  }

  if (node.runtime !== undefined) {
    if (!VALID_RUNTIME_IDS.includes(node.runtime as "claude" | "opencode")) {
      throw new Error(
        `Node '${id}' has invalid runtime '${node.runtime}'. Must be one of: ${
          VALID_RUNTIME_IDS.join(", ")
        }`,
      );
    }
  }

  if (node.runtime_args !== undefined) {
    validateRuntimeArgs(`Node '${id}'`, node.runtime_args);
  }

  // Validate allowed_paths if present (FR-E37)
  if (node.allowed_paths !== undefined) {
    validateAllowedPaths(id, node.allowed_paths);
  }

  // Validate budget if present (FR-E47)
  if (node.budget !== undefined) {
    validateBudget(`Node '${id}'`, node.budget);
  }

  // Validate tool filter fields if present (FR-E48)
  validateToolFilterLevel(`Node '${id}'`, node);

  // Validate memory_commit_deferred if present (FR-S28)
  if (
    node.memory_commit_deferred !== undefined &&
    typeof node.memory_commit_deferred !== "boolean"
  ) {
    throw new Error(
      `Node '${id}' memory_commit_deferred must be a boolean`,
    );
  }
}

function validateSettings(
  nodeId: string,
  settings: Record<string, unknown>,
): void {
  const validKeys = [
    "max_continuations",
    "timeout_seconds",
    "on_error",
    "max_retries",
    "retry_delay_seconds",
  ];
  for (const key of Object.keys(settings)) {
    if (!validKeys.includes(key)) {
      throw new Error(
        `Node '${nodeId}' settings has unknown key '${key}'`,
      );
    }
  }
  if (
    settings.on_error !== undefined &&
    settings.on_error !== "fail" &&
    settings.on_error !== "continue"
  ) {
    throw new Error(
      `Node '${nodeId}' settings.on_error must be "fail" or "continue"`,
    );
  }
}

function validateValidationRule(
  nodeId: string,
  rule: Record<string, unknown>,
): void {
  const validTypes = [
    "file_exists",
    "file_not_empty",
    "contains_section",
    "custom_script",
    "frontmatter_field",
    "artifact",
    "git_worktree_clean",
    "git_default_branch_checked_out",
    "git_no_unpushed_commits",
  ];
  if (!validTypes.includes(rule.type as string)) {
    throw new Error(
      `Node '${nodeId}' validation rule has invalid type '${rule.type}'`,
    );
  }
  if (
    // FR-E67: Git repository-state validation rules are parameterless.
    rule.type === "git_worktree_clean" ||
    rule.type === "git_default_branch_checked_out" ||
    rule.type === "git_no_unpushed_commits"
  ) {
    return;
  }
  if (typeof rule.path !== "string" || !rule.path) {
    throw new Error(
      `Node '${nodeId}' validation rule requires a non-empty 'path'`,
    );
  }
  if (rule.type === "artifact") {
    const hasSections = Array.isArray(rule.sections) &&
      rule.sections.length > 0;
    const hasFields = Array.isArray(rule.fields) &&
      (rule.fields as unknown[]).length > 0;

    if (!hasSections && !hasFields) {
      throw new Error(
        `Node '${nodeId}' artifact rule requires at least one of 'sections' or 'fields'`,
      );
    }

    if (Array.isArray(rule.sections)) {
      if (
        !(rule.sections as unknown[]).every(
          (e: unknown) => typeof e === "string",
        )
      ) {
        throw new Error(
          `Node '${nodeId}' artifact rule 'sections' must be an array of strings`,
        );
      }
    }

    if (Array.isArray(rule.fields)) {
      for (const entry of rule.fields) {
        if (typeof entry !== "string" || !entry) {
          throw new Error(
            `Node '${nodeId}' artifact rule 'fields' must be an array of non-empty strings`,
          );
        }
      }
    }
  }
}

/**
 * Validate the allowed_paths field on a node.
 * Must be an array of non-empty strings (glob patterns).
 * Called from validateNode() when allowed_paths is present (FR-E37).
 */
function validateAllowedPaths(
  nodeId: string,
  allowedPaths: unknown,
): void {
  if (!Array.isArray(allowedPaths)) {
    throw new Error(
      `Node '${nodeId}' allowed_paths must be an array of strings`,
    );
  }
  for (const entry of allowedPaths) {
    if (typeof entry !== "string" || !entry) {
      throw new Error(
        `Node '${nodeId}' allowed_paths entries must be non-empty strings`,
      );
    }
  }
}

/**
 * Validate a budget object (node-level or defaults-level, FR-E47).
 * `max_usd` must be a positive finite number; `max_turns` must be a positive
 * integer. Extra keys are rejected to catch typos early.
 */
function validateBudget(context: string, budget: unknown): void {
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    throw new Error(`${context}.budget must be an object`);
  }
  const b = budget as Record<string, unknown>;
  const validKeys = ["max_usd", "max_turns"];
  for (const key of Object.keys(b)) {
    if (!validKeys.includes(key)) {
      throw new Error(`${context}.budget has unknown key '${key}'`);
    }
  }
  if (b.max_usd !== undefined) {
    if (
      typeof b.max_usd !== "number" || !Number.isFinite(b.max_usd) ||
      b.max_usd <= 0
    ) {
      throw new Error(`${context}.budget.max_usd must be a positive number`);
    }
  }
  if (b.max_turns !== undefined) {
    if (
      typeof b.max_turns !== "number" || !Number.isInteger(b.max_turns) ||
      b.max_turns <= 0
    ) {
      throw new Error(
        `${context}.budget.max_turns must be a positive integer`,
      );
    }
  }
}

/**
 * Resolve effective budget for a node via cascade: node → enclosing loop
 * parent → workflow defaults. First-defined wins at the object level (shallow
 * cascade, same spirit as the `model` field resolution). Returns undefined
 * when no budget is set at any level.
 */
export function resolveBudget(
  node: NodeConfig,
  defaults: WorkflowDefaults | undefined,
  loopParent?: NodeConfig,
): NodeBudget | undefined {
  return node.budget ?? loopParent?.budget ?? defaults?.budget;
}

/** Reserved-keys in `runtime_args` that conflict with typed tool filter fields
 * (FR-E48). Claude CLI and engine own these flags. */
const TOOL_FILTER_RESERVED_KEYS = [
  "--allowedTools",
  "--allowed-tools",
  "--disallowedTools",
  "--disallowed-tools",
  "--tools",
] as const;

/**
 * Validate tool-filter fields at a single cascade level (FR-E48).
 *
 * Three checks:
 * 1. Each field, if present, must be an array of non-empty strings.
 * 2. Fields are mutually exclusive at the same level.
 * 3. If any typed field is set at this level, `runtime_args` of the same
 *    level must not contain any key from {@link TOOL_FILTER_RESERVED_KEYS}.
 *
 * Context string identifies the level in error messages (`defaults`,
 * `Node 'foo'`, etc.).
 */
function validateToolFilterLevel(
  context: string,
  level: Record<string, unknown>,
): void {
  const allowed = level.allowed_tools;
  const disallowed = level.disallowed_tools;

  if (allowed !== undefined) {
    validateToolFilterField(context, "allowed_tools", allowed);
  }
  if (disallowed !== undefined) {
    validateToolFilterField(context, "disallowed_tools", disallowed);
  }
  if (allowed !== undefined && disallowed !== undefined) {
    throw new Error(
      `${context}: allowed_tools and disallowed_tools are mutually exclusive at the same level`,
    );
  }

  const hasTypedField = allowed !== undefined || disallowed !== undefined;
  if (hasTypedField && level.runtime_args !== undefined) {
    const runtimeArgs = level.runtime_args as Record<string, unknown>;
    for (const reserved of TOOL_FILTER_RESERVED_KEYS) {
      if (reserved in runtimeArgs) {
        throw new Error(
          `${context}.runtime_args key '${reserved}' conflicts with typed allowed_tools/disallowed_tools fields — use the typed field exclusively`,
        );
      }
    }
  }
}

function validateToolFilterField(
  context: string,
  fieldName: "allowed_tools" | "disallowed_tools",
  value: unknown,
): void {
  if (!Array.isArray(value)) {
    throw new Error(`${context}.${fieldName} must be an array of strings`);
  }
  for (const entry of value) {
    if (typeof entry !== "string" || !entry) {
      throw new Error(
        `${context}.${fieldName} entries must be non-empty strings`,
      );
    }
  }
}

/** Resolved tool filter for a single node invocation (FR-E48).
 * At most one of the two fields is set (mutex enforced at validation). */
export interface ResolvedToolFilter {
  allowedTools?: string[];
  disallowedTools?: string[];
}

/**
 * Resolve effective tool filter via REPLACE-semantics cascade:
 * node → loopParent → defaults.
 *
 * Unlike {@link resolveRuntimeConfig} which merges `runtime_args` per-key,
 * this resolver picks the FIRST level that declares either `allowed_tools`
 * or `disallowed_tools` and returns only that level's values. Other levels
 * are ignored entirely — this is the "replace" semantics demanded by
 * FR-E48 to keep author intent unambiguous.
 *
 * Contract: caller has already passed the config through
 * {@link validateSchema}, so mutex and reserved-keys constraints hold.
 * The resolver never throws.
 */
export function resolveToolFilter(
  node: NodeConfig,
  defaults: WorkflowDefaults | undefined,
  loopParent?: NodeConfig,
): ResolvedToolFilter {
  const sources: Array<NodeConfig | WorkflowDefaults | undefined> = [
    node,
    loopParent,
    defaults,
  ];
  for (const src of sources) {
    if (!src) continue;
    if (
      src.allowed_tools !== undefined || src.disallowed_tools !== undefined
    ) {
      return {
        allowedTools: src.allowed_tools,
        disallowedTools: src.disallowed_tools,
      };
    }
  }
  return {};
}

function validateRuntimeArgs(
  context: string,
  runtimeArgs: unknown,
): void {
  if (
    !runtimeArgs || typeof runtimeArgs !== "object" ||
    Array.isArray(runtimeArgs)
  ) {
    throw new Error(
      `${context}.runtime_args must be a map (Record<string, string | null>)`,
    );
  }
  for (const [key, value] of Object.entries(runtimeArgs)) {
    if (!key) {
      throw new Error(
        `${context}.runtime_args keys must be non-empty strings`,
      );
    }
    if (value !== null && typeof value !== "string") {
      throw new Error(
        `${context}.runtime_args['${key}'] must be a string or null (null suppresses the flag)`,
      );
    }
  }
}

function validateHitlConfig(hitl: unknown): void {
  if (!hitl || typeof hitl !== "object" || Array.isArray(hitl)) {
    throw new Error("defaults.hitl must be an object");
  }
  const config = hitl as Record<string, unknown>;
  if (typeof config.ask_script !== "string" || !config.ask_script) {
    throw new Error(
      "defaults.hitl.ask_script must be a non-empty string",
    );
  }
  if (typeof config.check_script !== "string" || !config.check_script) {
    throw new Error(
      "defaults.hitl.check_script must be a non-empty string",
    );
  }
}

/**
 * Merge workflow defaults into each node's settings.
 *
 * Why 3-tier cascade: `DEFAULT_SETTINGS` (hardcoded engine fallbacks) →
 * `config.defaults` (workflow-level overrides) → `node.settings` (per-node
 * overrides). Each tier wins over the one before it, so operators can set
 * workflow-wide timeouts without touching every node, and nodes can still
 * override individually.
 *
 * Why `run_always` normalisation: `run_always: true` is a legacy shorthand
 * that predates the `run_on` enum. We canonicalise it to `run_on: "always"`
 * here so all downstream code only needs to handle `run_on`.
 */
function mergeDefaults(
  config: WorkflowConfig,
  workDir?: string,
  workflowDir?: string,
): WorkflowConfig {
  const workflowDefaults: WorkflowDefaults = {
    ...DEFAULT_WORKFLOW_DEFAULTS,
    ...config.defaults,
  };

  const nodeDefaults = extractNodeSettings(workflowDefaults);

  const mergedNodes: Record<string, NodeConfig> = {};
  for (const [id, node] of Object.entries(config.nodes)) {
    const merged: NodeConfig = {
      ...node,
      settings: {
        ...DEFAULT_SETTINGS,
        ...nodeDefaults,
        ...node.settings,
      },
    };

    // Also merge defaults into inline loop body nodes
    if (node.type === "loop" && node.nodes) {
      const mergedBodyNodes: Record<string, NodeConfig> = {};
      for (const [bodyId, bodyNode] of Object.entries(node.nodes)) {
        mergedBodyNodes[bodyId] = {
          ...bodyNode,
          settings: {
            ...DEFAULT_SETTINGS,
            ...nodeDefaults,
            ...bodyNode.settings,
          },
        };
      }
      merged.nodes = mergedBodyNodes;
    }

    // Normalize run_always → run_on
    if (merged.run_always !== undefined && merged.run_on === undefined) {
      if (merged.run_always === true) {
        merged.run_on = "always";
      }
    }
    // run_on wins when both present; delete legacy field
    delete merged.run_always;

    mergedNodes[id] = merged;
  }

  const result: WorkflowConfig = {
    ...config,
    defaults: workflowDefaults,
    nodes: mergedNodes,
  };
  validateRuntimeCompatibility(result);
  validateFileReferences(result, workDir, workflowDir);
  return result;
}

function validateRuntimeCompatibility(config: WorkflowConfig): void {
  const defaults = config.defaults;

  const checkNode = (nodeId: string, node: NodeConfig, parent?: NodeConfig) => {
    if (node.type !== "agent") return;

    const runtimeConfig = resolveRuntimeConfig({ defaults, node, parent });
    if (
      runtimeConfig.runtime !== "opencode" &&
      runtimeConfig.runtime !== "cursor"
    ) return;

    if (
      runtimeConfig.permissionMode &&
      runtimeConfig.permissionMode !== "bypassPermissions"
    ) {
      const source = node.permission_mode !== undefined
        ? `nodes.${nodeId}.permission_mode`
        : "defaults.permission_mode";
      throw new Error(
        `${source} '${runtimeConfig.permissionMode}' is not supported for runtime '${runtimeConfig.runtime}' — only 'bypassPermissions' is supported (node '${nodeId}')`,
      );
    }
  };

  for (const [nodeId, node] of Object.entries(config.nodes)) {
    checkNode(nodeId, node);
    if (node.type === "loop" && node.nodes) {
      for (const [bodyId, bodyNode] of Object.entries(node.nodes)) {
        checkNode(bodyId, bodyNode, node);
      }
    }
  }
}

/**
 * Validate all `{{file("path")}}` and `{{flow_file("path")}}` references in
 * prompt and system_prompt fields.
 *
 * Scans top-level and loop body nodes. Paths containing `{{` are skipped
 * (unresolvable template variables at load time). Throws immediately on the
 * first missing file, including the node ID for context.
 *
 * `file()` paths resolve against `workDir`. `flow_file()` paths resolve against
 * `workDir/workflowDir` — i.e. the directory containing the workflow.yaml.
 *
 * @param workDir — base directory for resolving `{{file()}}` paths. Defaults
 *   to CWD.
 * @param workflowDir — workDir-relative directory containing the workflow.yaml,
 *   used as the base for `{{flow_file()}}` paths. "" or undefined means
 *   `flow_file()` resolves identically to `file()`.
 */
export function validateFileReferences(
  config: WorkflowConfig,
  workDir?: string,
  workflowDir?: string,
): void {
  const FILE_REF_RE = /\{\{(flow_file|file)\("([^"]+)"\)\}\}/g;
  const base = workDir ?? Deno.cwd();
  const wfDir = workflowDir ?? "";

  function scanNode(nodeId: string, node: NodeConfig): void {
    const fields = [node.prompt, node.system_prompt].filter(
      (f): f is string => typeof f === "string",
    );
    for (const field of fields) {
      FILE_REF_RE.lastIndex = 0;
      let match;
      while ((match = FILE_REF_RE.exec(field)) !== null) {
        const fnName = match[1] as "file" | "flow_file";
        const path = match[2];
        if (path.includes("{{")) continue;
        let resolved: string;
        if (path.startsWith("/")) {
          resolved = path;
        } else if (fnName === "flow_file" && wfDir !== "") {
          resolved = `${base}/${wfDir}/${path}`;
        } else {
          resolved = `${base}/${path}`;
        }
        try {
          Deno.statSync(resolved);
        } catch {
          throw new Error(
            `Node '${nodeId}': {{${fnName}("${path}")}} — file not found: ${resolved}`,
          );
        }
      }
    }
  }

  for (const [id, node] of Object.entries(config.nodes)) {
    scanNode(id, node);
    if (node.type === "loop" && node.nodes) {
      for (const [bodyId, bodyNode] of Object.entries(node.nodes)) {
        scanNode(bodyId, bodyNode);
      }
    }
  }
}

/**
 * Find a NodeConfig by ID, searching both top-level nodes and loop body nodes.
 * Returns undefined if not found.
 */
export function findNodeConfig(
  config: WorkflowConfig,
  nodeId: string,
): NodeConfig | undefined {
  if (config.nodes[nodeId]) return config.nodes[nodeId];
  for (const node of Object.values(config.nodes)) {
    if (node.type === "loop" && node.nodes && node.nodes[nodeId]) {
      return node.nodes[nodeId];
    }
  }
  return undefined;
}

/**
 * Collect all node IDs including nested body nodes from loop `nodes` sub-objects.
 * Returns a flat list suitable for `createRunState()`.
 */
export function collectAllNodeIds(config: WorkflowConfig): string[] {
  const ids: string[] = [];
  for (const [id, node] of Object.entries(config.nodes)) {
    ids.push(id);
    if (node.type === "loop" && node.nodes) {
      for (const bodyId of Object.keys(node.nodes)) {
        ids.push(bodyId);
      }
    }
  }
  return ids;
}

/** Extract NodeSettings fields from WorkflowDefaults (exclude workflow-only fields). */
function extractNodeSettings(defaults: WorkflowDefaults): NodeSettings {
  const {
    max_parallel: _,
    runtime: _rt,
    runtime_args: _ra,
    hitl: _hitl,
    model: _model,
    effort: _effort,
    permission_mode: _pm,
    worktree_disabled: _wd,
    ...settings
  } = defaults;
  return settings;
}

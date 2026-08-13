import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { ROLES } from "./domain.mjs";
import { validateTrustedPolicyRegistry } from "./product-blueprint.mjs";
import { configuredProjectMode } from "./project-mode.mjs";
import { architectureBlueprintFromProductRoots, validateArchitectureBlueprint } from "./architecture-blueprint.mjs";

export function loadConfig(configPath) {
  if (!existsSync(configPath)) throw new Error(`Missing config: ${configPath}. Copy config/swarm.config.example.json first.`);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const base = dirname(configPath);
  config.project ??= {};
  config.project.name ??= "unnamed-project";
  config.project.documentationDir ??= "docs/orchestration-input";
  config.project.generatedDir ??= "docs/orchestration-generated";
  config.project.productRoots ??= [];
  config.project.architectureBlueprint ??= null;
  config.project.repositoryMode ??= null;
  config.project.repositoryBaselineDeclaration ??= null;
  config.repository = resolve(base, config.repository);
  config.runtimeDir = resolve(base, config.runtimeDir ?? "./runtime");
  config.baseRef ??= "main";
  config.model ??= "gpt-5.6-terra";
  config.router ??= {};
  config.router.maxConcurrentTasks ??= 1;
  config.router.maxChildrenPerTask ??= 20;
  config.router.maxDelegationDepth ??= 4;
  config.router.defaultParentBudget ??= 30000;
  config.router.turnTimeoutMs ??= 600000;
  config.router.maxPlanTasks ??= 12;
  config.router.approvalMode ??= "deny";
  config.autonomy ??= {};
  config.autonomy.mode ??= "autonomous";
  config.autonomy.autoApproveWorkflowGates ??= true;
  config.autonomy.autoRemediate ??= true;
  config.autonomy.autoPush ??= true;
  config.autonomy.autoCreatePullRequest ??= true;
  config.autonomy.autoMerge ??= true;
  config.autonomy.maxRemediationRounds ??= 3;
  config.budget ??= {};
  config.budget.weeklyTokenLimit ??= 500000;
  config.budget.weeklyWindowDays ??= 7;
  config.budget.hardRunTokenLimit ??= 200000;
  config.budget.interruptSafetyMarginTokens ??= 12000;
  // Autonomous delivery uses local caps as scheduler guardrails. Account
  // quota remains an independent upstream hard stop.
  config.budget.enforceLocalLimits ??= true;
  config.quota ??= {};
  config.quota.throttleAtUsedPercent ??= 90;
  config.quota.throttleWhenUnavailable ??= false;
  config.integration ??= {};
  config.integration.remoteCiExtension ??= null;
  config.integration.pullRequestExtension ??= null;
  config.specificationResolution ??= {};
  config.specificationResolution.policyRegistry ??= { schemaVersion: 1, policies: [] };
  try { config.specificationResolution.policyRegistry = validateTrustedPolicyRegistry(config.specificationResolution.policyRegistry); }
  catch (error) { throw new Error(error.message); }
  config.delivery ??= {};
  config.delivery.maxRemediationRounds ??= config.autonomy.maxRemediationRounds;
  config.delivery.maxWaves ??= 8;
  config.delivery.maxNoProgressReconciliations ??= 2;
  config.delivery.maxReconciliationDiagnostics ??= 25;
  config.delivery.leaseHeartbeatMs ??= 5000;
  config.delivery.staleLeaseMs ??= 30000;
  config.delivery.shutdownGraceMs ??= 3000;
  config.remote ??= {};
  config.remote.enabled ??= false;
  config.remote.remoteName ??= "origin";
  config.remote.allowedRemotes ??= ["origin"];
  config.remote.candidateBranchPrefix ??= "swarm/candidate/";
  config.remote.requireCi ??= false;
  // An explicit allowlist is the preferred CI policy.  An empty list means
  // "read the target branch protection"; it never means that arbitrary green
  // checks are sufficient.
  config.remote.requiredCiContexts ??= [];
  config.remote.ciTimeoutMs ??= 900000;
  config.remote.ciPollIntervalMs ??= 10000;
  config.remote.mergeMethod ??= "merge";
  const safeProjectPath = (name, value) => {
    if (typeof value !== "string" || !value.trim() || isAbsolute(value) || /^(?:[A-Za-z]:|[\\/]+)/.test(value) || value.split(/[\\/]/).some((part) => part === "." || part === "..")) throw new Error(`${name} must be a normalized relative path inside the repository`);
    return value.replace(/\\/g, "/").replace(/\/+$/, "");
  };
  config.project.documentationDir = safeProjectPath("project.documentationDir", config.project.documentationDir);
  config.project.generatedDir = safeProjectPath("project.generatedDir", config.project.generatedDir);
  // A repositoryMode-only file is accepted only as migration input. Runtime
  // lifecycle decisions use the normalized versioned ProjectMode below.
  if (config.project.projectMode === undefined && ["greenfield", "brownfield"].includes(config.project.repositoryMode)) {
    config.project.projectMode = { schemaVersion: 1, kind: "ProjectMode", mode: config.project.repositoryMode };
  }
  try { config.project.projectMode = configuredProjectMode(config.project); }
  catch { throw new Error("project.projectMode must be a versioned ProjectMode with mode greenfield or brownfield"); }
  config.project.repositoryMode = config.project.projectMode.mode;
  if (config.project.projectMode.mode === "brownfield") {
    config.project.repositoryBaselineDeclaration = safeProjectPath("project.repositoryBaselineDeclaration", config.project.repositoryBaselineDeclaration);
  } else if (config.project.repositoryBaselineDeclaration !== null && config.project.repositoryBaselineDeclaration !== undefined) {
    throw new Error("project.repositoryBaselineDeclaration is only allowed in brownfield mode");
  }
  if (!Array.isArray(config.project.productRoots)) throw new Error("project.productRoots must be an allowlisted array");
  const productIds = new Set();
  const productPaths = new Set();
  config.project.productRoots = config.project.productRoots.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`project.productRoots[${index}] must be an object`);
    const { id, path, adapter } = entry;
    if (typeof id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(id) || productIds.has(id)) throw new Error("project.productRoots ids must be unique safe identifiers");
    const normalizedPath = safeProjectPath(`project.productRoots[${index}].path`, path);
    if (productPaths.has(normalizedPath) || normalizedPath === config.project.documentationDir || normalizedPath === config.project.generatedDir) throw new Error("project.productRoots paths must be unique and outside controller directories");
    if (typeof adapter !== "string") throw new Error(`project.productRoots[${index}].adapter must be a controller allowlist identity`);
    productIds.add(id); productPaths.add(normalizedPath);
    return { id, path: normalizedPath, adapter };
  });
  try {
    const legacyBlueprint = architectureBlueprintFromProductRoots(config.project.productRoots, config.project.projectMode);
    config.project.architectureBlueprint = config.project.architectureBlueprint === null
      ? legacyBlueprint
      : validateArchitectureBlueprint(config.project.architectureBlueprint, { projectMode: config.project.projectMode });
    const blueprintRoots = config.project.architectureBlueprint.components.map((component) => ({ id: component.id, path: component.path, adapter: component.adapter.id, adapterVersion: component.adapter.version }));
    if (config.project.productRoots.length && JSON.stringify(config.project.productRoots.map(({ id, path, adapter }) => ({ id, path, adapter }))) !== JSON.stringify(blueprintRoots.map(({ id, path, adapter }) => ({ id, path, adapter })))) throw new Error("project.productRoots must exactly match the admitted ArchitectureBlueprint");
    config.project.productRoots = blueprintRoots;
  } catch (error) { throw new Error(String(error.message)); }
  if (!["deny", "auto"].includes(config.router.approvalMode)) throw new Error("router.approvalMode must be deny or auto");
  if (!["autonomous", "manual"].includes(config.autonomy.mode)) throw new Error("autonomy.mode must be autonomous or manual");
  for (const key of ["autoApproveWorkflowGates", "autoRemediate", "autoPush", "autoCreatePullRequest", "autoMerge"]) {
    if (typeof config.autonomy[key] !== "boolean") throw new Error(`autonomy.${key} must be boolean`);
  }
  if (config.autonomy.mode === "autonomous" && ["autoApproveWorkflowGates", "autoRemediate", "autoPush", "autoCreatePullRequest", "autoMerge"].some((key) => config.autonomy[key] !== true)) throw new Error("autonomous mode requires all autonomy automation flags to be true; use manual mode for emergency debugging");
  if (!Number.isInteger(config.autonomy.maxRemediationRounds) || config.autonomy.maxRemediationRounds < 0 || config.autonomy.maxRemediationRounds > 10) throw new Error("autonomy.maxRemediationRounds must be an integer from 0 to 10");
  if (!Number.isInteger(config.router.maxConcurrentTasks) || config.router.maxConcurrentTasks < 1) throw new Error("router.maxConcurrentTasks must be a positive integer");
  if (!Number.isInteger(config.router.turnTimeoutMs) || config.router.turnTimeoutMs < 1000) throw new Error("router.turnTimeoutMs must be an integer of at least 1000");
  if (!Number.isInteger(config.router.maxPlanTasks) || config.router.maxPlanTasks < 1) throw new Error("router.maxPlanTasks must be a positive integer");
  if (!Number.isInteger(config.budget.weeklyTokenLimit) || config.budget.weeklyTokenLimit < 1) throw new Error("budget.weeklyTokenLimit must be a positive integer");
  if (!Number.isInteger(config.budget.weeklyWindowDays) || config.budget.weeklyWindowDays < 1) throw new Error("budget.weeklyWindowDays must be a positive integer");
  if (!Number.isInteger(config.budget.hardRunTokenLimit) || config.budget.hardRunTokenLimit < 1 || config.budget.hardRunTokenLimit > config.budget.weeklyTokenLimit) throw new Error("budget.hardRunTokenLimit must be a positive integer no greater than budget.weeklyTokenLimit");
  if (!Number.isInteger(config.budget.interruptSafetyMarginTokens) || config.budget.interruptSafetyMarginTokens < 0 || config.budget.interruptSafetyMarginTokens >= config.budget.hardRunTokenLimit) throw new Error("budget.interruptSafetyMarginTokens must be a non-negative integer smaller than budget.hardRunTokenLimit");
  if (typeof config.budget.enforceLocalLimits !== "boolean") throw new Error("budget.enforceLocalLimits must be boolean");
  if (!Number.isInteger(config.quota.throttleAtUsedPercent) || config.quota.throttleAtUsedPercent < 1 || config.quota.throttleAtUsedPercent > 100) throw new Error("quota.throttleAtUsedPercent must be an integer from 1 to 100");
  if (typeof config.quota.throttleWhenUnavailable !== "boolean") throw new Error("quota.throttleWhenUnavailable must be boolean");
  if (!Number.isInteger(config.delivery.maxRemediationRounds) || config.delivery.maxRemediationRounds < 0 || config.delivery.maxRemediationRounds > 10) throw new Error("delivery.maxRemediationRounds must be an integer from 0 to 10");
  if (!Number.isInteger(config.delivery.maxWaves) || config.delivery.maxWaves < 1 || config.delivery.maxWaves > 100) throw new Error("delivery.maxWaves must be an integer from 1 to 100");
  if (!Number.isInteger(config.delivery.maxNoProgressReconciliations) || config.delivery.maxNoProgressReconciliations < 0 || config.delivery.maxNoProgressReconciliations > 100) throw new Error("delivery.maxNoProgressReconciliations must be an integer from 0 to 100");
  if (!Number.isInteger(config.delivery.maxReconciliationDiagnostics) || config.delivery.maxReconciliationDiagnostics < 1 || config.delivery.maxReconciliationDiagnostics > 100) throw new Error("delivery.maxReconciliationDiagnostics must be an integer from 1 to 100");
  for (const key of ["leaseHeartbeatMs", "staleLeaseMs", "shutdownGraceMs"]) if (!Number.isInteger(config.delivery[key]) || config.delivery[key] < 250) throw new Error(`delivery.${key} must be an integer of at least 250`);
  if (config.autonomy.mode === "autonomous" && config.delivery.maxRemediationRounds !== config.autonomy.maxRemediationRounds) throw new Error("delivery.maxRemediationRounds must match autonomy.maxRemediationRounds in autonomous mode");
  if (typeof config.remote.enabled !== "boolean" || typeof config.remote.requireCi !== "boolean") throw new Error("remote.enabled and remote.requireCi must be boolean");
  if (!Array.isArray(config.remote.requiredCiContexts) || config.remote.requiredCiContexts.some((item) => typeof item !== "string" || !item.trim() || item.length > 200) || new Set(config.remote.requiredCiContexts).size !== config.remote.requiredCiContexts.length) throw new Error("remote.requiredCiContexts must be an array of unique non-empty check context names");
  config.remote.requiredCiContexts = config.remote.requiredCiContexts.map((item) => item.trim());
  if (typeof config.remote.remoteName !== "string" || !Array.isArray(config.remote.allowedRemotes) || !config.remote.allowedRemotes.every((item) => typeof item === "string") || !config.remote.allowedRemotes.includes(config.remote.remoteName)) throw new Error("remote.remoteName must be included in remote.allowedRemotes");
  if (typeof config.remote.candidateBranchPrefix !== "string" || !config.remote.candidateBranchPrefix.startsWith("swarm/candidate/") || config.remote.candidateBranchPrefix.includes("..")) throw new Error("remote.candidateBranchPrefix must remain under swarm/candidate/");
  if (!Number.isInteger(config.remote.ciTimeoutMs) || config.remote.ciTimeoutMs < 1_000 || config.remote.ciTimeoutMs > 3_600_000) throw new Error("remote.ciTimeoutMs must be an integer from 1000 to 3600000");
  if (!Number.isInteger(config.remote.ciPollIntervalMs) || config.remote.ciPollIntervalMs < 250 || config.remote.ciPollIntervalMs > 60_000) throw new Error("remote.ciPollIntervalMs must be an integer from 250 to 60000");
  if (!["merge", "squash", "rebase"].includes(config.remote.mergeMethod)) throw new Error("remote.mergeMethod must be merge, squash, or rebase");
  if (![null, "string"].includes(config.integration.remoteCiExtension === null ? null : typeof config.integration.remoteCiExtension)) throw new Error("integration.remoteCiExtension must be string or null");
  if (![null, "string"].includes(config.integration.pullRequestExtension === null ? null : typeof config.integration.pullRequestExtension)) throw new Error("integration.pullRequestExtension must be string or null");
  for (const role of ROLES) {
    if (!config.roles?.[role]) throw new Error(`Missing role configuration: ${role}`);
    const roleConfig = config.roles[role];
    if (!Number.isInteger(roleConfig.tokenBudget) || roleConfig.tokenBudget < 1) throw new Error(`roles.${role}.tokenBudget must be positive`);
    roleConfig.interruptThresholdTokens ??= Math.max(1, roleConfig.tokenBudget - config.budget.interruptSafetyMarginTokens);
    if (!Number.isInteger(roleConfig.interruptThresholdTokens) || roleConfig.interruptThresholdTokens < 1 || roleConfig.interruptThresholdTokens > roleConfig.tokenBudget) throw new Error(`roles.${role}.interruptThresholdTokens must be an integer from 1 to roles.${role}.tokenBudget`);
    if (!["read-only", "workspace-write"].includes(roleConfig.sandbox)) throw new Error(`roles.${role}.sandbox must be read-only or workspace-write`);
    if (roleConfig.approvalPolicy !== "never") throw new Error(`roles.${role}.approvalPolicy must be never`);
    if (roleConfig.sandbox === "workspace-write" && roleConfig.usesWorktree !== true) throw new Error(`roles.${role}.workspace-write requires usesWorktree=true`);
    roleConfig.maxAttempts = 1;
  }
  return config;
}

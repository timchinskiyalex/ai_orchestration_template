import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ingestDocumentation } from "./project-intake.mjs";
import { SwarmRouter } from "./router.mjs";

export const SOURCE_INTAKE_PROBE_CONFIRMATION = "--confirm-spend-quota";
export const SOURCE_INTAKE_PROBE_REPORT = "source-intake-probe-report.json";
const ROOT_PREFIX = "orchestration-source-intake-probe-";
const MAX_PROTOCOL_TAIL = 20;
const MAX_ID_LENGTH = 512;

const git = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const boundedString = (value, length = MAX_ID_LENGTH) => typeof value === "string" ? value.slice(0, length) : null;

export function parseSourceIntakeProbeArgs(args) {
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== SOURCE_INTAKE_PROBE_CONFIRMATION) {
    throw new Error(`Usage: npm run e2e:source-intake-probe -- ${SOURCE_INTAKE_PROBE_CONFIRMATION}`);
  }
  return Object.freeze({ confirmed: true });
}

export function isDisposableSourceIntakeProbeRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) return false;
  const temporary = resolve(tmpdir());
  const target = resolve(root);
  const relation = relative(temporary, target);
  return Boolean(relation && relation !== ".." && !relation.startsWith(`..${sep}`) && target.startsWith(`${temporary}${sep}${ROOT_PREFIX}`));
}

export function cleanupSourceIntakeProbeRoot(root) {
  if (!isDisposableSourceIntakeProbeRoot(root)) throw new Error(`Refusing cleanup outside a disposable source-intake probe root: ${resolve(root)}`);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

function probeRoles() {
  return Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, {
    sandbox: "read-only", approvalPolicy: "never", tokenBudget: 8_000, interruptThresholdTokens: 7_000, usesWorktree: false
  }]));
}

export function sourceIntakeProbeConfig({ root, timeoutMs, model, sourceIntakeRuntimeFactory = null }) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("Source intake probe timeout must be an integer of at least 1000ms");
  return {
    repository: root,
    runtimeDir: join(root, "runtime"),
    baseRef: "main",
    model,
    project: { name: "source-intake-probe", documentationDir: "docs/orchestration-input", generatedDir: "docs/orchestration-generated", projectMode: { schemaVersion: 1, kind: "ProjectMode", mode: "greenfield" }, productRoots: [] },
    router: { maxConcurrentTasks: 1, maxChildrenPerTask: 1, maxDelegationDepth: 1, maxPlanTasks: 1, defaultParentBudget: 8_000, turnTimeoutMs: timeoutMs, approvalMode: "deny" },
    autonomy: { mode: "autonomous", autoApproveWorkflowGates: true, autoRemediate: true, autoPush: true, autoCreatePullRequest: true, autoMerge: true, maxRemediationRounds: 0 },
    budget: { weeklyTokenLimit: 20_000, weeklyWindowDays: 7, hardRunTokenLimit: 16_000, interruptSafetyMarginTokens: 1_000, enforceLocalLimits: false },
    quota: { throttleAtUsedPercent: 90, throttleWhenUnavailable: false },
    delivery: { maxWaves: 1, maxRemediationRounds: 0, shutdownGraceMs: 3_000, sourceClaimExtractionTokenBudget: 4_000, sourceClaimAuditTokenBudget: 4_000 },
    remote: { enabled: false, remoteName: "origin", allowedRemotes: ["origin"], candidateBranchPrefix: "swarm/candidate/", requireCi: false, mergeMethod: "merge" },
    roles: probeRoles(),
    // Production supplies no factory, so SourceIntakeRuntime constructs the
    // same real Codex App Server runtime used by G2/G3. This narrow seam is
    // retained solely for deterministic, quota-free contract tests.
    ...(sourceIntakeRuntimeFactory ? { sourceIntakeRuntimeFactory } : {})
  };
}

function createProbeFixture(root, { requirements = ["The controller must persist an admitted source claim manifest before engineering work can be queued."] } = {}) {
  if (!Array.isArray(requirements) || !requirements.length || requirements.some((item) => typeof item !== "string" || !item.trim())) throw new Error("Source intake probe fixture requirements must be non-empty strings");
  const source = join(root, "raw-markdown-package");
  git(root, ["init", "-b", "main"]);
  mkdirSync(source, { recursive: true });
  writeFileSync(join(root, "README.md"), "# Source intake probe repository\n", "utf8");
  writeFileSync(join(source, "requirements.md"), `# Requirements\n${requirements.join("\n")}\n`, "utf8");
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=Source Intake Probe", "-c", "user.email=source-intake-probe@example.test", "commit", "-m", "probe fixture"]);
  return source;
}

function safeAttempt(attempt) {
  if (!attempt || !["extraction", "audit"].includes(attempt.role)) return null;
  return {
    schemaVersion: 1,
    kind: "SourceIntakeAttempt",
    role: attempt.role,
    attemptedThreadId: boundedString(attempt.attemptedThreadId),
    requestedTurnId: boundedString(attempt.requestedTurnId),
    resolvedTurnId: attempt.resolvedTurnId == null ? null : boundedString(attempt.resolvedTurnId),
    runtimeStage: boundedString(attempt.runtimeStage, 64),
    lifecycleState: boundedString(attempt.lifecycleState, 64)
  };
}

function safeProtocolTail(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_PROTOCOL_TAIL).map((event) => {
    const safe = {};
    for (const key of ["direction", "method", "threadId", "turnId", "requestedTurnId", "resolvedTurnId", "itemType", "itemStatus", "errorCode"]) {
      const item = boundedString(event?.[key]);
      if (item !== null) safe[key] = item;
    }
    return safe;
  });
}

function safeFailure(failure) {
  if (!failure || !["extraction", "audit"].includes(failure.role)) return null;
  const diagnostics = failure.diagnostics && typeof failure.diagnostics === "object" ? failure.diagnostics : {};
  return {
    schemaVersion: 1,
    kind: "SourceIntakeFailure",
    role: failure.role,
    phase: boundedString(failure.phase, 64),
    code: boundedString(failure.code, 96),
    receiptIdentity: failure.receiptIdentity && typeof failure.receiptIdentity === "object" ? {
      threadId: boundedString(failure.receiptIdentity.threadId),
      requestedTurnId: boundedString(failure.receiptIdentity.requestedTurnId),
      resolvedTurnId: boundedString(failure.receiptIdentity.resolvedTurnId)
    } : null,
    diagnostics: {
      attemptedThreadId: boundedString(diagnostics.attemptedThreadId),
      requestedTurnId: boundedString(diagnostics.requestedTurnId),
      resolvedTurnId: diagnostics.resolvedTurnId == null ? null : boundedString(diagnostics.resolvedTurnId),
      runtimeStage: boundedString(diagnostics.runtimeStage, 64),
      primaryReason: boundedString(diagnostics.primaryReason, 96) ?? boundedString(failure.code, 96),
      processState: diagnostics.processState && typeof diagnostics.processState === "object" ? {
        alive: diagnostics.processState.alive === true,
        exited: diagnostics.processState.exited === true,
        code: Number.isInteger(diagnostics.processState.code) ? diagnostics.processState.code : null,
        signal: boundedString(diagnostics.processState.signal, 64)
      } : null,
      protocolTail: safeProtocolTail(diagnostics.protocolTail)
    }
  };
}

export function sourceIntakeProbeReport({ status, router, deliveryRunId }) {
  const attempts = ["extraction", "audit"].map((role) => safeAttempt(router?.store.sourceIntakeAttemptForRun({ deliveryRunId, role }))).filter(Boolean);
  const failures = ["extraction", "audit"].map((role) => safeFailure(router?.store.sourceIntakeFailureForRun({ deliveryRunId, role }))).filter(Boolean);
  return Object.freeze({ schemaVersion: 1, kind: "SourceIntakeProbeReport", status, diagnostics: { attempts, failures } });
}

function verifyProbeSuccess(router, run) {
  const current = router.store.deliveryRun(run.id);
  if (!current?.sourceClaimExtractionId || !current.sourceClaimAuditId || !current.sourceClaimManifestId) throw new Error("source-intake-probe:admitted source intake records are incomplete");
  for (const role of ["source_claim_extraction", "source_claim_audit"]) {
    if (!router.store.sourceIntakeTerminalReceipt({ deliveryRunId: run.id, role })?.receipt) throw new Error(`source-intake-probe:missing terminal receipt for ${role}`);
  }
  if (!router.store.sourceClaimExtraction(current.sourceClaimExtractionId) || !router.store.sourceClaimAudit(current.sourceClaimAuditId) || !router.store.sourceClaimManifest(current.sourceClaimManifestId)) throw new Error("source-intake-probe:immutable intake artifact persistence is incomplete");
  if (router.list().length !== 0) throw new Error("source-intake-probe:engineering work was unexpectedly queued");
  return current;
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

async function withProbeTimeout({ timeoutMs, operation, onTimeout }) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(async () => {
          try { await Promise.race([Promise.resolve(onTimeout?.()), delay(5_000)]); } catch { /* retain bounded timeout outcome */ }
          reject(new Error("source-intake-probe:timeout"));
        }, timeoutMs);
      })
    ]);
  } finally { clearTimeout(timer); }
}

export async function runSourceIntakeProbe({ timeoutMs = Number(process.env.CODEX_SOURCE_INTAKE_PROBE_TIMEOUT_MS ?? 180_000), model = process.env.CODEX_E2E_MODEL ?? "gpt-5.6-terra", progress = (message) => console.log(`[intake-probe] ${message}`), sourceIntakeRuntimeFactory = null, rootFactory = () => mkdtempSync(join(tmpdir(), ROOT_PREFIX)), onPassed = null, fixture = null } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error("CODEX_SOURCE_INTAKE_PROBE_TIMEOUT_MS must be an integer of at least 1000");
  const root = rootFactory();
  if (!isDisposableSourceIntakeProbeRoot(root)) throw new Error("Source intake probe root must be a disposable temporary directory");
  let router = null;
  let run = null;
  let passed = false;
  let reportPath = null;
  try {
    const source = createProbeFixture(root, fixture ?? undefined);
    router = new SwarmRouter(sourceIntakeProbeConfig({ root, timeoutMs, model, sourceIntakeRuntimeFactory }));
    const intake = ingestDocumentation({ source, repository: root, destinationRelative: router.config.project.documentationDir });
    if (intake.sourceClaimInput !== "raw") throw new Error("source-intake-probe:fixture must use raw Markdown without source-claims.json");
    run = router.createDeliveryRun({ id: randomUUID(), source, bootstrapTaskId: null, confirmRemotePush: false, sourceClaimInputMode: "raw", repositoryMode: router.projectMode.mode, projectMode: router.projectMode });
    await withProbeTimeout({
      timeoutMs,
      operation: async () => {
        progress("extraction started");
        await router.extractSourceClaimsForRun(run);
        progress("extraction completed");
        progress("audit started");
        await router.auditAndAdmitSourceClaimsForRun(router.store.deliveryRun(run.id));
        progress("audit completed");
      },
      onTimeout: () => router?.requestShutdown("source-intake-probe timeout")
    });
    const admitted = verifyProbeSuccess(router, run);
    progress("manifest admitted");
    await onPassed?.({ router, run: admitted });
    passed = true;
    progress("probe passed");
    return Object.freeze({ status: "passed", deliveryRunId: admitted.id, root: null, reportPath: null });
  } catch (error) {
    const report = sourceIntakeProbeReport({ status: "failed", router, deliveryRunId: run?.id ?? null });
    reportPath = join(root, SOURCE_INTAKE_PROBE_REPORT);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const failure = report.diagnostics.failures.at(-1);
    if (failure) {
      const details = failure.diagnostics ?? {};
      progress(`probe failed role=${failure.role} runtimeStage=${details.runtimeStage ?? "none"} primaryReason=${details.primaryReason ?? failure.code} requestedTurnId=${details.requestedTurnId ?? failure.receiptIdentity?.requestedTurnId ?? "none"} resolvedTurnId=${details.resolvedTurnId ?? failure.receiptIdentity?.resolvedTurnId ?? "none"} processState=${JSON.stringify(details.processState ?? null)} protocolTail=${JSON.stringify(details.protocolTail ?? [])}`);
    } else progress("probe failed role=none runtimeStage=none primaryReason=source_intake_probe_failed requestedTurnId=none resolvedTurnId=none processState=null protocolTail=[]");
    return Object.freeze({ status: "failed", root, reportPath, report, errorCode: "source_intake_probe_failed" });
  } finally {
    try { router?.stop(); } catch { /* preserve probe outcome */ }
    try { router?.close(); } catch { /* preserve probe outcome */ }
    if (passed) cleanupSourceIntakeProbeRoot(root);
  }
}

export function parseLiveE2eWorkers(value) {
  const workers = Number(value);
  if (!Number.isInteger(workers) || workers < 1 || workers > 10) throw new Error("CODEX_E2E_WORKERS must be an integer from 1 to 10");
  return workers;
}

export function deterministicScaffoldFixtureRouterConfig({ workers, timeoutMs }) {
  const maxConcurrentTasks = parseLiveE2eWorkers(workers);
  return {
    maxConcurrentTasks,
    maxChildrenPerTask: 12,
    maxDelegationDepth: 3,
    maxPlanTasks: 8,
    defaultParentBudget: 120_000,
    turnTimeoutMs: timeoutMs,
    approvalMode: "deny"
  };
}

export function selectLiveE2eFailureTask(tasks, fallbackTaskId = null) {
  const terminalFailures = new Set(["failed", "interrupted", "cancelled", "blocked_budget", "blocked_quota"]);
  return [...(tasks ?? [])]
    .filter((task) => terminalFailures.has(task?.status))
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))[0]
    ?? (tasks ?? []).find((task) => task?.id === fallbackTaskId)
    ?? null;
}

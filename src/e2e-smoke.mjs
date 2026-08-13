import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function formatE2eDiagnostics({ stage, taskId = null, task = null, recoveryWorktree = null, cause = null, runtime = null }) {
  const protocolEvents = runtime?.appServer?.protocolEvents?.slice(-100) ?? [];
  const lifecycleEvents = runtime?.lifecycleEvents?.slice(-100) ?? [];
  const processState = runtime?.appServer?.process ?? null;
  const threadRead = runtime?.threadRead ?? null;
  const stderrTail = runtime?.appServer?.stderrTail ?? "";
  return `[E2E diagnostics] stage=${stage}; taskId=${taskId ?? "none"}; threadId=${task?.threadId ?? "none"}; turnId=${task?.turnId ?? "none"}; taskStatus=${task?.status ?? "none"}; recoveryWorktree=${recoveryWorktree ?? task?.worktree ?? "none"}; cause=${cause?.message ?? "none"}; process=${JSON.stringify(processState)}; threadRead=${JSON.stringify(threadRead)}; lifecycleEvents=${JSON.stringify(lifecycleEvents)}; protocolEvents=${JSON.stringify(protocolEvents)}; stderrTail=${stderrTail}`;
}

export async function withE2eTimeout({ timeoutMs, operation, onTimeout, diagnostics, signalEmitter = process }) {
  let stopped = false;
  let timer;
  const rawWork = Promise.resolve().then(operation);
  const work = rawWork.catch((error) => stopped ? new Promise(() => {}) : Promise.reject(error));
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(async () => {
      stopped = true;
      let timeoutDetails = null;
      try { timeoutDetails = await Promise.race([Promise.resolve(onTimeout?.()), delay(5_000)]); }
      catch { /* retain the original timeout */ }
      reject(new Error(`E2E smoke timed out after ${timeoutMs}ms. ${diagnostics(timeoutDetails)}`));
    }, timeoutMs);
  });
  let onSignal;
  const interrupted = new Promise((_, reject) => {
    onSignal = async () => {
      stopped = true;
      let timeoutDetails = null;
      try { timeoutDetails = await Promise.race([Promise.resolve(onTimeout?.()), delay(5_000)]); }
      catch { /* retain the interrupt */ }
      reject(new Error(`E2E smoke interrupted by SIGINT. ${diagnostics(timeoutDetails)}`));
    };
    signalEmitter?.once?.("SIGINT", onSignal);
  });
  try { return await Promise.race([work, timeout, interrupted]); }
  finally {
    clearTimeout(timer);
    signalEmitter?.off?.("SIGINT", onSignal);
    if (stopped) await Promise.race([rawWork.catch(() => undefined), delay(5_000)]);
  }
}

export function assertSingleWorkerSmoke(tasks) {
  if (tasks.length !== 1 || tasks[0].role !== "backend") throw new Error("Real smoke path must contain exactly one backend task and no Bootstrap or Planner tasks");
}

export function assertParallelWorkerSmoke(tasks, workerCount) {
  if (!Number.isInteger(workerCount) || workerCount < 2) throw new Error("Parallel smoke requires at least two workers");
  if (tasks.length !== workerCount || tasks.some((task) => task.role !== "backend")) throw new Error(`Parallel smoke must contain exactly ${workerCount} independent backend tasks`);
}

export function assertObservedParallelTurns(events, minimumConcurrent = 2) {
  const { maximumConcurrentTurns: maximum } = observedTurnConcurrency(events);
  if (maximum < minimumConcurrent) throw new Error(`Expected at least ${minimumConcurrent} concurrent real turns; observed ${maximum}`);
  return { maximumConcurrentTurns: maximum };
}

export function assertMaxObservedActiveTurns(events, maximumAllowed) {
  if (!Number.isInteger(maximumAllowed) || maximumAllowed < 1) throw new Error("maximumAllowed must be a positive integer");
  const result = observedTurnConcurrency(events);
  if (result.maximumConcurrentTurns > maximumAllowed) throw new Error(`Observed ${result.maximumConcurrentTurns} concurrent real turns; maximum is ${maximumAllowed}`);
  return result;
}

function observedTurnConcurrency(events) {
  const active = new Set();
  let maximum = 0;
  for (const event of events ?? []) {
    if (!event?.taskId) continue;
    if (event.type === "turn started") {
      active.add(event.taskId);
      maximum = Math.max(maximum, active.size);
    } else if (event.type === "turn completed") active.delete(event.taskId);
  }
  return { maximumConcurrentTurns: maximum };
}

export function cleanupDisposableRoot(root) {
  if (!isDisposableE2eRoot(root)) throw new Error(`Refuse cleanup outside a disposable E2E root: ${resolve(root)}`);
  if (existsSync(resolve(root))) rmSync(resolve(root), { recursive: true, force: true });
}

export function isDisposableE2eRoot(root) {
  if (!isAbsolute(root)) return false;
  const temporary = resolve(tmpdir());
  const target = resolve(root);
  const relation = relative(temporary, target);
  return Boolean(relation && relation !== ".." && !relation.startsWith(`..${sep}`) && dirname(target) === temporary && basename(target).startsWith("orchestration-real-e2e-"));
}

export function preserveOrCleanupDisposableRoot(root, { passed }) {
  if (passed) {
    cleanupDisposableRoot(root);
    return { recoveryRoot: null, recoveryAction: "Disposable E2E root removed after a passed run." };
  }
  return { recoveryRoot: root, recoveryAction: `Preserved failed disposable E2E root. Inspect it, then run npm run e2e:cleanup -- --recovery-root "${root}".` };
}

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createE2eRunReporter, openE2eRunReporter } from "../src/e2e-report.mjs";
import { parseLiveE2eWorkers } from "../src/live-e2e-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const workersIndex = args.indexOf("--workers");
const workerCount = workersIndex === -1 ? 1 : Number(args[workersIndex + 1]);
const workerProbe = args.includes("--verify-worker-config");
if (!Number.isInteger(workerCount) || workerCount < 1 || workerCount > 10) {
  console.error("--workers must be an integer from 1 to 10.");
  process.exitCode = 1;
} else if (workerProbe) {
  const child = spawn(process.execPath, ["--test", "test/real-deterministic-scaffold-e2e.test.mjs"], {
    cwd: root, stdio: "inherit", env: { ...process.env, CODEX_E2E_WORKERS: String(parseLiveE2eWorkers(workerCount)), CODEX_E2E_WORKER_CONFIG_PROBE: "1" }
  });
  const result = await new Promise((resolveResult) => child.once("exit", (code, signal) => resolveResult({ code: code ?? 1, signal })));
  if (result.code !== 0) process.exitCode = result.code;
} else if (!args.includes("--confirm-spend-quota")) {
  console.error("Refusing to run real E2E without --confirm-spend-quota.");
  process.exitCode = 1;
} else {
  const reporter = createE2eRunReporter({ reportsRoot: resolve(root, "runtime", "e2e-runs") });
  const child = spawn(process.execPath, ["--test", "test/real-deterministic-scaffold-e2e.test.mjs"], {
    cwd: root, stdio: "inherit", env: { ...process.env, RUN_REAL_CODEX_E2E: "1", E2E_REPORT_DIR: reporter.runDir, CODEX_E2E_WORKERS: String(workerCount) }
  });
  const result = await new Promise((resolveResult) => {
    child.once("error", (error) => resolveResult({ code: 1, error }));
    child.once("exit", (code, signal) => resolveResult({ code: code ?? 1, signal }));
  });
  const finalReporter = openE2eRunReporter(reporter.runDir);
  if (finalReporter.summary()?.status === "running") {
    const error = result.error ?? Object.assign(new Error(`E2E runner exited before writing a final summary (code: ${result.code}, signal: ${result.signal ?? "none"})`), { code: result.code, signal: result.signal ?? null });
    finalReporter.finalize({ status: "failed", error });
  }
  if (result.code !== 0) process.exitCode = result.code;
}

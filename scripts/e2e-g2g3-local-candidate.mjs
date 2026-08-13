import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLiveE2eWorkers } from "../src/live-e2e-contract.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const workersIndex = args.indexOf("--workers");
const workerCount = workersIndex === -1 ? 2 : Number(args[workersIndex + 1]);

if (!args.includes("--confirm-spend-quota")) {
  console.error("Refusing to run the G2/G3 local-candidate live E2E without --confirm-spend-quota.");
  process.exitCode = 1;
} else {
  try { parseLiveE2eWorkers(workerCount); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  if (process.exitCode !== 1 && workerCount !== 2) {
    console.error("The G2/G3 local-candidate live E2E requires --workers 2 to prove two parallel writer turns.");
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  const child = spawn(process.execPath, ["--test", "test/real-g2g3-local-candidate-e2e.test.mjs"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, RUN_REAL_G2G3_LOCAL_CANDIDATE_E2E: "1", CODEX_E2E_WORKERS: String(workerCount) }
  });
  const result = await new Promise((resolveResult) => child.once("exit", (code, signal) => resolveResult({ code: code ?? 1, signal })));
  if (result.code !== 0) process.exitCode = result.code;
}

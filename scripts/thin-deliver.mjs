import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { AppServerClient } from "../src/app-server-client.mjs";
import { createThinPlan } from "../src/thin/planner.mjs";
import { runThinOrchestrator } from "../src/thin/orchestrator.mjs";
import { runThinAppServerWorker } from "../src/thin/app-server-worker.mjs";

const exec = promisify(execFile);
const MAX_DOC_BYTES = 1_000_000;
const MAX_DOC_FILES = 40;

export function parseThinDeliverArgs(argv) {
  const options = { repo: process.cwd(), docs: null, verify: null, fake: false, confirm: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--fake") options.fake = true;
    else if (value === "--confirm-spend-quota") options.confirm = true;
    else if (value === "--docs" || value === "--repo" || value === "--verify") {
      const argument = argv[++index];
      if (!argument || argument.startsWith("--")) throw new Error(`${value} requires a value`);
      options[value.slice(2)] = argument;
    } else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`unknown option: ${value}`);
  }
  return options;
}

export function thinDeliverUsage() {
  return "Usage: node scripts/thin-deliver.mjs --docs <file-or-directory> --verify <command> [--repo <git-repo>] [--confirm-spend-quota | --fake]";
}

export function readMarkdownPackage(input) {
  const source = resolve(requireText(input, "--docs"));
  const files = [];
  const collect = (path) => {
    const stats = statSync(path);
    if (stats.isFile()) {
      if (extname(path).toLowerCase() === ".md") files.push(path);
      return;
    }
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      collect(join(path, entry.name));
    }
  };
  collect(source);
  if (!files.length) throw new Error("--docs must contain at least one Markdown file");
  if (files.length > MAX_DOC_FILES) throw new Error(`--docs contains more than ${MAX_DOC_FILES} Markdown files`);
  const chunks = [];
  let size = 0;
  for (const file of files.sort()) {
    const text = readFileSync(file, "utf8");
    size += Buffer.byteLength(text, "utf8");
    if (size > MAX_DOC_BYTES) throw new Error(`--docs exceeds ${MAX_DOC_BYTES} bytes`);
    chunks.push(`\n# SOURCE: ${basename(file)}\n${text}`);
  }
  return chunks.join("\n").trim();
}

export async function runThinDeliver({ argv = process.argv.slice(2), stdout = console.log, stderr = console.error } = {}) {
  let options;
  try { options = parseThinDeliverArgs(argv); }
  catch (error) { stderr(`[failure] stage=argument code=invalid_arguments task=- recovery=- message=${safe(error.message)}`); return 2; }
  if (options.help) { stdout(thinDeliverUsage()); return 0; }
  if (!options.docs) { stderr(`[failure] stage=argument code=docs_required task=- recovery=-`); return 2; }
  // This check is intentionally before opening docs, Git, worktrees, or the
  // App Server. A live invocation has no side effect until explicitly opted in.
  if (!options.fake && !options.confirm) {
    stderr("[failure] stage=admission code=quota_confirmation_required task=- recovery=-");
    return 2;
  }
  if (!options.fake && !options.verify) {
    stderr("[failure] stage=argument code=verify_required task=- recovery=-");
    return 2;
  }

  try {
    const markdown = readMarkdownPackage(options.docs);
    const result = options.fake
      ? await runFake({ markdown, verify: options.verify, stdout })
      : await runLive({ markdown, repository: resolve(options.repo), verify: options.verify, stdout });
    return result.ok ? 0 : 1;
  } catch (error) {
    stderr(`[failure] stage=cli code=unexpected_error task=- recovery=- message=${safe(error.message)}`);
    return 1;
  }
}

async function runLive({ markdown, repository, verify, stdout }) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "thin-orchestrator-runtime-"));
  try {
    stdout("[plan] started");
    const result = await runThinOrchestrator({
      repository,
      runtimeDir,
      markdown,
      planner: async ({ markdown: source }) => createThinPlan({ markdown: source, runTurn: ({ prompt }) => runPlannerTurn({ cwd: repository, prompt, stdout }) }),
      workerExecutor: async ({ task, taskKey, worktree }) => {
        const worker = await runThinAppServerWorker({
          cwd: worktree, taskKey, prompt: task.prompt, allowedPaths: task.allowedPaths,
          onEvent: (event) => emitWorkerRuntimeEvent(stdout, event),
        });
        return { worker, verification: [] };
      },
      verifyIntegration: ({ worktree }) => runVerification({ worktree, command: verify }),
      onEvent: (event) => emitControllerEvent(stdout, event),
    });
    return result;
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
}

async function runFake({ markdown, verify, stdout }) {
  const root = mkdtempSync(join(tmpdir(), "thin-orchestrator-fake-repo-"));
  const runtimeDir = mkdtempSync(join(tmpdir(), "thin-orchestrator-fake-runtime-"));
  try {
    mkdirSync(join(root, "test"), { recursive: true });
    writeFileSync(join(root, "test", "smoke.mjs"), "import assert from 'node:assert/strict'; assert.ok(true);\n");
    git(root, ["init"]); git(root, ["add", "--", "."]);
    git(root, ["-c", "user.name=Thin Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "thin fake base"]);
    stdout("[plan] started");
    const result = await runThinOrchestrator({
      repository: root,
      runtimeDir,
      markdown,
      planner: async () => ({ tasks: [
        { title: "Frontend", prompt: "Create the frontend fixture file.", allowedPaths: ["apps/web"], dependsOn: [] },
        { title: "Backend", prompt: "Create the backend fixture file.", allowedPaths: ["apps/api"], dependsOn: [] },
      ] }),
      workerExecutor: async ({ task, worktree }) => {
        const file = task.title === "Frontend" ? join(worktree, "apps", "web", "fixture.txt") : join(worktree, "apps", "api", "fixture.txt");
        mkdirSync(resolve(file, ".."), { recursive: true });
        writeFileSync(file, `${task.title}\n`);
        return { verification: [] };
      },
      verifyIntegration: async ({ worktree }) => {
        if (verify) return runVerification({ worktree, command: verify });
        await exec(process.execPath, ["--test", "test/smoke.mjs"], { cwd: worktree, encoding: "utf8", timeout: 120_000 });
        return { ok: true };
      },
      onEvent: (event) => emitControllerEvent(stdout, event),
    });
    return result;
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

async function runPlannerTurn({ cwd, prompt, stdout }) {
  const client = new AppServerClient({ cwd, serviceName: "thin-orchestrator-planner" });
  const streamedMessageByItemId = new Map();
  const onNotification = (message) => {
    const params = message?.params ?? {};
    if (message?.method === "item/agentMessage/delta" && typeof params.itemId === "string" && typeof params.delta === "string") {
      streamedMessageByItemId.set(params.itemId, `${streamedMessageByItemId.get(params.itemId) ?? ""}${params.delta}`);
    }
    if (message?.method === "item/completed" && params.item?.type === "agentMessage" && typeof params.item?.text === "string") {
      streamedMessageByItemId.set(params.item.id ?? "completed", params.item.text);
    }
    if (["item/started", "item/completed", "thread/tokenUsage/updated"].includes(message?.method)) stdout("[plan] activity");
  };
  client.on("notification", onNotification);
  try {
    await client.connect();
    const thread = await client.startThread({ cwd });
    const threadId = thread?.thread?.id ?? thread?.threadId;
    if (!threadId) throw new Error("planner thread id unavailable");
    await client.setGoal({ threadId, objective: "Return only the requested planning JSON.", status: "active" });
    const turn = await client.startTurn({ threadId, input: [{ type: "text", text: prompt }] });
    const turnId = turn?.turn?.id ?? turn?.turnId;
    if (!turnId) throw new Error("planner turn id unavailable");
    const terminal = await client.waitForTurn(threadId, turnId, 600_000);
    if (terminal?.status !== "completed") throw new Error(`planner terminal status is '${terminal?.status ?? "unknown"}'`);
    const read = await client.readThread({ threadId, includeTurns: true });
    const text = finalAgentText(read, terminal?.id ?? turnId)
      ?? [...streamedMessageByItemId.values()].reverse().find((value) => typeof value === "string" && value.trim())?.trim();
    if (!text) throw new Error("planner final result unavailable");
    return text;
  } catch (error) {
    // The thin path must make a live failure actionable on its first run.
    // Keep the diagnostic bounded/redacted by AppServerClient and never print
    // raw model output or source Markdown here.
    const diagnostic = client.diagnostics();
    const process = diagnostic?.process;
    const state = process?.exited ? `process_exit:${process.code ?? "unknown"}` : "process_alive";
    const detail = diagnostic?.stderrTail ? ` stderr=${safe(diagnostic.stderrTail)}` : "";
    const wrapped = new Error(`${safe(error?.message)} (${state}${detail})`);
    wrapped.cause = error;
    throw wrapped;
  } finally {
    client.off("notification", onNotification);
    await client.shutdown().catch(() => {});
  }
}

export function finalAgentText(read, turnId = null) {
  const turns = read?.thread?.turns ?? read?.turns ?? [];
  const exact = turnId ? turns.find((turn) => turn?.id === turnId) : null;
  const items = exact?.items ?? turns.at(-1)?.items ?? read?.thread?.items ?? [];
  for (const item of [...items].reverse()) {
    if (item?.type !== "agentMessage") continue;
    const text = item.text ?? item.content?.map?.((part) => part.text ?? "").join("") ?? item.content?.text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return null;
}

function emitWorkerRuntimeEvent(stdout, event) {
  const key = event.taskKey ?? "unknown";
  if (event.kind === "started") stdout(`[worker ${key}] started`);
  else if (event.kind === "activity") stdout(`[worker ${key}] activity`);
  else if (event.kind === "completed") stdout(`[worker ${key}] completed`);
  else if (event.kind === "failed") stdout(`[failure] stage=worker code=${event.code ?? "worker_failed"} task=${key} recovery=-`);
}

function emitControllerEvent(stdout, event) {
  if (event.type === "plan_accepted") stdout("[plan] accepted");
  else if (event.type === "wave_started") stdout(`[wave ${event.waveNumber}] started tasks=${event.taskKeys.length}`);
  else if (event.type === "worker_started") stdout(`[worker ${event.taskKey}] started`);
  else if (event.type === "heartbeat") stdout(`[worker] activity pending=${event.pendingWorkers}`);
  else if (event.type === "commit") stdout(`[worker ${event.taskKey}] committed ${event.commitSha}`);
  else if (event.type === "wave_candidate") stdout(`[wave ${event.waveNumber}] candidate ${event.candidateSha}`);
  else if (event.type === "integration_started") stdout("[integration] started");
  else if (event.type === "integration_test_passed") stdout(`[integration] test passed ${event.candidateSha}`);
  else if (event.type === "completed") stdout(`[completed] candidate ${event.candidateSha}`);
  else if (event.type === "failure") stdout(`[failure] stage=${event.stage} code=${event.code} task=${event.taskKey ?? "-"} recovery=${event.recoveryWorktree ?? "-"}${event.message ? ` message=${safe(event.message)}` : ""}`);
}

async function runVerification({ worktree, command }) {
  const [executable, ...args] = process.platform === "win32"
    ? [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", command]
    : ["/bin/sh", "-lc", command];
  await exec(executable, args, { cwd: worktree, encoding: "utf8", timeout: 120_000 });
  return { ok: true };
}

function git(cwd, args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
function requireText(value, label) { if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`); return value.trim(); }
function safe(value) { return String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 240); }

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const code = await runThinDeliver({});
  process.exitCode = code;
}

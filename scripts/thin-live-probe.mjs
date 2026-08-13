import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runThinDeliver } from "./thin-deliver.mjs";

const FRONTEND_MESSAGE = "Thin frontend worker completed.\n";
const BACKEND_MESSAGE = "Thin backend worker completed.\n";

export function parseThinLiveProbeArgs(argv) {
  const options = { confirm: false, keepFixture: false, help: false };
  for (const value of argv) {
    if (value === "--confirm-spend-quota") options.confirm = true;
    else if (value === "--keep-fixture") options.keepFixture = true;
    else if (value === "--help" || value === "-h") options.help = true;
    else throw new Error(`unknown option: ${value}`);
  }
  return options;
}

export function thinLiveProbeUsage() {
  return "Usage: npm run thin:live-probe -- --confirm-spend-quota [--keep-fixture]";
}

/** Creates the whole disposable acceptance fixture. No file is written in the template repository. */
export function createThinLiveProbeFixture(root) {
  const repository = resolve(root, "repository");
  const docsDirectory = join(repository, "docs");
  mkdirSync(join(repository, "test"), { recursive: true });
  mkdirSync(docsDirectory, { recursive: true });
  writeFileSync(join(repository, "package.json"), JSON.stringify({
    name: "thin-live-probe-fixture",
    private: true,
    type: "module",
    scripts: { test: "node --test test/fixture.test.mjs" }
  }, null, 2) + "\n");
  writeFileSync(join(repository, "test", "fixture.test.mjs"), [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { readFileSync } from 'node:fs';",
    "",
    "test('frontend and backend workers produced the exact fixture files', () => {",
    `  assert.equal(readFileSync('frontend/message.txt', 'utf8').replace(/\\r\\n/g, '\\n'), ${JSON.stringify(FRONTEND_MESSAGE)});`,
    `  assert.equal(readFileSync('backend/message.txt', 'utf8').replace(/\\r\\n/g, '\\n'), ${JSON.stringify(BACKEND_MESSAGE)});`,
    "});",
    ""
  ].join("\n"));
  const taskFile = join(docsDirectory, "task.md");
  writeFileSync(taskFile, [
    "# Thin live probe",
    "",
    "Return exactly this JSON object, with no prose and no Markdown fence:",
    "",
    "```json",
    JSON.stringify({ tasks: [
      {
        title: "Frontend message",
        prompt: `Create frontend/message.txt containing exactly ${JSON.stringify(FRONTEND_MESSAGE)}. Do not edit any other path.`,
        allowedPaths: ["frontend/message.txt"],
        dependsOn: []
      },
      {
        title: "Backend message",
        prompt: `Create backend/message.txt containing exactly ${JSON.stringify(BACKEND_MESSAGE)}. Do not edit any other path.`,
        allowedPaths: ["backend/message.txt"],
        dependsOn: []
      }
    ] }),
    "```",
    "",
    "There are exactly two independent tasks. Do not add, remove, rename, or make them depend on each other.",
    ""
  ].join("\n"));
  git(repository, ["init"]);
  git(repository, ["add", "--", "package.json", "test", "docs"]);
  git(repository, ["-c", "user.name=Thin Live Probe", "-c", "user.email=thin-live-probe@example.test", "commit", "-m", "thin live probe base"]);
  return Object.freeze({ root: resolve(root), repository, taskFile, expected: Object.freeze({ frontend: FRONTEND_MESSAGE, backend: BACKEND_MESSAGE }) });
}

export async function runThinLiveProbe({
  argv = process.argv.slice(2),
  stdout = console.log,
  stderr = console.error,
  runDeliver = runThinDeliver,
  createRoot = () => mkdtempSync(join(tmpdir(), "thin-live-probe-"))
} = {}) {
  let options;
  try { options = parseThinLiveProbeArgs(argv); }
  catch (error) {
    stderr(`[probe] failed stage=argument code=invalid_arguments recovery=- message=${safe(error.message)}`);
    return 2;
  }
  if (options.help) { stdout(thinLiveProbeUsage()); return 0; }
  if (!options.confirm) {
    stderr("[probe] failed stage=admission code=quota_confirmation_required recovery=-");
    return 2;
  }
  if (typeof runDeliver !== "function") throw new TypeError("runDeliver must be a function");

  const root = createRoot();
  let fixture;
  let succeeded = false;
  let thinFailure = null;
  let candidateSha = null;
  const relay = (line) => {
    const text = String(line);
    const candidate = /^\[completed\] candidate ([0-9a-f]{40})$/i.exec(text);
    if (candidate) candidateSha = candidate[1];
    if (text.startsWith("[failure]")) thinFailure ??= parseThinFailure(text);
    stdout(text);
  };
  try {
    fixture = createThinLiveProbeFixture(root);
    stdout("[probe] fixture created");
    stdout("[probe] starting thin delivery");
    const code = await runDeliver({
      argv: ["--repo", fixture.repository, "--docs", fixture.taskFile, "--verify", "npm test", "--confirm-spend-quota"],
      stdout: relay,
      stderr: relay
    });
    if (code !== 0 || !candidateSha) {
      const failure = thinFailure ?? { stage: "delivery", code: code === 0 ? "candidate_sha_unavailable" : "delivery_failed" };
      stderr(`[probe] failed stage=${failure.stage} code=${failure.code} recovery=${fixture.root}`);
      return 1;
    }
    succeeded = true;
    stdout(`[probe] candidate ${candidateSha}`);
    return 0;
  } catch (error) {
    stderr(`[probe] failed stage=fixture code=unexpected_error recovery=${root} message=${safe(error.message)}`);
    return 1;
  } finally {
    if (succeeded && !options.keepFixture) {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      stdout("[probe] fixture removed");
    } else if (fixture) {
      stdout(`[probe] fixture preserved ${fixture.root}`);
    }
  }
}

function parseThinFailure(line) {
  const stage = /stage=([^\s]+)/.exec(line)?.[1] ?? "delivery";
  const code = /code=([^\s]+)/.exec(line)?.[1] ?? "delivery_failed";
  return { stage: safe(stage), code: safe(code) };
}

function git(cwd, args) {
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function safe(value) { return String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 160); }

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runThinLiveProbe();
}

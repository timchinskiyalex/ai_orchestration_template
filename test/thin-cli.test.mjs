import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { finalAgentText, npmPrefixesRequiredBy, parseThinDeliverArgs, readMarkdownPackage, runThinDeliver, runVerification, thinDeliverUsage } from "../scripts/thin-deliver.mjs";

function docsFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "thin-cli-docs-"));
  writeFileSync(join(root, "brief.md"), "# Small project\nBuild two isolated pieces.\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "brief.md");
}

test("fake thin CLI completes a deterministic two-worker candidate with concise progress", async (t) => {
  const docs = docsFixture(t); const output = []; const errors = [];
  const code = await runThinDeliver({ argv: ["--fake", "--docs", docs], stdout: (line) => output.push(line), stderr: (line) => errors.push(line) });
  assert.equal(code, 0); assert.deepEqual(errors, []);
  assert.ok(output.includes("[plan] started"));
  assert.ok(output.includes("[plan] accepted"));
  assert.equal(output.filter((line) => /^\[worker .+\] started$/.test(line)).length, 2);
  assert.equal(output.filter((line) => /^\[worker .+\] committed [0-9a-f]{40}$/.test(line)).length, 2);
  assert.match(output.at(-1), /^\[completed\] candidate [0-9a-f]{40}$/);
});

test("live CLI refuses before reading docs or starting any side effect without quota confirmation", async () => {
  const errors = [];
  const code = await runThinDeliver({ argv: ["--docs", "does-not-exist.md", "--verify", "node --version"], stdout: () => {}, stderr: (line) => errors.push(line) });
  assert.equal(code, 2); assert.deepEqual(errors, ["[failure] stage=admission code=quota_confirmation_required task=- recovery=-"]);
});

test("CLI parses source, repository and verification options", (t) => {
  const docs = docsFixture(t);
  assert.deepEqual(parseThinDeliverArgs(["--docs", docs, "--repo", "repo", "--verify", "node --test", "--confirm-spend-quota"]), {
    repo: "repo", docs, candidate: null, verify: "node --test", repairSurface: null, fake: false, confirm: true,
  });
  assert.deepEqual(parseThinDeliverArgs(["--docs", docs, "--verify", "node --test", "--repair-surface", "src, test/unit ,src"]), {
    repo: process.cwd(), docs, candidate: null, verify: "node --test", repairSurface: ["src", "test/unit"], fake: false, confirm: false,
  });
  assert.match(readMarkdownPackage(docs), /Small project/);
  assert.match(thinDeliverUsage(), /thin-deliver/);
});

test("planner result reader chooses the exact resolved turn rather than an unrelated latest turn", () => {
  const result = { thread: { turns: [
    { id: "planner-turn", items: [{ type: "agentMessage", text: "{\"tasks\":[]}" }] },
    { id: "other-turn", items: [{ type: "agentMessage", text: "not the planner result" }] },
  ] } };
  assert.equal(finalAgentText(result, "planner-turn"), "{\"tasks\":[]}");
});

test("verification installs lockfile-pinned npm dependencies before the declared build", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "thin-verification-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "apps", "web"), { recursive: true });
  writeFileSync(join(root, "apps", "web", "package-lock.json"), "{}");
  const calls = [];
  await runVerification({ worktree: root, command: "npm --prefix apps/web run build", processRunner: async (call) => { calls.push(call); } });
  if (process.platform === "win32") assert.equal(calls[0].args.at(-1), "npm ci");
  else assert.deepEqual(calls[0].args, ["ci"]);
  assert.equal(calls[0].cwd, join(root, "apps", "web"));
  assert.equal(calls[1].args.at(-1), "npm --prefix apps/web run build");
  assert.deepEqual(npmPrefixesRequiredBy("dotnet test x && npm --prefix apps/web run build"), ["apps/web"]);
});

test("verification rejects a dotnet success exit that discovered no tests", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "thin-verification-empty-tests-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    runVerification({ worktree: root, command: "dotnet test api/tests.csproj", processRunner: async () => ({ stdout: "No test is available in output" }) }),
    /no discovered .NET tests/,
  );
});

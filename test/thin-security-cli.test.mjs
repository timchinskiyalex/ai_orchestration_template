import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseThinSecurityArgs, runThinSecurity, thinSecurityUsage } from "../scripts/thin-security.mjs";

test("security CLI reports a candidate-bound passing result through its isolated controller seam", async (t) => {
  const runtime = mkdtempSync(join(tmpdir(), "thin-security-cli-")); t.after(() => rmSync(runtime, { recursive: true, force: true }));
  const output = [];
  const code = await runThinSecurity({
    argv: ["--repo", "repo", "--candidate", "abcdef1234567", "--verify", "npm --prefix apps/web run build"],
    stdout: (line) => output.push(line), stderr: (line) => output.push(line),
    dependencies: {
      createRuntimeDir: () => runtime,
      createIsolatedWorktree: async () => ({ worktree: "candidate-worktree", baseSha: "abcdef1234567", repository: "repo" }),
      removeIsolatedWorktree: async () => ({ state: "completed" }),
      scan: async (request) => { assert.equal(request.candidateSha, "abcdef1234567"); assert.equal(request.worktree, "candidate-worktree"); return { state: "passed", candidateSha: request.candidateSha }; },
    },
  });
  assert.equal(code, 0); assert.ok(output.includes("[security] passed candidate=abcdef1234567"));
});

test("security CLI preserves its worktree on blocked or unavailable scans", async (t) => {
  const runtime = mkdtempSync(join(tmpdir(), "thin-security-cli-")); t.after(() => rmSync(runtime, { recursive: true, force: true }));
  const output = [];
  const code = await runThinSecurity({
    argv: ["--repo", "repo", "--candidate", "abcdef1234567", "--verify", "node --test"], stdout: (line) => output.push(line), stderr: (line) => output.push(line),
    dependencies: { createRuntimeDir: () => runtime, createIsolatedWorktree: async () => ({ worktree: "candidate-worktree", baseSha: "abcdef1234567" }), scan: async () => ({ state: "blocked_security" }) },
  });
  assert.equal(code, 1); assert.ok(output.includes("[failure] stage=security code=blocked_security recovery=candidate-worktree"));
  assert.ok(output.some((line) => line.includes("runtime preserved")));
});

test("security CLI parses only explicit supported inputs", () => {
  assert.deepEqual(parseThinSecurityArgs(["--candidate", "abcdef1234567", "--verify", "node --test", "--root", "apps/web"]), { repo: process.cwd(), candidate: "abcdef1234567", verify: "node --test", roots: ["apps/web"] });
  assert.match(thinSecurityUsage(), /thin-security/);
});

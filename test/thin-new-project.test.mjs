import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyMarkdownSnapshot, createThinNewProject, parseThinNewProjectArgs, runThinNewProject, thinNewProjectUsage } from "../scripts/thin-new-project.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "thin-new-project-test-"));
  const docs = join(root, "input-docs");
  mkdirSync(join(docs, "nested"), { recursive: true });
  writeFileSync(join(docs, "brief.md"), "# Brief\nBuild a project.\n");
  writeFileSync(join(docs, "nested", "details.md"), "# Details\nUse tests.\n");
  const target = join(root, "new-project");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, docs, target };
}

function git(cwd, args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim(); }

test("new project creates a source snapshot and baseline before injected thin delivery", async (t) => {
  const { docs, target } = fixture(t); const received = [];
  const result = await createThinNewProject({
    target, docs, verify: "node --test", confirm: true,
    deliveryRunner: async (request) => { received.push(request); return { ok: true, candidateSha: "abcdef1234567" }; },
    stdout: () => {},
  });
  assert.equal(result.ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].repository, target);
  assert.equal(received[0].docs, join(target, "docs", "source"));
  assert.equal(received[0].verify, "node --test");
  assert.match(result.baselineSha, /^[0-9a-f]{40}$/);
  assert.equal(readFileSync(join(target, "docs", "source", "nested", "details.md"), "utf8"), "# Details\nUse tests.\n");
  assert.match(git(target, ["log", "-1", "--format=%s"]), /source documentation baseline/);
});

test("existing target is refused before delivery and never overwritten", async (t) => {
  const { docs, target } = fixture(t); mkdirSync(target); writeFileSync(join(target, "user.txt"), "preserve me");
  let called = false;
  await assert.rejects(createThinNewProject({ target, docs, verify: "node --test", confirm: true, deliveryRunner: async () => { called = true; } }), /target already exists/);
  assert.equal(called, false);
  assert.equal(readFileSync(join(target, "user.txt"), "utf8"), "preserve me");
});

test("failed delivery preserves the new target and returns a recovery path", async (t) => {
  const { docs, target } = fixture(t); const output = [];
  const result = await createThinNewProject({
    target, docs, verify: "node --test", confirm: true,
    deliveryRunner: async () => ({ ok: false }), stdout: (line) => output.push(line),
  });
  assert.equal(result.ok, false); assert.equal(result.code, "delivery_failed");
  assert.equal(result.recoveryPath, target); assert.equal(existsSync(join(target, ".git")), true);
  assert.ok(output.some((line) => line.includes("target preserved")));
});

test("repair surface is explicit and passed unchanged to the delivery seam", async (t) => {
  const { docs, target } = fixture(t); let request;
  const result = await createThinNewProject({
    target, docs, verify: "node --test", repairSurface: "apps/web,test", confirm: true,
    deliveryRunner: async (value) => { request = value; return { ok: true, candidateSha: "abcdef1234567" }; }, stdout: () => {},
  });
  assert.equal(result.ok, true); assert.deepEqual(request.repairSurface, ["apps/web", "test"]);
});

test("remote is configured and pushed only after a verified candidate", async (t) => {
  const { docs, target } = fixture(t); const gitCalls = [];
  const gitRunner = async ({ cwd, args }) => {
    gitCalls.push(args);
    if (args[0] === "push") return "";
    return git(cwd, args);
  };
  const result = await createThinNewProject({
    target, docs, verify: "node --test", remote: "https://example.test/repo.git", branch: "pilot/thin", confirm: true,
    deliveryRunner: async () => ({ ok: true, candidateSha: "abcdef1234567" }), gitRunner, stdout: () => {},
  });
  assert.equal(result.ok, true);
  const baseline = gitCalls.findIndex((args) => args.includes("commit"));
  const remote = gitCalls.findIndex((args) => args[0] === "remote");
  const pushed = gitCalls.findIndex((args) => args[0] === "push");
  assert.ok(baseline >= 0 && remote > baseline && pushed > remote);
  assert.deepEqual(gitCalls[pushed], ["push", "--set-upstream", "origin", "pilot/thin:pilot/thin"]);
});

test("acceptance runs after delivery and before remote publication", async (t) => {
  const { docs, target } = fixture(t); const order = []; const gitCalls = [];
  const gitRunner = async ({ cwd, args }) => {
    gitCalls.push(args);
    if (args[0] === "remote" || args[0] === "push") { order.push(args[0]); return ""; }
    return git(cwd, args);
  };
  const result = await createThinNewProject({
    target, docs, verify: "node --test", repairSurface: "apps/api,apps/web", acceptance: true,
    remote: "https://example.test/repo.git", branch: "orchestrated/new-product", confirm: true, gitRunner,
    deliveryRunner: async () => { order.push("delivery"); return { ok: true, candidateSha: "abcdef1234567" }; },
    acceptanceRunner: async (request) => {
      order.push("acceptance");
      assert.equal(request.candidateSha, "abcdef1234567");
      assert.deepEqual(request.repairSurface, ["apps/api", "apps/web"]);
      return { ok: true, candidateSha: "fedcba7654321" };
    },
    stdout: () => {},
  });
  assert.equal(result.ok, true); assert.equal(result.candidateSha, "fedcba7654321");
  assert.deepEqual(order, ["delivery", "acceptance", "remote", "push"]);
  const pushed = gitCalls.find((args) => args[0] === "push");
  assert.deepEqual(pushed, ["push", "--set-upstream", "origin", "orchestrated/new-product:orchestrated/new-product"]);
});

test("a repaired acceptance candidate is the only remote ref pushed", async (t) => {
  const { docs, target } = fixture(t); const gitCalls = [];
  const gitRunner = async ({ cwd, args }) => {
    gitCalls.push(args);
    if (args[0] === "remote" || args[0] === "push") return "";
    return git(cwd, args);
  };
  const result = await createThinNewProject({
    target, docs, verify: "node --test", repairSurface: "apps/api", acceptance: true,
    remote: "https://example.test/repo.git", branch: "orchestrated/new-product", confirm: true, gitRunner,
    deliveryRunner: async () => ({ ok: true, candidateSha: "abcdef1234567" }),
    acceptanceRunner: async () => ({ ok: true, candidateSha: "fedcba7654321", candidateBranch: "thin/acceptance-candidate-repair-1" }),
    stdout: () => {},
  });
  assert.equal(result.ok, true); assert.equal(result.branch, "thin/acceptance-candidate-repair-1");
  assert.deepEqual(gitCalls.find((args) => args[0] === "push"), ["push", "--set-upstream", "origin", "thin/acceptance-candidate-repair-1:thin/acceptance-candidate-repair-1"]);
  assert.equal(gitCalls.some((args) => args[0] === "branch" && args.includes("-M")), false);
});

test("failed acceptance preserves the target and blocks all remote actions", async (t) => {
  const { docs, target } = fixture(t); const gitCalls = [];
  const gitRunner = async ({ cwd, args }) => { gitCalls.push(args); return git(cwd, args); };
  const result = await createThinNewProject({
    target, docs, verify: "node --test", repairSurface: "apps/api", acceptance: true,
    remote: "https://example.test/repo.git", branch: "orchestrated/new-product", confirm: true, gitRunner,
    deliveryRunner: async () => ({ ok: true, candidateSha: "abcdef1234567" }),
    acceptanceRunner: async () => ({ ok: false }), stdout: () => {},
  });
  assert.equal(result.ok, false); assert.equal(result.code, "acceptance_failed"); assert.equal(existsSync(join(target, ".git")), true);
  assert.equal(gitCalls.some((args) => args[0] === "remote" || args[0] === "push"), false);
});

test("acceptance requires an explicit repair surface before target creation", async (t) => {
  const { docs, target } = fixture(t);
  await assert.rejects(createThinNewProject({ target, docs, verify: "node --test", acceptance: true, confirm: true }), /acceptance requires/);
  assert.equal(existsSync(target), false);
});

test("failed delivery never configures or pushes a remote", async (t) => {
  const { docs, target } = fixture(t); const gitCalls = [];
  const gitRunner = async ({ cwd, args }) => {
    gitCalls.push(args);
    return git(cwd, args);
  };
  const result = await createThinNewProject({
    target, docs, verify: "node --test", remote: "https://example.test/repo.git", branch: "pilot/thin", confirm: true,
    deliveryRunner: async () => ({ ok: false }), gitRunner, stdout: () => {},
  });
  assert.equal(result.ok, false);
  assert.equal(gitCalls.some((args) => args[0] === "remote" || args[0] === "push"), false);
});

test("Windows-safe path and remote validation rejects unsafe input before target creation", async (t) => {
  const { docs, target } = fixture(t);
  await assert.rejects(createThinNewProject({ target: "relative-target", docs, verify: "node --test", confirm: true }), /absolute path/);
  await assert.rejects(createThinNewProject({ target, docs, verify: "node --test", repairSurface: "../src", confirm: true }), /traversal/);
  await assert.rejects(createThinNewProject({ target, docs, verify: "node --test", remote: "https://example.test/repo.git", confirm: true }), /supplied together/);
  await assert.rejects(createThinNewProject({ target, docs, verify: "node --test", remote: "https://example.test/repo.git", branch: "main", confirm: true }), /must not be main/);
  assert.equal(existsSync(target), false);
});

test("argument parsing and CLI report safe failures", async (t) => {
  const { docs, target } = fixture(t); const errors = [];
  assert.deepEqual(parseThinNewProjectArgs(["--target", target, "--docs", docs, "--verify", "node --test", "--confirm-spend-quota"]), {
    target, docs, verify: "node --test", repairSurface: null, remote: null, branch: null, confirm: true, acceptance: false,
  });
  assert.match(thinNewProjectUsage(), /thin-new-project/);
  const code = await runThinNewProject({ argv: ["--target", target, "--docs", docs], stdout: () => {}, stderr: (line) => errors.push(line) });
  assert.equal(code, 2); assert.match(errors[0], /invalid_arguments/);
});

test("snapshot does not overwrite and refuses source symlinks when supported", (t) => {
  const { docs, root } = fixture(t); const destination = join(root, "snapshot");
  const copied = copyMarkdownSnapshot({ source: docs, destination });
  assert.deepEqual(copied, ["brief.md", "nested/details.md"]);
  assert.throws(() => copyMarkdownSnapshot({ source: docs, destination }), /already exists/);
});

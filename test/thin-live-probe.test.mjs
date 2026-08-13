import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createThinLiveProbeFixture, parseThinLiveProbeArgs, runThinLiveProbe, thinLiveProbeUsage } from "../scripts/thin-live-probe.mjs";

test("live probe refuses quota spending before creating a fixture", async () => {
  let roots = 0; const errors = [];
  const code = await runThinLiveProbe({ argv: [], stdout: () => {}, stderr: (line) => errors.push(line), createRoot: () => { roots += 1; return "must-not-exist"; } });
  assert.equal(code, 2); assert.equal(roots, 0);
  assert.deepEqual(errors, ["[probe] failed stage=admission code=quota_confirmation_required recovery=-"]);
});

test("probe fixture contains an exact two-task plan and npm verification", (t) => {
  const root = mkdtempSync(join(tmpdir(), "thin-live-probe-fixture-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = createThinLiveProbeFixture(root);
  const task = readFileSync(fixture.taskFile, "utf8");
  const plan = JSON.parse(task.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(plan.tasks.length, 2);
  assert.deepEqual(plan.tasks.map((item) => item.allowedPaths), [["frontend/message.txt"], ["backend/message.txt"]]);
  assert.deepEqual(plan.tasks.map((item) => item.dependsOn), [[], []]);
  assert.match(readFileSync(join(fixture.repository, "package.json"), "utf8"), /node --test test\/fixture\.test\.mjs/);
  const verification = readFileSync(join(fixture.repository, "test", "fixture.test.mjs"), "utf8");
  assert.match(verification, /frontend\/message\.txt/); assert.match(verification, /backend\/message\.txt/);
});

test("probe invokes thin delivery with the isolated repository, exact docs, npm test, and confirmation", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "thin-live-probe-invocation-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let invocation; const output = [];
  const code = await runThinLiveProbe({
    argv: ["--confirm-spend-quota", "--keep-fixture"], createRoot: () => root,
    stdout: (line) => output.push(line), stderr: (line) => output.push(line),
    runDeliver: async (args) => { invocation = args; args.stdout("[completed] candidate 0123456789012345678901234567890123456789"); return 0; }
  });
  assert.equal(code, 0);
  assert.deepEqual(invocation.argv.slice(-2), ["npm test", "--confirm-spend-quota"]);
  assert.equal(invocation.argv[0], "--repo"); assert.ok(existsSync(invocation.argv[1]));
  assert.deepEqual(invocation.argv.slice(2, 5), ["--docs", join(root, "repository", "docs", "task.md"), "--verify"]);
  assert.ok(output.includes("[probe] candidate 0123456789012345678901234567890123456789"));
  assert.ok(output.includes(`[probe] fixture preserved ${root}`));
});

test("probe preserves the recovery root when thin delivery fails", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "thin-live-probe-failure-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = [];
  const code = await runThinLiveProbe({
    argv: ["--confirm-spend-quota"], createRoot: () => root,
    stdout: (line) => output.push(line), stderr: (line) => output.push(line),
    runDeliver: async ({ stderr }) => { stderr("[failure] stage=worker code=worker_failed task=task-1 recovery=example"); return 1; }
  });
  assert.equal(code, 1);
  assert.ok(output.includes(`[probe] failed stage=worker code=worker_failed recovery=${root}`));
  assert.ok(output.includes(`[probe] fixture preserved ${root}`));
  assert.ok(existsSync(join(root, "repository")));
});

test("probe parser only accepts explicit supported options", () => {
  assert.deepEqual(parseThinLiveProbeArgs(["--confirm-spend-quota", "--keep-fixture"]), { confirm: true, keepFixture: true, help: false });
  assert.match(thinLiveProbeUsage(), /confirm-spend-quota/);
  assert.throws(() => parseThinLiveProbeArgs(["--repo", "x"]), /unknown option/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("npm run integrate dispatches to the integration CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "integrate-cli-"));
  try {
    const config = { project: { name: "test", projectMode: { schemaVersion: 1, kind: "ProjectMode", mode: "greenfield" } }, repository: root, runtimeDir: join(root, "runtime"), baseRef: "main", roles: Object.fromEntries(["bootstrap", "planner", "backend", "frontend", "database", "qa", "security", "devops"].map((role) => [role, { sandbox: "read-only", approvalPolicy: "never", tokenBudget: 100, maxAttempts: 1, usesWorktree: false }])) };
    const path = join(root, "swarm.json"); writeFileSync(path, JSON.stringify(config), "utf8");
    const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm run integrate -- --tasks missing"], { cwd: process.cwd(), env: { ...process.env, SWARM_CONFIG: path }, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /Task missing has no finalized WorkerArtifact/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

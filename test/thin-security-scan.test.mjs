import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverThinSecurityTargets, scanThinCandidateSecurity } from "../src/thin/security-scan.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "thin-security-scan-"));
  mkdirSync(join(root, "apps", "web"), { recursive: true });
  mkdirSync(join(root, "apps", "api"), { recursive: true });
  writeFileSync(join(root, "apps", "web", "package.json"), "{}\n");
  writeFileSync(join(root, "apps", "api", "App.sln"), "\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const sha = "abcdef1234567890";

test("security target discovery lexes explicit verification roots without shell expansion", () => {
  assert.deepEqual(discoverThinSecurityTargets({ verificationCommand: 'dotnet test apps/api/App.sln && npm --prefix "apps/web" run build' }), [
    { ecosystem: "dotnet", root: "apps/api/App.sln" },
    { ecosystem: "npm", root: "apps/web" },
  ]);
  assert.throws(() => discoverThinSecurityTargets({ productRoots: ["../escape"] }), /normalized relative/);
});

test("security report is candidate-bound and passes clean npm and dotnet scans", async (t) => {
  const root = fixture(t); const calls = [];
  const report = await scanThinCandidateSecurity({
    worktree: root, candidateSha: sha, verificationCommand: "npm --prefix apps/web run build && dotnet test apps/api/App.sln",
    processRunner: async (call) => { calls.push(call); return /npm(?:\.cmd)?$/i.test(call.executable) ? { stdout: JSON.stringify({ metadata: { vulnerabilities: {} }, vulnerabilities: {} }) } : { stdout: JSON.stringify({ projects: [] }) }; },
  });
  assert.equal(report.state, "passed"); assert.equal(report.candidateSha, sha); assert.equal(report.summary.targetCount, 2);
  assert.deepEqual(calls[0].args, ["list", "apps/api/App.sln", "package", "--vulnerable", "--include-transitive", "--format", "json"]);
  assert.equal(calls[1].executable, process.platform === "win32" ? "npm.cmd" : "npm");
  assert.deepEqual(calls[1].args, ["audit", "--json"]);
});

test("high and critical vulnerabilities block publication", async (t) => {
  const root = fixture(t);
  const report = await scanThinCandidateSecurity({
    worktree: root, candidateSha: sha, verificationCommand: "npm --prefix apps/web run build",
    processRunner: async () => ({ stdout: JSON.stringify({ metadata: {}, vulnerabilities: { next: { severity: "high" }, react: { severity: "critical" } } }) }),
  });
  assert.equal(report.state, "blocked_security"); assert.equal(report.summary.blockingFindingCount, 2);
  assert.deepEqual(report.scans[0].findings.map((finding) => finding.severity), ["high", "critical"]);
});

test("tool failures and malformed scanner output fail closed as scan_unavailable", async (t) => {
  const root = fixture(t);
  const unavailable = await scanThinCandidateSecurity({ worktree: root, candidateSha: sha, verificationCommand: "npm --prefix apps/web run build", processRunner: async () => { throw Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }); } });
  assert.equal(unavailable.state, "scan_unavailable"); assert.equal(unavailable.scans[0].reasonCode, "tool_unavailable");
  const malformed = await scanThinCandidateSecurity({ worktree: root, candidateSha: sha, verificationCommand: "npm --prefix apps/web run build", processRunner: async () => ({ stdout: "not json" }) });
  assert.equal(malformed.state, "scan_unavailable"); assert.equal(malformed.scans[0].reasonCode, "malformed_npm_audit_json");
});

test("no applicable ecosystem is a clean explicit no-op", async (t) => {
  const root = fixture(t); let called = false;
  const report = await scanThinCandidateSecurity({ worktree: root, candidateSha: sha, verificationCommand: "node --test", processRunner: async () => { called = true; } });
  assert.equal(report.state, "passed"); assert.equal(report.summary.targetCount, 0); assert.equal(called, false);
});

test("dotnet fallback parses vulnerable packages after unsupported json format", async (t) => {
  const root = fixture(t); const calls = [];
  const report = await scanThinCandidateSecurity({
    worktree: root, candidateSha: sha, verificationCommand: "dotnet test apps/api/App.sln",
    processRunner: async (call) => { calls.push(call); if (calls.length === 1) throw new Error("Unrecognized option '--format'"); return { stdout: " > Newtonsoft.Json 13.0.1 High https://advisory.example" }; },
  });
  assert.equal(calls.length, 2); assert.equal(report.state, "blocked_security"); assert.equal(report.scans[0].findings[0].packageName, "Newtonsoft.Json");
});

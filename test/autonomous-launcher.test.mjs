import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("autonomous launcher has no interactive prompt and starts the complete delivery command", () => {
  const script = readFileSync(join(root, "scripts", "start-delivery.ps1"), "utf8");
  assert.doesNotMatch(script, /Read-Host|APPROVE|OVERRIDE|\bPUSH\b/i);
  assert.match(script, /src\/index\.mjs recover/);
  assert.match(script, /NODE_NO_WARNINGS/);
  assert.match(script, /Main window will print stage and budget progress/);
  assert.match(script, /Checking stale delivery leases before starting/);
  assert.match(script, /src\/index\.mjs', 'deliver/);
  assert.match(script, /completed_merged/);
  assert.match(script, /\[string\]\$Source/);
  assert.match(script, /Provide -Source <requirements-dir>/);
  assert.match(script, /Resolve-Path -LiteralPath \$Source/);
  assert.match(script, /\$deliveryArgs \+= @\('--source', \$source\)/);
  assert.match(script, /\$localCandidateSuccess = \$final\.deliveryRun\.state -eq 'completed_candidate_ready'/);
  assert.match(script, /publish\.localCandidate -eq \$true/);
  assert.match(script, /\$resumable = @\('interrupted', 'blocked_credentials', 'blocked_ci', 'blocked_branch_protection'/);
  assert.match(script, /\$resume = \$status\.deliveryRun -and \(\$resumable -contains \$status\.deliveryRun\.state\)/);
  assert.doesNotMatch(script, /\$resumable = @[^\n]*'failed'/);
  assert.match(script, /docs\/orchestration-generated/);
  const index = readFileSync(join(root, "src", "index.mjs"), "utf8");
  assert.match(index, /"deterministic scaffold started": "scaffold started"/);
  assert.match(index, /"budget interrupt requested": "budget interrupt"/);
  assert.match(index, /FINAL DELIVERY SUMMARY/);
  assert.match(index, /process\.exitCode = deliveryExitCode\(delivery\)/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { parseThinAcceptArgs, thinAcceptUsage } from "../scripts/thin-accept.mjs";

test("thin acceptance CLI parses only explicit candidate and repair inputs", () => {
  const parsed = parseThinAcceptArgs(["--repo", "repo", "--docs", "docs", "--candidate", "abcdef1", "--verify", "node --test", "--repair-surface", "apps/api, apps/web", "--confirm-spend-quota"]);
  assert.deepEqual(parsed, { repo: "repo", docs: "docs", candidate: "abcdef1", verify: "node --test", repairSurface: ["apps/api", "apps/web"], confirm: true, help: false });
  assert.match(thinAcceptUsage(), /thin-accept/);
});

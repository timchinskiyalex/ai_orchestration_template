import { runCodexRuntimeProbe } from "../src/codex-runtime-probe.mjs";

try {
  await runCodexRuntimeProbe({ args: process.argv.slice(2) });
} catch (error) {
  console.error(error?.message ?? "Codex runtime probe failed.");
  process.exitCode = 1;
}

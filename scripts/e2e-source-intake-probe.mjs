import { parseSourceIntakeProbeArgs, runSourceIntakeProbe } from "../src/source-intake-probe.mjs";

try {
  parseSourceIntakeProbeArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

if (!process.exitCode) {
  const result = await runSourceIntakeProbe();
  if (result.status !== "passed") {
    console.error(`[intake-probe] probe failed; root=${result.root}; report=${result.reportPath}`);
    process.exitCode = 1;
  }
}

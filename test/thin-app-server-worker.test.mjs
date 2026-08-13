import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { buildThinWorkerGoal, runThinAppServerWorker, ThinAppServerWorkerError } from "../src/thin/app-server-worker.mjs";

class FakeClient extends EventEmitter {
  constructor({ terminal = "completed", failure = null } = {}) {
    super();
    this.terminal = terminal; this.failure = failure; this.calls = []; this.closed = false;
  }
  async connect() { this.calls.push(["connect"]); if (this.failure === "connect") throw new Error("connection unavailable"); }
  async startThread(args) { this.calls.push(["thread/start", args]); return { thread: { id: "thread-thin" } }; }
  async setGoal(args) { this.calls.push(["goal/set", args]); }
  async startTurn(args) {
    this.calls.push(["turn/start", args]);
    this.emit("notification", { method: "item/started", params: { threadId: args.threadId, turnId: "turn-thin", item: { type: "agentMessage" } } });
    return { turn: { id: "turn-thin" } };
  }
  async waitForTurn(threadId, turnId, timeoutMs) {
    this.calls.push(["turn/wait", { threadId, turnId, timeoutMs }]);
    if (this.failure === "timeout") throw new Error("timed out waiting for turn");
    if (this.failure === "error") throw new Error("provider disconnected");
    this.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { totalTokens: 9 } } });
    return { id: "turn-resolved", status: this.terminal };
  }
  diagnostics() { return { process: { alive: !this.closed, exited: false, code: null, signal: null }, stderrTail: "secret=example", protocolEvents: [{ direction: "notification", method: "item/started", threadId: "thread-thin", turnId: "turn-thin" }] }; }
  async shutdown() { this.closed = true; this.calls.push(["shutdown"]); }
}

const workerArgs = Object.freeze({ cwd: "D:/controller/worktrees/task-1", taskKey: "task-1", prompt: "Create the backend endpoint.", allowedPaths: ["apps/api"], timeoutMs: 123 });

test("thin worker uses exact controller cwd, starts one App Server turn, emits activity, and always shuts down", async () => {
  const client = new FakeClient(); const events = [];
  const result = await runThinAppServerWorker({ ...workerArgs, onEvent: (event) => events.push(event), clientFactory: ({ cwd, taskKey }) => {
    assert.equal(cwd, workerArgs.cwd); assert.equal(taskKey, workerArgs.taskKey); return client;
  } });
  assert.equal(client.calls.find(([name]) => name === "thread/start")[1].cwd, workerArgs.cwd);
  const goal = client.calls.find(([name]) => name === "goal/set")[1].objective;
  assert.match(goal, /edit only these declared relative paths/i);
  assert.match(goal, /- apps\/api/);
  assert.match(goal, /Do not create a Git commit/);
  assert.deepEqual(client.calls.map(([name]) => name), ["connect", "thread/start", "goal/set", "turn/start", "turn/wait", "shutdown"]);
  assert.equal(result.threadId, "thread-thin");
  assert.equal(result.requestedTurnId, "turn-thin");
  assert.equal(result.resolvedTurnId, "turn-resolved");
  assert.equal(result.terminalStatus, "completed");
  assert.deepEqual(events.map((event) => event.kind), ["activity", "started", "activity", "completed"]);
  assert.equal(client.closed, true);
});

test("thin worker rejects non-completed terminal status and reports a failed event", async () => {
  const client = new FakeClient({ terminal: "failed" }); const events = [];
  await assert.rejects(runThinAppServerWorker({ ...workerArgs, onEvent: (event) => events.push(event), clientFactory: () => client }), (error) => {
    assert.ok(error instanceof ThinAppServerWorkerError);
    assert.equal(error.code, "worker_not_completed"); assert.equal(error.terminalStatus, "failed"); return true;
  });
  assert.equal(events.at(-1).kind, "failed"); assert.equal(client.closed, true);
});

test("thin worker surfaces timeout and transport errors with bounded diagnostics and shutdown", async () => {
  for (const failure of ["timeout", "error", "connect"]) {
    const client = new FakeClient({ failure });
    await assert.rejects(runThinAppServerWorker({ ...workerArgs, clientFactory: () => client }), (error) => {
      assert.ok(error instanceof ThinAppServerWorkerError);
      assert.equal(error.code, failure === "timeout" ? "worker_timeout" : "transport_failure");
      assert.ok(error.diagnostics); return true;
    });
    assert.equal(client.closed, true);
  }
});

test("thin worker goal rejects missing or unsafe declared paths before connecting", async () => {
  assert.throws(() => buildThinWorkerGoal({ taskKey: "task", prompt: "x", allowedPaths: [] }), /at least one/);
  assert.throws(() => buildThinWorkerGoal({ taskKey: "task", prompt: "x", allowedPaths: ["../outside"] }), /normalized relative/);
  let called = false;
  await assert.rejects(runThinAppServerWorker({ ...workerArgs, allowedPaths: ["C:/outside"], clientFactory: () => { called = true; return new FakeClient(); } }), /normalized relative/);
  assert.equal(called, false);
});

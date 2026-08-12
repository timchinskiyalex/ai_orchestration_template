import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AppServerClient } from "../src/app-server-client.mjs";
import { agentResultForTurn } from "../src/app-server-execution-provider.mjs";

function clientWithWritableStdin({ fallbackReadTimeoutMs = 10, onWrite = null } = {}) {
  const client = new AppServerClient({ cwd: process.cwd(), requestTimeoutMs: fallbackReadTimeoutMs, fallbackReadTimeoutMs });
  client.proc = {
    killed: false,
    stdin: {
      writable: true,
      write(line) {
        const message = JSON.parse(line);
        onWrite?.(message, client);
        return true;
      }
    },
    kill() { this.killed = true; }
  };
  client.process.alive = true;
  return client;
}

const completed = (threadId = "thread-1", turnId = "turn-1") => ({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
const itemStarted = (threadId = "thread-1", turnId = "turn-1") => ({ method: "item/started", params: { threadId, turnId, item: { type: "agentMessage", status: "inProgress" } } });

test("waitForTurn resolves when completion arrives before subscription", async () => {
  const client = clientWithWritableStdin();
  client.ingestProtocolMessage(completed());
  assert.equal((await client.waitForTurn("thread-1", "turn-1", 100)).status, "completed");
});

test("a response delivered synchronously during stdin.write resolves the request", async () => {
  const client = clientWithWritableStdin({
    onWrite(message, instance) {
      if (message.method === "thread/start") instance.ingestProtocolMessage({ id: message.id, result: { thread: { id: "thread-1" } } });
    }
  });
  const response = await client.startThread({});
  assert.equal(response.thread.id, "thread-1");
  assert.equal(client.pending.size, 0);
});

test("initialize handshake resolves from App Server stdout", async () => {
  let client;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.stdin = {
    writable: true,
    write(line) {
      const message = JSON.parse(line);
      if (message.method === "initialize") child.stdout.write(`${JSON.stringify({ id: message.id, result: { serverInfo: { name: "fake" } } })}\n`);
      return true;
    }
  };
  client = new AppServerClient({
    cwd: process.cwd(), requestTimeoutMs: 20,
    spawnProcess: () => child,
    appServerLauncher: () => ({ command: "fake-codex", args: ["app-server"] })
  });
  await client.connect();
  assert.equal(client.pending.size, 0);
  client.shutdown();
});

test("stderr and process exit are retained in failed connect diagnostics", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.stdin = {
    writable: true,
    write() {
      child.stderr.write("app-server startup failure\n");
      setImmediate(() => child.emit("exit", 7, null));
      return true;
    }
  };
  const client = new AppServerClient({
    cwd: process.cwd(), requestTimeoutMs: 100,
    spawnProcess: () => child,
    appServerLauncher: () => ({ command: "fake-codex", args: ["app-server"] })
  });
  await assert.rejects(client.connect(), /App Server exited/);
  const diagnostics = client.diagnostics();
  assert.match(diagnostics.stderrTail, /startup failure/);
  assert.deepEqual(diagnostics.process, { alive: false, exited: true, code: 7, signal: null });
});

test("write error rejects a request and removes its pending entry", async () => {
  const client = clientWithWritableStdin();
  client.proc.stdin.write = () => { throw new Error("stdin write failed"); };
  await assert.rejects(client.request("thread/start", {}), /stdin write failed/);
  assert.equal(client.pending.size, 0);
});

test("shutdown and process exit reject outstanding requests without pending leaks", async () => {
  const shutdownClient = clientWithWritableStdin();
  const shutdownRequest = shutdownClient.request("thread/start", {});
  shutdownClient.shutdown();
  await assert.rejects(shutdownRequest, /App Server client closed/);
  assert.equal(shutdownClient.pending.size, 0);

  const exitedClient = clientWithWritableStdin();
  const exitedRequest = exitedClient.request("thread/start", {});
  exitedClient.handleProcessExit({ code: 1, signal: null });
  await assert.rejects(exitedRequest, /App Server exited/);
  assert.equal(exitedClient.pending.size, 0);
});

test("an asynchronous response continues to resolve requests", async () => {
  const client = clientWithWritableStdin({
    onWrite(message, instance) {
      if (message.method === "thread/start") setImmediate(() => instance.ingestProtocolMessage({ id: message.id, result: { thread: { id: "thread-async" } } }));
    }
  });
  assert.equal((await client.startThread({})).thread.id, "thread-async");
  assert.equal(client.pending.size, 0);
});

test("waitForTurn resolves when completion arrives after subscription", async () => {
  const client = clientWithWritableStdin();
  const waiting = client.waitForTurn("thread-1", "turn-1", 100);
  client.ingestProtocolMessage(completed());
  assert.equal((await waiting).id, "turn-1");
});

test("waitForTurn aliases one observed resolved turn in the same thread", async () => {
  const client = clientWithWritableStdin();
  const waiting = client.waitForTurn("thread-1", "requested-A", 100);
  client.ingestProtocolMessage(itemStarted("thread-1", "resolved-B"));
  client.ingestProtocolMessage(completed("thread-1", "resolved-B"));
  assert.equal((await waiting).id, "resolved-B");
  const alias = client.protocolEvents().find((event) => event.method === "turn-id-alias");
  assert.deepEqual({ threadId: alias.threadId, requestedTurnId: alias.requestedTurnId, resolvedTurnId: alias.resolvedTurnId }, { threadId: "thread-1", requestedTurnId: "requested-A", resolvedTurnId: "resolved-B" });
});

test("completion from another thread is never accepted as an alias", async () => {
  const client = clientWithWritableStdin();
  const waiting = client.waitForTurn("thread-1", "requested-A", 100);
  client.ingestProtocolMessage(itemStarted("thread-1", "resolved-B"));
  client.ingestProtocolMessage(completed("thread-2", "resolved-B"));
  client.ingestProtocolMessage(completed("thread-1", "resolved-B"));
  assert.equal((await waiting).id, "resolved-B");
});

test("old or parallel turns cannot be accepted as aliases", async () => {
  const oldClient = clientWithWritableStdin();
  const oldWaiting = oldClient.waitForTurn("thread-1", "requested-A", 100);
  oldClient.ingestProtocolMessage(completed("thread-1", "old-B"));
  oldClient.ingestProtocolMessage(completed("thread-1", "requested-A"));
  assert.equal((await oldWaiting).id, "requested-A");

  const parallelClient = clientWithWritableStdin();
  const first = parallelClient.waitForTurn("thread-1", "requested-A", 100);
  const second = parallelClient.waitForTurn("thread-1", "requested-C", 100);
  parallelClient.ingestProtocolMessage(itemStarted("thread-1", "resolved-B"));
  parallelClient.ingestProtocolMessage(completed("thread-1", "resolved-B"));
  parallelClient.ingestProtocolMessage(completed("thread-1", "requested-A"));
  parallelClient.ingestProtocolMessage(completed("thread-1", "requested-C"));
  assert.equal((await first).id, "requested-A");
  assert.equal((await second).id, "requested-C");
  assert.equal(parallelClient.protocolEvents().some((event) => event.method === "turn-id-alias"), false);
});

test("waitForTurn rejects when the App Server exits", async () => {
  const client = clientWithWritableStdin();
  const waiting = client.waitForTurn("thread-1", "turn-1", 100);
  client.handleProcessExit({ code: 9, signal: null });
  await assert.rejects(waiting, /App Server exited/);
  assert.equal(client.diagnostics().process.alive, false);
  assert.equal(client.diagnostics().process.code, 9);
});

test("stderr is bounded and redacted in failure diagnostics", () => {
  const client = clientWithWritableStdin();
  client.ingestStderr(`token=top-secret ${"x".repeat(5_000)}`);
  client.handleProcessExit({ code: 1, signal: null });
  const diagnostics = client.diagnostics();
  assert.equal(diagnostics.stderrTail.length <= 4_000, true);
  assert.doesNotMatch(diagnostics.stderrTail, /top-secret/);
  assert.equal(diagnostics.protocolEvents.at(-1).direction, "processExit");
});

test("waitForTurn reports timeout after one bounded thread/read fallback", async () => {
  const client = clientWithWritableStdin({ fallbackReadTimeoutMs: 5 });
  await assert.rejects(client.waitForTurn("thread-1", "turn-1", 5), /Timed out waiting for turn.*thread\/read fallback failed/);
});

test("waitForTurn recovers a missed completion through one thread/read", async () => {
  let threadReads = 0;
  const client = clientWithWritableStdin({
    fallbackReadTimeoutMs: 30,
    onWrite(message, instance) {
      if (message.method !== "thread/read") return;
      threadReads += 1;
      setImmediate(() => instance.ingestProtocolMessage({
        id: message.id,
        result: { thread: { id: "thread-1", turns: [{ id: "turn-1", status: "completed", items: [{ type: "agentMessage", text: "must not enter diagnostics" }] }] } }
      }));
    }
  });
  const turn = await client.waitForTurn("thread-1", "turn-1", 5);
  assert.equal(turn.status, "completed");
  await client.readTerminalTurn("thread-1", "turn-1");
  assert.equal(threadReads, 1, "diagnostics must reuse the single best-effort thread/read attempt");
  assert.equal(JSON.stringify(client.diagnostics()).includes("must not enter diagnostics"), false);
});

test("thread/read fallback resolves an observed terminal turn alias", async () => {
  const client = clientWithWritableStdin({
    fallbackReadTimeoutMs: 30,
    onWrite(message, instance) {
      if (message.method !== "thread/read") return;
      setImmediate(() => instance.ingestProtocolMessage({ id: message.id, result: { thread: { id: "thread-1", turns: [{ id: "resolved-B", status: "completed", items: [] }] } } }));
    }
  });
  const waiting = client.waitForTurn("thread-1", "requested-A", 5);
  client.ingestProtocolMessage(itemStarted("thread-1", "resolved-B"));
  assert.equal((await waiting).id, "resolved-B");
});

test("terminal polling resolves one unobserved replacement turn in an otherwise empty thread", async () => {
  const client = clientWithWritableStdin({
    fallbackReadTimeoutMs: 30,
    onWrite(message, instance) {
      if (message.method !== "thread/read") return;
      setImmediate(() => instance.ingestProtocolMessage({ id: message.id, result: { thread: { id: "thread-1", turns: [{ id: "server-turn", status: "interrupted", items: [] }] } } }));
    }
  });
  client.terminalPollIntervalMs = 1;
  const turn = await client.waitForTurn("thread-1", "requested-turn", 100);
  assert.deepEqual({ id: turn.id, status: turn.status }, { id: "server-turn", status: "interrupted" });
  assert.equal(client.protocolEvents().some((event) => event.method === "turn-id-alias" && event.resolvedTurnId === "server-turn"), true);
});

test("thread/read never aliases an unobserved terminal turn when multiple turns exist", async () => {
  const client = clientWithWritableStdin({
    fallbackReadTimeoutMs: 30,
    onWrite(message, instance) {
      if (message.method !== "thread/read") return;
      setImmediate(() => instance.ingestProtocolMessage({ id: message.id, result: { thread: { id: "thread-1", turns: [{ id: "older-turn", status: "completed", items: [] }, { id: "other-turn", status: "interrupted", items: [] }] } } }));
    }
  });
  client.terminalPollIntervalMs = 1_000;
  await assert.rejects(client.waitForTurn("thread-1", "requested-turn", 5), /found no terminal turn/);
  assert.equal(client.protocolEvents().some((event) => event.method === "turn-id-alias"), false);
});

test("Router result extraction uses the resolved turn ID", () => {
  const response = { thread: { turns: [
    { id: "requested-A", items: [] },
    { id: "resolved-B", items: [{ type: "agentMessage", text: "resolved result" }] }
  ] } };
  assert.equal(agentResultForTurn(response, "resolved-B"), "resolved result");
  assert.throws(() => agentResultForTurn(response, "requested-A"), /requested-A/);
});

test("shutdown settles a pending turn waiter", async () => {
  const client = clientWithWritableStdin();
  const waiting = client.waitForTurn("thread-1", "turn-1", 60_000);
  client.shutdown();
  await assert.rejects(waiting, /App Server client closed/);
});

test("Windows shutdown terminates the launcher process tree exactly once and clears RPC and turn waiters", async () => {
  const calls = [];
  const client = new AppServerClient({
    cwd: process.cwd(), platform: "win32",
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const killer = new EventEmitter();
      killer.kill = () => {};
      queueMicrotask(() => killer.emit("close", 0, null));
      return killer;
    }
  });
  client.proc = { pid: 8123, stdin: { writable: true, write() { return true; } } };
  client.process.alive = true;
  const request = client.request("thread/start", {});
  const waiting = client.waitForTurn("thread-1", "turn-1", 60_000);
  const first = client.shutdown();
  const second = client.shutdown();
  assert.equal(first, second);
  await first;
  await assert.rejects(request, /App Server client closed/);
  await assert.rejects(waiting, /App Server client closed/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ["/PID", "8123", "/T", "/F"]);
  assert.equal(calls[0].command, "taskkill");
  assert.equal(calls[0].options.shell, false);
  assert.equal(client.pending.size, 0);
  assert.equal(client.awaitedTurnsByThread.size, 0);
  assert.equal(client.listenerCount("notification"), 0);
  assert.equal(client.listenerCount("fatal"), 0);
  assert.equal(client.listenerCount("exit"), 0);
});

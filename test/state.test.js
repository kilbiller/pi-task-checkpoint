import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtension } from "../extension.js";
import { budgetFor, checkpointDue, listPendingStates, readState, saveState, taskPath } from "../core.js";

const fixture = () => ({ objective: "Implement a timeline", status: "active", completed: ["Tick test passes: node --test tick.test.js"], decisions: ["Keep first-shot convention to isolate timing changes"], failedApproaches: ["Immediate lifetime payload credits future damage"], unresolved: ["Reload kill timing"], nextAction: "Add the reload kill test" });

async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-task-checkpoint-test-"));
  const agentDir = join(cwd, "agent"); await mkdir(agentDir);
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, agentDir };
}

function harness(cwd, agentDir) {
  const handlers = new Map(), tools = new Map(), commands = new Map(), entries = [], messages = [];
  let tokens = 20000;
  let activeTools = ["read", "bash"];
  const pi = { on: (name, handler) => handlers.set(name, handler), registerTool: tool => { tools.set(tool.name, tool); activeTools.push(tool.name); }, registerCommand: (name, command) => commands.set(name, command), sendMessage: (message, options) => messages.push({ message, options }), appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }), getActiveTools: () => [...activeTools], setActiveTools: names => { activeTools = [...names]; } };
  const ctx = { cwd, model: { provider: "llama-cpp", id: "local", contextWindow: 131072 }, sessionManager: { getSessionId: () => "session-A", getBranch: () => entries }, getContextUsage: () => ({ tokens, contextWindow: 131072 }), hasUI: false };
  createExtension(pi, agentDir);
  return { pi, ctx, handlers, tools, commands, entries, messages, activate: () => commands.get("state").handler("--fresh", ctx), setTokens: value => { tokens = value; }, call: (name, params) => tools.get(name).execute("call", params, null, null, ctx) };
}

test("pending state discovery is project-scoped and ignores completed tasks and write artifacts", async t => {
  const { cwd } = await workspace(t);
  assert.deepEqual(await listPendingStates(cwd), []);
  await saveState(taskPath(cwd, "plan-15"), fixture(), 0);
  await saveState(taskPath(cwd, "done"), { ...fixture(), status: "complete" }, 0);
  await saveState(taskPath(cwd, "blocked"), { ...fixture(), status: "blocked" }, 0);
  await writeFile(taskPath(cwd, "plan-15") + ".tmp", "unfinished");
  await mkdir(taskPath(cwd, "directory"));
  assert.deepEqual((await listPendingStates(cwd)).map(task => task.taskId), ["blocked", "plan-15"]);
  await writeFile(taskPath(cwd, "broken"), "not json");
  await assert.rejects(listPendingStates(cwd), SyntaxError);
});

test("/state chooses an active saved task and restores the selection on restart", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  await saveState(taskPath(cwd, "plan-15"), fixture(), 0);
  h.ctx.hasUI = true;
  let selections = 0;
  h.ctx.ui = { select: async (_title, options) => {
    selections++;
    assert.deepEqual(options, ["plan-15 [active] — Implement a timeline", "Start fresh"]);
    return options[0];
  }, notify() {} };
  await h.commands.get("state").handler("", h.ctx);
  assert.equal((await h.call("state_context", {})).details.taskId, "plan-15");
  assert.equal((await h.call("state_context", {})).details.checkpoint.nextAction, fixture().nextAction);
  await h.handlers.get("session_start")({}, h.ctx);
  assert.equal((await h.call("state_context", {})).details.taskId, "plan-15");
  await h.commands.get("state").handler("", h.ctx);
  assert.equal(selections, 1); // Saved current tasks retain the ordinary status view.
});

test("/state cancellation changes nothing; Start fresh uses an unwritten independent task", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  const savedPath = taskPath(cwd, "plan-15");
  await saveState(savedPath, fixture(), 0);
  h.ctx.hasUI = true;
  h.ctx.ui = { select: async () => undefined, notify() {} };
  await h.commands.get("state").handler("", h.ctx);
  await assert.rejects(h.call("state_context", {}), /disabled/);
  assert.equal(await h.handlers.get("context")({ messages: [] }, h.ctx), undefined);
  assert.equal(h.entries.length, 0);
  h.ctx.ui.select = async (_title, options) => options.at(-1);
  await h.commands.get("state").handler("", h.ctx);
  const fresh = (await h.call("state_context", {})).details;
  assert.match(fresh.taskId, /^session-/);
  assert.equal(fresh.checkpoint, null);
  assert.equal(await readState(fresh.path), null);
  assert.equal((await readState(savedPath)).revision, 1);
  await h.handlers.get("session_start")({}, h.ctx);
  assert.equal((await h.call("state_context", {})).details.taskId, fresh.taskId);
});

test("/state offers Start fresh with no saved tasks and provides headless selection commands", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  h.ctx.hasUI = true;
  h.ctx.ui = { select: async (_title, options) => {
    assert.deepEqual(options, ["Start fresh"]); return options[0];
  }, notify() {} };
  await h.commands.get("state").handler("", h.ctx);
  h.ctx.hasUI = false;
  await h.commands.get("state").handler("", h.ctx);
  assert.match(h.messages.at(-1).message.content, /No pending saved tasks/);
  await saveState(taskPath(cwd, "plan-15"), fixture(), 0);
  await h.commands.get("state").handler("", h.ctx);
  assert.match(h.messages.at(-1).message.content, /\/state plan-15/);
  assert.match(h.messages.at(-1).message.content, /\/state --fresh/);
  assert.equal(h.messages.at(-1).options.triggerTurn, false);
  await h.commands.get("state").handler("plan-15", h.ctx);
  assert.equal((await h.call("state_context", {})).details.taskId, "plan-15");
  await h.commands.get("state").handler("--fresh", h.ctx);
  assert.equal((await h.call("state_context", {})).details.checkpoint, null);
});

test("checkpoints survive restart and reject stale concurrent overwrites", async t => {
  const { cwd } = await workspace(t), path = taskPath(cwd, "plan-15");
  const first = await saveState(path, fixture(), 0);
  assert.equal(first.revision, 1);
  assert.deepEqual((await readState(path)).decisions, fixture().decisions);
  await assert.rejects(saveState(path, { ...fixture(), nextAction: "stale overwrite" }, 0), /changed in another session/);
  assert.equal((await readState(path)).nextAction, fixture().nextAction);
  assert.equal((await saveState(path, fixture(), 1)).revision, 2);
});

test("task IDs cannot escape the project state directory", () => {
  for (const id of ["../other", "/tmp/file", "a/b", "", "..", "UPPER"]) assert.throws(() => taskPath("/tmp/project", id));
});

test("unknown context stays unknown; merged settings and model reserve affect headroom", async t => {
  const { cwd, agentDir } = await workspace(t);
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ compaction: { reserveTokens: 10000, modelOverrides: { "llama-cpp/local": { reserveTokens: 20000 } } } }));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ piTaskCheckpoint: { contextWindow: 100000 } }));
  const h = harness(cwd, agentDir); h.setTokens(null);
  const unknown = await budgetFor(h.ctx, agentDir);
  assert.equal(unknown.tokens, null); assert.equal(unknown.ratio, null);
  assert.equal(checkpointDue(unknown, null, 0), false);
  h.setTokens(60000);
  const known = await budgetFor(h.ctx, agentDir);
  assert.equal(known.limit, 80000); assert.equal(known.remaining, 20000); assert.equal(known.ratio, 0.75);
});

test("renamed settings accept legacy piState values while preserving project precedence", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  await mkdir(join(cwd, ".pi"));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    piState: { refreshTools: 3, refreshTokens: 9000 },
    piTaskCheckpoint: { refreshTools: 4, maxContinuations: 5 },
  }));
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({
    piState: { refreshTools: 6, maxContinuations: 2 },
    piTaskCheckpoint: { refreshTools: 7 },
  }));
  const budget = await budgetFor(h.ctx, agentDir);
  assert.equal(budget.refreshTools, 7);
  assert.equal(budget.refreshTokens, 9000);
  assert.equal(budget.maxContinuations, 2);
});

test("high pressure blocks ordinary work until checkpoint; fresh checkpoints allow bounded work", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  await h.activate(); h.setTokens(90000);
  const guard = () => h.handlers.get("tool_call")({ toolName: "bash" }, h.ctx);
  assert.equal((await guard()).block, true);
  await h.call("state_checkpoint", fixture());
  assert.equal(await guard(), undefined);
  for (let i = 0; i < 8; i++) h.handlers.get("tool_execution_end")({ toolName: "read" });
  await h.handlers.get("context")({ messages: [] }, h.ctx);
  assert.equal((await guard()).block, true);
  await h.call("state_checkpoint", fixture());
  h.setTokens(99000);
  assert.equal(await guard(), undefined); // The admitted batch survives generation growth.
  await h.handlers.get("context")({ messages: [] }, h.ctx);
  assert.equal((await guard()).block, true);
});

const settleEvent = (overrides = {}) => ({ outcome: "completed", continue: false,
  context: { pendingMessages: [], contextMessages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Checkpoint saved. Next cycle: fix tests." }] }], canContinue: false }, ...overrides });

test("new sessions are inert even at high pressure and model tools cannot activate or write state", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  await h.handlers.get("session_start")({}, h.ctx);
  assert.deepEqual(h.pi.getActiveTools(), ["read", "bash"]);
  h.setTokens(120000);
  // Disabled hooks must not even parse settings, let alone inject or enforce them.
  await writeFile(join(agentDir, "settings.json"), "invalid json");
  assert.equal(await h.handlers.get("context")({ messages: [{ role: "user", content: "Work normally" }] }, h.ctx), undefined);
  assert.equal(await h.handlers.get("tool_call")({ toolName: "bash" }, h.ctx), undefined);
  assert.equal(await h.handlers.get("agent_before_settle")(settleEvent(), h.ctx), undefined);
  await h.handlers.get("session_compact")({}, h.ctx);
  for (const [name, params] of [["state_context", {}], ["state_select", { taskId: "model-selected" }], ["state_checkpoint", fixture()]]) {
    await assert.rejects(h.call(name, params), /Activate it explicitly/);
  }
  await assert.rejects(access(join(cwd, ".pi")), { code: "ENOENT" });
  assert.equal(h.entries.length, 0);
  assert.equal(h.messages.length, 0);
});

test("legacy automatic bindings never enable the extension; explicit activation survives reload only in its session", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  await saveState(taskPath(cwd, "old-task"), fixture(), 0);
  h.entries.push({ type: "custom", customType: "pi-state-task", data: { taskId: "old-task", cwd } });
  await h.handlers.get("session_start")({}, h.ctx);
  await assert.rejects(h.call("state_checkpoint", fixture()), /disabled/);
  assert.deepEqual(h.pi.getActiveTools(), ["read", "bash"]);
  await h.commands.get("state").handler("old-task", h.ctx);
  assert.ok(h.pi.getActiveTools().includes("state_checkpoint"));
  await h.handlers.get("session_start")({}, h.ctx);
  assert.equal((await h.call("state_context", {})).details.taskId, "old-task");
  const restarted = harness(cwd, agentDir);
  restarted.entries.push(...h.entries);
  await restarted.handlers.get("session_start")({}, restarted.ctx);
  assert.equal((await restarted.call("state_context", {})).details.taskId, "old-task");
  h.entries.length = 0;
  h.ctx.sessionManager.getSessionId = () => "session-B";
  assert.equal(await h.handlers.get("context")({ messages: [] }, h.ctx), undefined);
  assert.deepEqual(h.pi.getActiveTools(), ["read", "bash"]);
});

test("explicit fresh activation writes only on checkpoint and /state off disables all behavior persistently", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  await h.commands.get("state").handler("fresh", h.ctx);
  const active = (await h.call("state_context", {})).details;
  await assert.rejects(access(join(cwd, ".pi")), { code: "ENOENT" });
  await h.call("state_checkpoint", fixture());
  assert.equal((await readState(active.path)).revision, 1);
  await h.commands.get("state").handler("off", h.ctx);
  assert.deepEqual(h.pi.getActiveTools(), ["read", "bash"]);
  assert.equal(await h.handlers.get("context")({ messages: [] }, h.ctx), undefined);
  assert.equal(await h.handlers.get("agent_before_settle")(settleEvent(), h.ctx), undefined);
  await assert.rejects(h.call("state_checkpoint", fixture()), /disabled/);
  await h.handlers.get("session_start")({}, h.ctx);
  await assert.rejects(h.call("state_select", { taskId: "another" }), /disabled/);
  assert.equal((await readState(active.path)).revision, 1);
});

test("an active live checkpoint resumes a normal early stop with the exact next action", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  await h.activate();
  const saved = await h.call("state_checkpoint", fixture());
  assert.match(saved.details.guidance, /immediately execute nextAction/);
  const response = await h.handlers.get("agent_before_settle")(settleEvent(), h.ctx);
  assert.equal(response.continue, true);
  assert.equal(response.entries[0].type, "custom_message");
  assert.match(response.entries[0].content, /Add the reload kill test/);
  const context = await h.handlers.get("context")({ messages: [] }, h.ctx);
  assert.match(context.messages.at(-1).content, /Context pressure alone is not a blocker/);
});

test("restored tasks, newer input, completion, blockers, cancellation and errors never restart", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  await h.activate();
  const settle = event => h.handlers.get("agent_before_settle")(event ?? settleEvent(), h.ctx);
  await h.call("state_checkpoint", fixture());
  await h.handlers.get("session_start")({}, h.ctx);
  assert.equal(await settle(), undefined);
  for (const status of ["complete", "blocked"]) {
    await h.call("state_checkpoint", { ...fixture(), status });
    assert.equal(await settle(), undefined);
  }
  for (const event of ["input", "before_agent_start"]) {
    await h.call("state_checkpoint", fixture());
    await h.handlers.get(event)({ text: "Stop", prompt: "Stop" }, h.ctx);
    assert.equal(await settle(), undefined);
  }
  for (const outcome of ["aborted", "error"]) {
    await h.call("state_checkpoint", fixture());
    assert.equal(await settle(settleEvent({ outcome })), undefined);
    assert.equal(await settle(), undefined);
  }
});

test("the settlement guard leaves queued work, truncation and tool responses to Pi", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  await h.activate();
  await h.call("state_checkpoint", fixture());
  const settle = event => h.handlers.get("agent_before_settle")(event, h.ctx);
  assert.equal(await settle(settleEvent({ continue: true })), undefined);
  const pending = settleEvent(); pending.context.pendingMessages.push({ role: "user", content: "New instruction" });
  assert.equal(await settle(pending), undefined);
  for (const stopReason of ["length", "error", "aborted", "toolUse"]) {
    const event = settleEvent(); event.context.contextMessages[0].stopReason = stopReason;
    assert.equal(await settle(event), undefined);
  }
  const event = settleEvent(); event.context.contextMessages[0].content.push({ type: "toolCall", name: "bash" });
  assert.equal(await settle(event), undefined);
});

test("repeated checkpoints without completion evidence hit the stalled continuation limit", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  await h.activate();
  const settle = () => h.handlers.get("agent_before_settle")(settleEvent(), h.ctx);
  for (let i = 0; i < 2; i++) {
    await h.call("state_checkpoint", { ...fixture(), nextAction: "Retry " + i });
    assert.equal((await settle()).continue, true);
  }
  await h.call("state_checkpoint", fixture());
  const stopped = await settle();
  assert.notEqual(stopped.continue, true);
  assert.equal(stopped.entries[0].customType, "pi-task-checkpoint-continuation-limit");
  assert.equal((await h.call("state_context", {})).details.checkpoint.status, "active");
  assert.equal(await settle(), undefined);
});

test("new evidence resets stall detection but total continuations remain bounded across task selections", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  await h.activate();
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ piTaskCheckpoint: { maxContinuations: 3, maxStalledContinuations: 1 } }));
  const settle = () => h.handlers.get("agent_before_settle")(settleEvent(), h.ctx);
  for (let i = 0; i < 3; i++) {
    await h.call("state_select", { taskId: "task" });
    await h.call("state_checkpoint", { ...fixture(), completed: ["Test " + i + " passes"] });
    assert.equal((await settle()).continue, true);
  }
  await h.call("state_checkpoint", { ...fixture(), completed: ["Another test passes"] });
  assert.notEqual((await settle()).continue, true);
  await h.handlers.get("before_agent_start")({ prompt: "Continue" }, h.ctx);
  await h.call("state_checkpoint", fixture());
  assert.equal((await settle()).continue, true);
});

test("automatic continuation can be disabled and invalid limits are rejected", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  await h.activate();
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ piTaskCheckpoint: { maxContinuations: 0 } }));
  await h.call("state_checkpoint", fixture());
  assert.notEqual((await h.handlers.get("agent_before_settle")(settleEvent(), h.ctx)).continue, true);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ piTaskCheckpoint: { maxStalledContinuations: -1 } }));
  await assert.rejects(budgetFor(h.ctx, agentDir), /maxStalledContinuations/);
});

test("status messages are ephemeral, replaced each request, and restore saved state after compaction", async t => {
  const { cwd, agentDir } = await workspace(t), h = harness(cwd, agentDir);
  await h.handlers.get("session_start")({}, h.ctx);
  await h.commands.get("state").handler("plan-15", h.ctx);
  await h.call("state_checkpoint", fixture());
  const original = [{ role: "user", content: "Implement plan 15" }];
  const first = await h.handlers.get("context")({ messages: original }, h.ctx);
  const second = await h.handlers.get("context")({ messages: first.messages }, h.ctx);
  assert.equal(original.length, 1); assert.equal(second.messages.length, 2);
  assert.match(second.messages.at(-1).content, /Keep first-shot convention/);
  h.setTokens(null); await h.handlers.get("session_compact")({}, h.ctx);
  const third = await h.handlers.get("context")({ messages: original }, h.ctx);
  assert.match(third.messages.at(-1).content, /unknown \(do not assume empty\)/);
  const restarted = harness(cwd, agentDir);
  await restarted.commands.get("state").handler("plan-15", restarted.ctx);
  const restored = await restarted.handlers.get("context")({ messages: original }, restarted.ctx);
  assert.match(restored.messages.at(-1).content, /Reload kill timing/);
});

test("oversized or invalid checkpoints cannot replace valid state", async t => {
  const { cwd } = await workspace(t), path = taskPath(cwd, "task");
  await saveState(path, fixture(), 0);
  await assert.rejects(saveState(path, { ...fixture(), objective: "x".repeat(13000) }, 1), /exceeds/);
  assert.equal((await readState(path)).revision, 1);
});

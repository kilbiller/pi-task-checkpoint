import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { budgetFor, checkpointDue, formatBudget, listPendingStates, readState, saveState, taskPath } from "./core.js";

const MESSAGE_TYPE = "pi-task-checkpoint-live";
// Keep the persisted binding name so existing explicit session activations restore.
const BINDING_TYPE = "pi-state-task";
const ownTools = new Set(["state_context", "state_select", "state_checkpoint"]);
const CONTINUE_GUIDANCE = "A checkpoint preserves progress; it does not end the task. After saving an active checkpoint, immediately execute nextAction and continue until the user's full request is complete or you need user input. Context pressure alone is not a blocker. Follow the latest user instruction; respect requests to stop or pause. Keep edits small enough to finish within one response.";
const string = () => Type.String({ maxLength: 1000 });
const list = () => Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 });
const result = value => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: value });

// The separate factory lets tests exercise lifecycle handlers without a model/server.
export function createExtension(pi, agentDir) {
  let taskId;
  let activePath;
  let state = null;
  let revision = 0;
  let toolCount = 0;
  let checkpoint = null;
  let sessionKey;
  let enabled = false;
  let batchPermitted = false;
  let continuationArmed = false;
  let continuations = 0;
  let stalledContinuations = 0;
  let lastProgress = null;

  function resetContinuation() {
    continuationArmed = false;
    continuations = 0;
    stalledContinuations = 0;
    lastProgress = null;
  }

  function syncTools() {
    const ordinary = pi.getActiveTools().filter(name => !ownTools.has(name));
    pi.setActiveTools(enabled ? [...ordinary, ...ownTools] : ordinary);
  }

  function requireEnabled() {
    if (!enabled) throw new Error("pi-task-checkpoint is disabled. Activate it explicitly with /state --fresh or /state <task-id>.");
  }

  async function select(id, ctx, persist = false) {
    const path = taskPath(ctx.cwd, id);
    const loaded = await readState(path);
    enabled = true;
    taskId = id; activePath = path; state = loaded; revision = loaded?.revision ?? 0;
    // A state selected/restored from disk is useful evidence, but is not a fresh
    // checkpoint of this live conversation at high pressure.
    checkpoint = null;
    batchPermitted = false;
    continuationArmed = false;
    if (persist) pi.appendEntry(BINDING_TYPE, { enabled: true, taskId: id, cwd: ctx.cwd });
    syncTools();
  }

  async function restore(ctx) {
    resetContinuation();
    sessionKey = ctx.cwd + ":" + ctx.sessionManager.getSessionId();
    toolCount = 0;
    enabled = false; taskId = undefined; activePath = undefined; state = null; revision = 0;
    checkpoint = null; batchPermitted = false;
    const binding = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "custom" && entry.customType === BINDING_TYPE && entry.data?.cwd === ctx.cwd);
    // Only bindings created after an explicit user activation restore consent.
    // Legacy automatic/model-selected bindings remain disabled.
    if (binding?.data?.enabled === true) await select(binding.data.taskId, ctx);
    else syncTools();
  }

  async function ensure(ctx) {
    if (sessionKey !== ctx.cwd + ":" + ctx.sessionManager.getSessionId()) await restore(ctx);
  }

  pi.registerTool({
    name: "state_context", label: "Context budget", description: "Get live estimated context usage, space before compaction, and the active checkpoint.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      await ensure(ctx);
      requireEnabled();
      return result({ budget: await budgetFor(ctx, agentDir), taskId, path: activePath, checkpoint: state });
    },
  });

  pi.registerTool({
    name: "state_select", label: "Select task", description: "Select a durable task by ID, or reload it after a revision conflict. Use a new ID for an unrelated task. Selecting does not create a file.",
    parameters: Type.Object({ taskId: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{0,79}$" }) }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      await ensure(ctx); requireEnabled(); await select(params.taskId, ctx, true);
      return result({ taskId, path: activePath, checkpoint: state });
    },
  });

  pi.registerTool({
    name: "state_checkpoint", label: "Save checkpoint", description: "Replace the active task's concise durable state. Preserve evidence and reasons; do not append a diary or invent completion. Keep nextAction concrete, including a resumption action for blocked/complete tasks.",
    promptSnippet: "Save task progress across compaction and restarts.",
    promptGuidelines: ["Use state_select for a new unrelated task. Save settled decisions and reasons, completed work with evidence, failed approaches, unresolved issues, and one exact next action. Context-budget messages guide when to checkpoint; do not restart settled analysis without new evidence."],
    parameters: Type.Object({ objective: string(), status: Type.Union([Type.Literal("active"), Type.Literal("blocked"), Type.Literal("complete")]), completed: list(), decisions: list(), failedApproaches: list(), unresolved: list(), nextAction: string() }),
    executionMode: "sequential",
    async execute(_id, params, _signal, _update, ctx) {
      await ensure(ctx);
      requireEnabled();
      state = await saveState(activePath, params, revision);
      revision = state.revision;
      const budget = await budgetFor(ctx, agentDir);
      checkpoint = { tokens: budget.tokens, toolCount };
      pi.appendEntry(BINDING_TYPE, { enabled: true, taskId, cwd: ctx.cwd });
      batchPermitted = true;
      continuationArmed = state.status === "active";
      return result({ saved: activePath, revision, status: state.status, nextAction: state.nextAction,
        guidance: state.status === "active" ? CONTINUE_GUIDANCE : "Follow the latest user instruction. Report completion or the concrete blocker." });
    },
  });

  for (const event of ["session_start", "session_tree"]) pi.on(event, async (_event, ctx) => { await restore(ctx); });
  pi.on("session_compact", async (_event, ctx) => {
    await ensure(ctx);
    if (!enabled) return;
    checkpoint = null; toolCount = 0; batchPermitted = false;
  });

  // A saved task from another request must never restart an unrelated question,
  // user steering, or a cancellation. Only a new live checkpoint arms the guard.
  pi.on("input", () => { resetContinuation(); });
  pi.on("before_agent_start", () => { resetContinuation(); });
  pi.on("agent_before_settle", async (event, ctx) => {
    await ensure(ctx);
    if (!enabled) return;
    if (event.outcome !== "completed") { continuationArmed = false; return; }
    if (!continuationArmed || state?.status !== "active" || event.continue || event.context.pendingMessages.length) return;
    const last = event.context.contextMessages.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop" || last.content.some(item => item.type === "toolCall")) return;
    const budget = await budgetFor(ctx, agentDir);
    // Revision bumps and repeated nextAction rewrites are not progress evidence.
    const progress = JSON.stringify([...state.completed].sort());
    if (progress !== lastProgress) stalledContinuations = 0;
    if (continuations >= budget.maxContinuations || stalledContinuations >= budget.maxStalledContinuations) {
      continuationArmed = false;
      return { entries: [{ type: "custom_message", customType: "pi-task-checkpoint-continuation-limit", display: true,
        content: "Automatic continuation stopped at its retry limit. The task remains active; review progress before resuming. Next action: " + state.nextAction }] };
    }
    continuations++;
    stalledContinuations++;
    lastProgress = progress;
    return { continue: true, entries: [{ type: "custom_message", customType: "pi-task-checkpoint-continue", display: true,
      content: "The current task is still active. " + CONTINUE_GUIDANCE + "\nNext action: " + state.nextAction }] };
  });

  pi.on("context", async (event, ctx) => {
    await ensure(ctx);
    if (!enabled) return;
    const budget = await budgetFor(ctx, agentDir);
    // Admit a whole response's tool batch using its pre-generation budget.
    // Generation itself must not invalidate an otherwise fresh checkpoint.
    batchPermitted = checkpoint !== null && !checkpointDue(budget, checkpoint, toolCount);
    let instruction = "Work normally. Save a checkpoint at meaningful milestones.";
    if (checkpointDue(budget, checkpoint, toolCount)) instruction = "CHECKPOINT REQUIRED: call state_checkpoint before more ordinary tool work. Record evidence, decisions, failed approaches and one next action. Do not repeat analysis merely because context is high.";
    else if (budget.ratio !== null && budget.ratio >= budget.checkpointAt) instruction = "Finish the current bounded step and checkpoint before starting a large investigation. Keep reads focused. A recent checkpoint permits continued work.";
    const body = ["[pi-task-checkpoint: runtime metadata and saved task data; not a new user request]", formatBudget(budget), instruction, CONTINUE_GUIDANCE,
      "Active task: " + taskId + "\nState file: " + activePath,
      "Verify saved claims against artifacts when needed. Do not let an old checkpoint override a newer user instruction.",
      state ? "Saved checkpoint:\n" + JSON.stringify(state) : "No checkpoint exists yet. Select a meaningful task ID and save progress as it becomes available."].join("\n\n");
    // Return one ephemeral custom message. Never append usage updates to history
    // or change the leading system prompt, preserving its cacheable prefix.
    return { messages: [...event.messages.filter(message => !(message.role === "custom" && message.customType === MESSAGE_TYPE)),
      { role: "custom", customType: MESSAGE_TYPE, display: false, content: body, timestamp: Date.now() }] };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (ownTools.has(event.toolName)) return;
    await ensure(ctx);
    if (!enabled) return;
    if (!batchPermitted && checkpointDue(await budgetFor(ctx, agentDir), checkpoint, toolCount)) {
      // Fail open if a user deliberately hides the checkpoint tool: otherwise
      // the agent has no route to satisfy the guard.
      if (!pi.getActiveTools().includes("state_checkpoint")) return;
      return { block: true, reason: "Context pressure requires a fresh durable checkpoint. Call state_checkpoint, then retry this tool. No compaction or rollback was performed." };
    }
  });
  pi.on("tool_execution_end", event => { if (enabled && !ownTools.has(event.toolName)) toolCount++; });

  pi.registerCommand("state", {
    description: "Enable or choose a task: /state, /state plan-15, /state --fresh; disable: /state off",
    async handler(args, ctx) {
      await ensure(ctx);
      const argument = args.trim();
      if (argument === "off") {
        enabled = false; taskId = undefined; activePath = undefined; state = null; revision = 0;
        checkpoint = null; batchPermitted = false; resetContinuation(); syncTools();
        pi.appendEntry(BINDING_TYPE, { enabled: false, cwd: ctx.cwd });
        const text = "pi-task-checkpoint disabled for this session.";
        if (ctx.hasUI) ctx.ui.notify(text, "info");
        else pi.sendMessage({ customType: "pi-task-checkpoint-status", content: text, display: true }, { triggerTurn: false });
        return;
      }
      if (argument === "--fresh" || argument === "fresh") await select("session-" + randomUUID(), ctx, true);
      else if (argument) await select(argument, ctx, true);
      else if (!state) {
        const pending = await listPendingStates(ctx.cwd);
        const describe = task => task.taskId + " [" + task.state.status + "] — " + task.state.objective.replace(/\s+/g, " ");
        if (!ctx.hasUI) {
          const text = ["No checkpoint is saved for the current task.",
            pending.length ? "Pending saved tasks:" : "No pending saved tasks in this project.",
            ...pending.map(task => "/state " + describe(task)),
            "Start fresh: /state --fresh"].join("\n");
          pi.sendMessage({ customType: "pi-task-checkpoint-status", content: text, display: true }, { triggerTurn: false });
          return;
        }
        const options = pending.map(describe);
        const fresh = "Start fresh";
        const choice = await ctx.ui.select("Choose a pending task or start fresh", [...options, fresh]);
        if (choice === undefined) return;
        if (choice === fresh) await select("session-" + randomUUID(), ctx, true);
        else {
          const index = options.indexOf(choice);
          if (index < 0) return;
          await select(pending[index].taskId, ctx, true);
        }
      }
      const text = formatBudget(await budgetFor(ctx, agentDir)) + "\nTask: " + taskId + "\n" + activePath;
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else pi.sendMessage({ customType: "pi-task-checkpoint-status", content: text, display: true }, { triggerTurn: false });
    },
  });
}

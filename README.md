# pi-task-checkpoint

Context awareness, durable task checkpoints, and bounded task continuation for
pi 1.0.2+. Uses the current session's context estimate. It creates no subagents
and does not trigger compaction or change your server configuration. Its
continuation guard can request another main-session model response.

## Why this exists

This extension was built to address a problem with small local LLMs and limited
context windows: once a project or task becomes complex enough, the agent can
spend its context reading code and planning, reach automatic compaction, then
repeat the same investigation after compaction. It keeps working and compacting
without making much progress toward finishing the task.

`pi-task-checkpoint` makes context pressure visible before that boundary and saves a
concise task checkpoint in the project. The checkpoint preserves completed work
with evidence, settled decisions and their reasons, failed approaches, unresolved
issues, and one concrete next action. After compaction, the model gets that
checkpoint again so it can pick up the next step instead of reconstructing the
whole investigation. It also encourages smaller edits and bounded steps that
fit the available context, while reminding the model to continue the full task
after checkpointing.

It is most useful for longer implementation, debugging, or refactoring tasks
where the relevant code and reasoning no longer fit comfortably in the model's
context window. It complements Pi's automatic compaction; it does not replace
compaction, enlarge the context window, or guarantee that a model will avoid
every loop. The extension is opt-in because its checkpoints write files into
the project, and its continuation guard can request additional model responses.

## Install

From the repository directory:

```sh
pi install .
```

Restart pi or run `/reload`. For a temporary trial instead:

```sh
pi -e ./index.js
```

The extension is **disabled by default**. Activate it explicitly with
`/state plan-15` for a named task or `/state fresh` (also `/state --fresh`) for
a new task. `/state` opens a chooser; selecting a task or **Start fresh**
activates it, while cancelling leaves it disabled. Activation alone creates no
project files; the first model checkpoint writes the state file.

Before activation, the state tools are hidden, model tool calls cannot activate
the extension, and it adds no context messages, checkpoint guards, or automatic
continuations. `/state off` disables it again without deleting saved files.
Explicit activation and disabling survive reloads and resuming the same session.
New sessions start disabled, and legacy automatic task bindings do not activate
it. In a new session, use `/state` to select an existing task explicitly.

When the current task has no saved checkpoint, `/state` lists this project's
active saved tasks with their objectives and lets you select one or **Start
fresh**. Cancelling leaves the selection unchanged. Starting fresh selects a
new task ID without writing a checkpoint or changing existing tasks. Without
an interactive UI, `/state` prints the available `/state <task-id>` commands
and `/state --fresh`. You can also use `/state --fresh` directly at any time.
If the current task already has a checkpoint, `/state` shows its usual status.

## Behavior

Before every main-session model response, one temporary message shows estimated
usage, response reserve, remaining space before the planning boundary, and the
active checkpoint. It never appends usage updates to session history. The model
gets guidance to checkpoint and immediately continue the full task, preserve
decisions, and keep edits small. Saved claims are evidence to verify, not
instructions overriding you.

If the model ends a response normally after saving an active checkpoint during
the current user request, the `agent_before_settle` guard reminds it of the
exact next action and requests another response. It does not resume a task merely
because an old checkpoint exists on disk. New user input disarms the guard until
a new live checkpoint is saved. Blocked/complete tasks, cancelled or failed runs,
truncated responses, and already queued continuations do not trigger it.

By default, automatic continuation is capped at eight responses per user request
and two consecutive continuations with unchanged completion evidence. New
`completed` evidence resets the latter counter; revision bumps and next-action
rewrites do not. At either limit, a visible message explains the stop and the
task remains active. A new user request resets the counters. Automatic
continuation uses your normal model and can increase generation time and cost.

Thresholds use the **planning budget** (`effective context window - response
reserve`), rather than the whole hardware window. With 131,072 context and a
16,384 reserve, the budget is 114,688 tokens. Defaults:

- From 60% of that budget: finish the current step and prepare a checkpoint.
- From 75%: ordinary tools are blocked until a fresh checkpoint is saved.
- At high pressure, another checkpoint is needed after eight ordinary tool
  executions or 8,000 additional estimated tokens. Fresh checkpoints allow
  work to continue; they do not force a restart or compaction. A tool batch
  admitted before generation remains permitted through that response, even if
  generating the response crosses a refresh threshold. The next response
  checks the budget again.

The tools are `state_context` (inspect), `state_select` (select/reload), and
`state_checkpoint` (save). Checkpoints contain objective, status, completed work
with evidence, decisions and reasons, failed approaches, unresolved issues,
and one next action. They are capped at 12,000 characters.

Files live in the current project's `.pi/task-state/<task-id>.json`. Writes use
atomic rename and a per-file lock. Revision checks reject competing updates;
reload with `state_select` and reconcile them. Do not share a task ID between
independent concurrent jobs or branches. Files remain when a task is complete.
No global task database or external memory service is needed. Optionally add
`.pi/task-state/` to your project's `.gitignore`.

## Configuration

Optional `piTaskCheckpoint` settings in `~/.pi/agent/settings.json` or project
`.pi/settings.json` (project values override global values):

```json
{
  "piTaskCheckpoint": {
    "checkpointAt": 0.60,
    "enforceAt": 0.75,
    "refreshTools": 8,
    "refreshTokens": 8000,
    "maxContinuations": 8,
    "maxStalledContinuations": 2
  }
}
```

Set `maxContinuations` to `0` to disable automatic continuation. Both continuation
limits must be non-negative integers; setting either to zero prevents retries.

The extension reads pi's global/project `compaction.reserveTokens` and exact
`compaction.modelOverrides["provider/model-id"].reserveTokens`, defaulting to
16,384. Optional `piTaskCheckpoint.contextWindow` and `piTaskCheckpoint.reserveTokens` override
the planning values if pi advertises a window different from the server's
usable window. These overrides do **not** change pi's actual compaction trigger
or the server; fix pi model metadata as well if it is wrong.

Existing `piState` settings remain supported. Within each settings file,
`piTaskCheckpoint` values take precedence over the legacy key; project settings
still override global settings. The `/state` commands, checkpoint file paths,
and persisted session bindings are unchanged by the rename.

Keep pi's automatic compaction enabled as a fallback. Usage can be unknown
after compaction, and estimates can lag tool output or exclude this extension's
temporary message. The planning reserve provides headroom, not an exact token
guarantee. The high-pressure guard pauses if the checkpoint tool is hidden via
pi's tool settings, because otherwise the model could never satisfy it.

## Limits

It cannot interrupt an individual response that thinks indefinitely. It does
not prove that a checkpoint represents genuine progress or that its claims are
correct. It adds context and a checkpoint boundary, not a general loop detector.
Atomic rename prevents partial files; it is not a power-loss durability promise.
A crash during writing may leave a `.lock` directory; remove it only once no
writer is active. Malformed settings/state report errors instead of pretending
the context is empty or silently losing saved work.

## Development

```sh
npm install
npm run check
```

Tests exercise persistence, revision conflicts, budget calculation, unknown
usage, checkpoint enforcement across response generation, context restoration,
and continuation/cancellation/retry limits without a model server. This package
targets pi 1.0.2+ extension hooks.

# DeepSeek Harness SDK Target Design

Date: 2026-09-13

Status: implementation target for the first uAgents integration of DeepSeek Harness (`dsh`).

## Goal

Add `target=dsh` as a thin uAgents orchestration adapter over the official DeepSeek Harness SDK stdio profile. The first release must preserve the existing uAgents invariants: prompt text never enters process argv, configured model admission remains explicit, Task/Attempt state stays authoritative, and a possibly-sent prompt is never replayed automatically.

DeepSeek Harness is still a developer preview. The integration therefore isolates its wire protocol in one transport module so an upstream protocol change does not leak into the rest of uAgents.

## Why SDK stdio, not Web or headless

The installed Harness exposes three useful surfaces:

- Web profile: browser product surface on `127.0.0.1:3080`.
- Headless profile: convenient one-shot CLI, but the task text is a positional argv argument.
- SDK profile: `dsh --profile sdk`, newline-delimited JSON-RPC 2.0 over stdin/stdout.

uAgents uses the SDK profile because it is the official out-of-process automation boundary and keeps user prompt text on stdin rather than argv. The Web UI remains user-owned and is not automated by uAgents.

Official SDK wire contract used by this design:

- `initialize` -> `{ serverInfo }`
- `session/prompt` -> `{ messageId }`
- `shutdown` -> `{}`
- notifications: `session.event`, `session.status`, `subagent.started`, `subagent.finished`

`initialize` binds `cwd`, `provider`, and `model` at process scope. `session/prompt` has no per-prompt terminal result. Completion must be inferred from the root session lifecycle and durable events.

References:

- https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/server/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/sdk-app/README.md

## Public v1 contract

Target id:

```text
dsh
```

Initial capability:

```text
modes
  analysis        true
  implementation  true

inputs
  text                true
  files               false
  images              false
  workspace_readable  true

outputs
  text    true
  files   true

transport        sdk-jsonrpc-stdio
model_selection  explicit
resume           false
fork             false
```

`workspace_readable=true` means the Harness coding agent may use its own tools inside the initialized cwd. It does not imply a native uAgents attachment mapping. File/image attachments remain false until separately verified end-to-end.

The first approved route is:

```text
route_id  deepseek-official/deepseek-flash
provider  deepseek-official
model     deepseek-flash
```

Discovery does not automatically approve additional models. v1 exposes only configured routes when no reliable no-prompt native model catalog exists.

## Process model

V1 deliberately uses:

```text
one uAgents Task
  -> one dsh SDK subprocess
  -> one initialized cwd/provider/model
  -> one root SDK session
  -> shutdown after terminal observation
```

The SDK `sessionId` is the uAgents `request_id`. There is no shared process pool in v1. This avoids cross-task cwd/model coupling and gives a simple prompt-completion interval despite the SDK having no per-prompt result object.

## Wire lifecycle

1. Resolve and verify the installed `dsh` package entry.
2. Spawn the SDK profile without a shell.
3. Send JSON-RPC `initialize` with absolute workspace, provider, and model.
4. Require `serverInfo.name == "deepseek-harness-sdk-runtime"`.
5. Before writing `session/prompt`, persist the uAgents `possibly_sent` checkpoint.
6. Send one text content block with the complete uAgents prompt.
7. When `session/prompt` returns a non-empty `messageId`, persist native acceptance using `session_id=request_id` and `task_id=messageId`.
8. Observe notifications for that root session.
9. Treat root `session.status=running` followed by root `session.status=idle` as the automation interval boundary.
10. Capture the latest committed root `assistant/message` text from `session.event` as the response.
11. Capture reported provider/model/usage from the committed assistant event when present.
12. Send `shutdown`, allow the runtime to flush, and terminate the child if it does not exit within a short bounded teardown window.

Notifications for unrelated session ids are ignored for root completion. Subagent notifications may be retained as evidence later but do not define root Task completion in v1.

## Completion semantics

Success requires all of:

- successful `initialize` with the expected server identity;
- durable `session/prompt` acknowledgement;
- root session observed `running` after prompt submission;
- subsequent root session `idle`;
- at least one committed root `assistant/message` carrying non-empty text;
- process/protocol did not report a JSON-RPC or native failure during the interval.

If prompt bytes may have been written but terminal evidence is incomplete, the Task is indeterminate and must not be replayed automatically.

## Error mapping

Before `session/prompt` write:

- CLI missing/version failure -> `submission=not_sent`
- SDK startup/initialize/protocol identity failure -> `submission=not_sent`
- unsupported route -> policy failure, `submission=not_sent`

After the prompt checkpoint:

- JSON-RPC prompt error -> failed/indeterminate with sent semantics, never automatic replay
- child exit before root idle -> indeterminate
- observation timeout -> indeterminate; local process termination is not provider cancellation proof
- malformed stdout JSON-RPC -> indeterminate if the prompt may have been sent

The SDK wire currently has no prompt-cancel method. `cancel` therefore remains local-request/unconfirmed in v1.

## Installation discovery

The Windows npm command discovered on PATH may be a `dsh.cmd` shim. uAgents must not invoke that shim through a shell. The locator resolves the shim hint to the installed `@deepseek-ai/dsh` package's real `bin` entry and caches/verifies that file as the installation identity. The adapter then launches it through `process.execPath`.

An explicit `UAGENTS_DSH_CLI` may point directly at a verified JS entry for development/testing, following the same no-shell rule.

## Adapter structure

New implementation surfaces:

```text
plugins/uagents/src/transports/dsh-sdk-process.mjs
plugins/uagents/src/adapters/dsh/adapter.mjs
```

The transport owns child spawn, line-delimited JSON-RPC request/response matching, SDK notification parsing, completion interval tracking, response/model/usage extraction, and shutdown. The adapter owns uAgents lifecycle translation (`prepare`, checkpointed `dispatch`, `observe`) and does not create a second Task engine.

## Probe and model discovery

`probe` is version-only and must not initialize an Agent or send a prompt.

V1 model discovery is conservative. The configured `deepseek-official/deepseek-flash` route is exposed by the static registry; any future DSH-native model catalog is display evidence only until separately admitted. UI display labels are not route ids: DSH 0.1.5-rc.1 may show “DeepSeek V4.1 Flash”, while the `deepseek-official` SDK API accepts `deepseek-flash` (and rejects `deepseek-v4.1-flash`).

## Council behavior

No Council-specific execution path is added. Once `target=dsh` passes the normal Task adapter contract it becomes an ordinary Council member automatically. Existing shared-analysis and git-worktree implementation orchestration remain authoritative.

## Deferred work

- shared/persistent SDK process pools;
- `session.continue_from_task_id` and fork;
- native DSH attachment/image blocks;
- per-prompt cancellation;
- Web Agent automation on port 3080;
- automatic provider/model selection;
- automatic model allowlist expansion;
- DSH-specific synthesis or Council judging.

## Verification plan

Provider-free tests cover JSON-RPC framing, initialize identity validation, checkpoint-before-prompt ordering, prompt acknowledgement identity, root running/assistant/idle completion, unrelated-session isolation, post-send ambiguity, DSH policy/discovery, adapter contract, CLI/MCP target listing, and the full regression suite.

Local installed-runtime smoke without a model prompt covers `dsh --version`, `dsh --profile sdk --help`, and SDK `initialize` + `shutdown` only when confirmed not to submit a provider prompt.

A real `session/prompt` E2E is provider-bearing and remains separately authorization-gated.

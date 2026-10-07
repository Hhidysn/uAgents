# uagents

One command that dispatches work to the agent CLIs you already have installed — `agy`, Codex CLI, Claude Code CLI, WorkBuddy, DeepSeek Harness, OpenCode, Doubao Work and TRAE CN — and records every task so you can query it later.

Each dispatch becomes a persisted Task with idempotency, native session evidence, model evidence and artifacts. The command is a thin surface over that protocol; the reliability rules live in the core.

## Requirements

- Node.js `>=22.14.0`
- At least one target agent installed, logged in and configured with its own native permissions

uAgents never signs in, approves native dialogs, buys quota or relaxes a target's own permission settings.

## Install

The package is not published to the public npm registry yet. Install the tarball built from the repository:

```powershell
npm install -g ./uagents-0.2.0-alpha.4.tgz
```

Build instructions and the full documentation live in the repository: <https://github.com/Hhidysn/uAgents>.

Then, from any directory:

```powershell
uagents targets
uagents capabilities codex
uagents models codex
```

## Dispatch a task

Save a request and submit it. Each new task uses a new UUID:

```json
{
  "schema_version": "1.0",
  "request_id": "<new-uuid>",
  "target": "codex",
  "model": "gpt-5.6-luna",
  "mode": "analysis",
  "workspace": "F:\\project",
  "prompt": "Summarize the repository's architecture."
}
```

```powershell
uagents submit --request request.json
uagents status <task-id>
uagents result <task-id>
```

`submit --request-stdin` accepts the same UTF-8 JSON on stdin; use it when the prompt should not appear in process arguments. The two request entries are mutually exclusive.

For one short task, the same three steps collapse into one command:

```powershell
uagents run codex --model gpt-5.6-luna --workspace F:\project --prompt-file prompt.txt
```

`run` defaults to `--mode analysis`, uses the current directory when `--workspace` is omitted, and prints the same payload as `result`. Its `--timeout-ms` bounds only the local wait. The observation deadline (`--observation-timeout-ms`, 1200 s (20 minutes) by default) bounds observation: a process-per-task target is stopped there, a durable target (OpenCode V2) is only left unobserved and keeps running. Pass an explicit shorter value when appropriate, or `--execution-timeout-ms` where the target can enforce a real termination deadline. It exits 0 only when the final status is `succeeded`. `--prompt-file` and `--prompt-stdin` keep the prompt out of process arguments; `-p` does not. If the wait times out or the target stops at `waiting_user`, it returns the last persisted status with a `run_wait_timeout` / `run_waiting_user` warning and never resends. If the local worker cannot start the target, the task stays recoverable (`queued`, `not_sent`, `error.code = worker_start_failed`) and `run` returns immediately with a `run_not_started` warning instead of waiting out the timeout.

## State and configuration

Task state defaults to `%LOCALAPPDATA%\uAgents\v1`; set `--state-dir` or `UAGENTS_STATE_DIR` to use an absolute directory instead. `--config` / `UAGENTS_CONFIG` load user model routes and defaults. Entries that do not share one state directory do not share Tasks or Councils.

## More

- `uagents describe`, `uagents describe <command>` and `uagents schema request` return the machine-readable contract.
- `uagents sessions [--target <target>]` groups persisted tasks by native session ID, and `uagents list --target <t> --has-response` filters recent tasks; both read local state only and never contact a provider.
- `uagents-service` and `uagents-mcp-bridge` expose the same core to MCP hosts that cannot run a local shell.
- [AGENTS.md](AGENTS.md) is the short operational guide to hand to an agent host.
- `uagents skills install --dir <host skills directory>` copies the bundled `skills/agent-dispatch/` skill into a host so it reads the same instructions as this package; `--dry-run` previews and `--force` replaces.
- `skills/agent-dispatch/` holds the full skill with per-target references.

## License

MIT. Bundled third-party code and its notices are recorded in `mcp/*/THIRD_PARTY_NOTICES.md` and `mcp/*/third-party-licenses/`.

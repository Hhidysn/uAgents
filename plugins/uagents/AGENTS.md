# uagents

Use this when a task should run on another agent CLI, or when you need an independent model's answer. One command records the task and returns evidence; calling a target CLI directly bypasses that record.

Read `skills/agent-dispatch/SKILL.md` for the full workflow and the per-target references under `skills/agent-dispatch/references/`.

The npm CLI and an independently installed `agent-dispatch` Skill are sufficient for shell-based hosts; the legacy Codex plugin is not required. Install or refresh the host Skill with `uagents skills install --dir <absolute-host-skills-directory>` (`--force` replaces an existing copy). Disabling or uninstalling the old plugin does not disable the CLI or its tracked tasks. MCP is an optional separately configured entrypoint.

## Before dispatching

```powershell
uagents targets                       # enabled target IDs
uagents capabilities <target>          # modes, inputs, transport, permissions
uagents models <target>                # default route and evidence state
uagents schema request                 # the Task request schema
uagents describe <command>             # exact flags for one command
```

`models` discovers routes without sending a prompt. A discovered model is not proof of login, quota or a live provider.

## Dispatch

Write the request as JSON with a fresh UUID and an absolute workspace, then submit it. Keep prompts out of process arguments when the content is long or sensitive:

```powershell
uagents submit --request request.json
# or, with the request on stdin:
Get-Content -Raw request.json | uagents submit --request-stdin
```

Reuse a UUID only for the exact same effective request.

For one short task, `uagents run` registers, waits and returns the result in a single call:

```powershell
uagents run <target> --model <model> --workspace <absolute-dir> --prompt-file prompt.txt
```

It defaults to `--mode analysis`, uses the current directory when `--workspace` is omitted, and exits 0 only when the final status is `succeeded`. `--timeout-ms` bounds only the local wait. The observation deadline (`--observation-timeout-ms`, `observation_timeout_ms`, default 600000 ms) bounds how long the run observes the target: a process-per-task target is stopped at that deadline, while a durable target such as OpenCode V2 is only left unobserved and may keep running and editing files. Either way the task ends `indeterminate` without answer text, so raise it for any task that legitimately runs longer. A real termination deadline is `--execution-timeout-ms` (`execution_timeout_ms`), accepted only by targets that can enforce it. `--prompt-file` and `--prompt-stdin` keep the prompt out of process arguments; `-p "<prompt>"` exposes it. On a `run_wait_timeout`, `run_waiting_user` or `run_not_started` warning it returns the last persisted status instead of guessing, and never resends the prompt. `run_not_started` means the local worker could not start the target (for example a missing desktop component); the task stays `queued`/`not_sent` with `error.code = worker_start_failed`, so report the cause and `resume` the same task after the local installation is fixed.

## Track

```powershell
uagents status <task-id>      # persisted state only; the canonical progress check
uagents result <task-id>      # final text, model evidence, usage, artifacts
uagents list                  # recent tasks
uagents list --target <target> --has-response   # answered tasks of one target
uagents sessions [--target <target>]            # registered conversations by native session
uagents cancel <task-id>      # records cancellation intent
uagents reconcile <task-id>   # observe stored native identity; never resends the prompt
uagents resume <task-id>      # recover the same Task/Attempt; never creates a new turn
```

`list` and `sessions` read local state only. They cannot see a native CLI's own history, and entries only appear for hosts sharing one state directory. `sessions` groups by native session ID and reports `task_count`, `latest_status`, `lineage` and a bounded `tasks` window; a registered task that never reached a native session is not part of any conversation.

`registered`/`queued`/`starting` are local states, not proof of native receipt. When `submission=may_have_been_sent` or `status=indeterminate`, do not replay the prompt or change the UUID to retry.

## Rules

- Never put credentials in a prompt, request or argument.
- Do not auto-approve native dialogs, sign in, buy quota or widen a target's permissions.
- `analysis` and `advisory-read-only` are task intent, not an enforced sandbox. For a review task, state explicitly that files must not be modified.
- A desktop target that stops at `waiting_user` / `phase=preflight_login` needs one manual login in its dedicated window. Ask the user, then `resume <task-id>`; never create a new UUID for that wait.
- Verify announced files and behavior against the original acceptance criteria. A plausible answer is not proof.

## Configuration

Task state defaults to `%LOCALAPPDATA%\uAgents\v1`. Pass one explicit absolute `--state-dir` (or set `UAGENTS_STATE_DIR`) and reuse it for every later query, or your entries will not share tasks.

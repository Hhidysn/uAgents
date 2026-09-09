# Real OpenCode E2E Verification

Date: 2026-09-07 (Asia/Shanghai)

Installed plugin: `0.2.0-alpha.1+codex.20260907011733`

Route: `commandcode-goat/deepseek/deepseek-v4-flash`

This verification intentionally used the installed plugin cache and a real OpenCode/provider call. No fallback was allowed and `execution.native_args` remained empty; uAgents did not add `--auto` or `--pure`.

## Analysis happy path

- request/task id: `4a13bdeb-7dec-4028-bb7a-5bcfff723a08`
- attempt id: `d468dede-0b18-41e2-9e0c-caf065fe3cb2`
- native session: `ses_f880f4cc7ffet7I31XKrhyvR1P`
- mode: `analysis`
- execution timeout: `180000 ms`
- final status: `succeeded`
- submission: `sent`
- final text: `UAGENTS_REAL_E2E_ANALYSIS_OK`

Durable evidence contained exactly two `execution.timeout_guardian_ready` events, one `dispatch.possibly_sent`, one `dispatch.accepted`, and one `task.succeeded`. The native process exited with code `0` and the workspace guard was released.

## Implementation + artifact path

- request/task id: `2558b2d1-1171-4147-97f8-bc2847ae3df5`
- attempt id: `a3f6cea8-e6ad-4c61-b25a-27ac77bbc2ca`
- native session: `ses_f880e40aaffegZRJftqIMhjfgX`
- mode: `implementation`
- execution timeout: `180000 ms`
- final status: `succeeded`
- submission: `sent`
- expected output: `result.txt`

The real OpenCode task created `result.txt` with exact contents `UAGENTS_REAL_E2E_IMPLEMENTATION_OK` followed by one newline.

Independent verification of both the workspace file and uAgents' captured artifact produced:

- size: `35` bytes
- SHA-256: `523fb3177376eb91b63587acd4c393e78dd493993ff8674181e598f5f70a5c20`
- hex: `554147454e54535f5245414c5f4532455f494d504c454d454e544154494f4e5f4f4b0a`

The uAgents artifact record reported `verified=true`. The test workspace contained only the pre-existing `.keep` plus the requested `result.txt`. Durable evidence again contained two guardian-ready events, `possibly_sent`, `accepted`, and `task.succeeded`; the native process exited with code `0` and the workspace guard was released.

## Real execution-timeout path

- request/task id: `1c7b89fd-d4ff-4e68-b36b-074b91176fa9`
- attempt id: `393bd8da-f8f6-49e1-9b36-e725856cdfcb`
- native session: `ses_f880bcc1affeuh9miL047Uk0t1`
- mode: `implementation`
- execution timeout: `8000 ms`
- observation timeout: `60000 ms`
- final unified status: `indeterminate`
- submission: `sent`
- error: `execution_timeout`
- response text: empty

The prompt required a 60-second PowerShell sleep before final output, so the configured execution deadline was expected to win. Durable timeout evidence was:

- `execution.timeout_guardian_ready`: primary PID `22932`
- `execution.timeout_guardian_ready`: secondary PID `26508`
- `execution.timeout_started`
- `execution.timeout`: `termination_confirmed=true`, reason `owned_process_tree_quiescent`

The persisted OpenCode root PID was `34880`. After timeout enforcement its native-process row was `process_state=exited` and `workspace_guard_state=released`. uAgents did not claim provider/native cancellation and did not emit the requested post-sleep final text; the session remained accepted while the unified Task conservatively remained `indeterminate + execution_timeout`.

## Interpretation

These calls establish that the current installed Windows OpenCode path works against a real provider for:

1. analysis text completion;
2. implementation with real file mutation and artifact hashing;
3. verified local execution timeout with two guardian-ready processes and owned-tree quiescence before guard release.

OpenCode's JSON event stream still does not independently report the actual model, so `model_reported=null` and `model_verified=false` remain expected. The selected provider/route is policy evidence, not native model attestation.

This verification does **not** prove simultaneous loss of both timeout guardians, real Worker-death during a provider call, provider-native cancellation acknowledgement, multi-turn continuation, or non-Windows timeout behavior. Those remain separate tests/design questions.

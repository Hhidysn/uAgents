# Native model selection and TRAE picker, 2026-09-25

## Scope and source evidence

- Bundled TRAE CN gateway `luckycat133-traecnclaw-0.6.0.tgz` exposes authenticated `GET /api/models`. Its DOM driver reads visible model picker labels and current label; this is a desktop UI observation, not an official TRAE account catalog.
- The same gateway accepts `model` on `POST /api/tasks/submit`, persists it as `desiredModel`, and calls `switchModel(desiredModel)` before sending the queued Task. The uAgents adapter now uses these existing endpoints under the managed instance nonce and capability token.
- uAgents does not claim a concrete TRAE model from a successful Task: the gateway Task result does not provide a trustworthy per-Task model self-report. `model_verified=false` remains accurate.
- Other targets with an explicit native model argument/SDK field accept concrete IDs without a uAgents static allowlist. Native discovery is evidence of a selectable name; authentication, quota, and execution availability remain native decisions. Explicitly disabled configured routes remain blocked. New IDs retain text + workspace only until their attachment mapping is verified.

## Checks performed

| Check | Result |
| --- | --- |
| `node --test tests/model-discovery.test.mjs tests/registry-policy.test.mjs tests/desktop-adapters.test.mjs tests/unified-cli.test.mjs tests/unified-cli-adapters.test.mjs tests/claude-code.test.mjs tests/codex-cli.test.mjs tests/dsh-sdk.test.mjs` | 121 passed on the model selection revision `8150e3b`. Covers native-only model selectors, TRAE picker parsing, managed identity and lease release, per-Task model forwarding, CLI registration and existing Task behavior. |
| `npm --prefix plugins/uagents/mcp/unified test` | 14 passed, including MCP model listing and shared idempotent Task model fields. |
| `npm --prefix plugins/uagents/mcp/trae test` | 9 passed, including the bundled gateway launch, identity and duplicate UUID behavior. |
| `node --test tests/plugin-package.test.mjs` | 1 passed. |
| `node plugins/uagents/bin/uagents.mjs models workbuddy --refresh` | Native WorkBuddy help returned 16 model labels. `glm-5.3-flash` and other discovered-only labels now have `selector`, `admission_allowed=true`, `usable=true`; no prompt was sent. |
| `node plugins/uagents/bin/uagents.mjs models trae --refresh` (before host fix) | Returned the configured backend default with `discovery.status=failed`, `error_code=installation_untrusted`; no model picker was reached and no prompt was sent. |
| Windows installation and signature recheck | `Trae CN.exe` 2.3.82600 and `TRAE SOLO CN.exe` 2.3.87413 were installed and running. Direct Authenticode checks returned `Valid`. The uAgents Windows PowerShell 5.1 child inherited an incompatible PowerShell 7 `PSModulePath`, preventing its security module from loading and causing the false `installation_untrusted`. With that variable removed for the child, the existing installation verifier returned `signature_ok=true` and `Valid`. |
| `node --test tests/agent-locator.test.mjs tests/target-supervisor.test.mjs tests/trae-launcher.test.mjs tests/model-discovery.test.mjs` (host fix) | 58 passed. Includes removal of inherited `PSModulePath`, managed process handle release, TRAE launcher identity/setup behavior and model discovery. |
| `node plugins/uagents/bin/uagents.mjs models trae --refresh` (after host fix) | Exited with code 0 after 21 seconds. Installation verification passed and a dedicated managed TRAE instance started. Returned only configured `trae-default` with `discovery.status=failed`, `error_code=trae_identity_unconfirmed`, `error_stage=native_discovery`. No prompt was sent. |
| Managed gateway `GET /api/status` | Reported `traeRunning=true`, `cdpReachable=true`, `surfaceKind=setup`, `status=disconnected`. This is a fresh isolated profile waiting for native setup/login; the user's already-open personal TRAE window is a separate profile. |
| Read-only TRAE CN personal profile inspection | `User/globalStorage/state.vscdb` contained one account-qualified `AI.agent.model.model_list_map` record. Its `solo_agent` section had 21 entries with `status=true` and `selectable=true`, including official and custom models. The record also contains credentials, so the new reader retains only model IDs and display labels and refuses ambiguous account records. The database file was last modified at local time 2026-09-25 12:40:54; this timestamp does not prove when the model catalog itself was refreshed. |
| `node --test tests/trae-local-model-cache.test.mjs tests/model-discovery.test.mjs tests/desktop-adapters.test.mjs` | 32 passed. Covers read-only model projection without credential fields, disabled/ambiguous record rejection, partial discovery semantics, and the unchanged Task identity gate. |
| `node plugins/uagents/bin/uagents.mjs models trae --refresh` (personal cache fallback) | Exited with code 0 after 15 seconds and returned 22 rows: configured `trae-default` plus 21 cached Solo models. Rows reported `discovery.status=partial`, `source=local_profile_cache`, `error_code=trae_identity_unconfirmed`, and `usable=null`. No prompt was sent. |
| `node --test tests/trae-local-model-cache.test.mjs tests/model-discovery.test.mjs tests/desktop-adapters.test.mjs tests/unified-cli.test.mjs tests/plugin-package.test.mjs` | 50 passed on the final source revision, including Task identity behavior and CLI/package compatibility. |
| `npm --prefix plugins/uagents/mcp/unified test` | Bundled MCP rebuilt and 14 tests passed on the final source revision. |

## Not verified on this machine

- Live TRAE picker labels, gateway model switch, successful TRAE Task execution, quota, and actual selected Provider/model. The installation passes verification, but the dedicated managed profile remains on the native setup screen. The 21 cached personal-profile entries are candidate selectors, not proof of availability in that managed profile. Only mocked gateway calls and bundled source prove model switching so far.
- Real execution of newly passed through IDs on Codex, Claude Code, agy, DSH, OpenCode, or WorkBuddy. The WorkBuddy no-prompt help listing confirms labels, not a model response.
- Availability of a full model catalog for Codex, Claude Code, or DSH. `models` on these targets remains configured-only.

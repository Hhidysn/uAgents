# Shared local service verification — 2026-10-03

Tested working tree: changes based on Git `892da2ca8c973b5fac9bcc928d2a6251eaebe27a`. This is a local implementation verification, not a published plugin release. Host: Windows, Node.js v24.13.0. Production source and bundles were rebuilt together; no paid Provider prompts were submitted.

## Build identity

`npm --prefix plugins/uagents/mcp/unified run build` produced these SHA-256 identities. Bundles still load the corresponding plugin `src/` Core; distribute them together.

| Bundle | SHA-256 |
| --- | --- |
| `server.mjs` | `3da0d810ab38a506862602f321a425bc37f97d78a6d5550182e16a66cb8e1643` |
| `service.mjs` | `643c67a5fb3a99e6bbac2ed0d5db66c0889bdd6df07732407faad553aa3ab3ce` |
| `bridge.mjs` | `83527b12e4834f76b179789502ae4508a0f795738cac17ca6347949e287e0701` |

## Executed checks

| Command / reproduction | Result |
| --- | --- |
| `npm run test:service` | 55 passed, 0 failed, 1 skipped; rerun after the attachment directory-race fix |
| `npm --prefix plugins/uagents/mcp/unified test` | Rebuilt all three bundles; 26 passed |
| `node --test tests/cli-transports.test.mjs tests/model-discovery.test.mjs tests/no-prompt-command.test.mjs` | 53 passed |
| `node --test --test-concurrency=1 tests/opencode-durable-recovery.test.mjs tests/unified-cli-adapters.test.mjs` | 28 passed |
| `node --test tests/plugin-package.test.mjs` | 3 passed; copied runtime tree loads service and bridge without node_modules |
| `node --test --test-concurrency=1 tests/cli-transports.test.mjs tests/model-discovery.test.mjs tests/council.test.mjs tests/artifacts.test.mjs tests/claude-code.test.mjs tests/opencode-durable-recovery.test.mjs tests/unified-cli-adapters.test.mjs tests/plugin-package.test.mjs` | Commit review: 114 passed before the attachment directory-race fix |
| `node --test --test-concurrency=1 tests/artifacts.test.mjs tests/council.test.mjs` | Commit review: 27 passed after the attachment directory-race fix |
| `git diff --check` | Passed |

Service tests execute real local subprocesses, HTTP requests, both modern and legacy MCP clients, a bundled stdio bridge, SQLite leases, Git worktrees, Windows ACL checks and UTF-8 transport. Native task execution uses provider-free fixtures. Tests cover same UUID/Attempt across CLI and two HTTP callers, disconnect survival, restart recovery, surviving worker capacity, no replay after possibly-sent, cancellation of queued tasks, health responsiveness during blocking work, credential exclusion, target/workspace/session/Council scope and concurrent Council manifest updates.

Path tests cover attachment destination junctions and existing links, managed Council root redirection, repository-root admission, external directory junctions in candidate diff/adopt, hardlinks, replacement after preflight and ordinary candidate adoption. The file symlink test was skipped because this Windows token cannot create it (`EPERM`); the real directory junction and hardlink tests ran successfully.

Commit review reproduced an attachment-ingestion `EEXIST` failure when another caller created an input directory between the existence check and `mkdirSync`. The fix accepts that creation race and still verifies each ancestor's realpath before writing. A deterministic regression failed before the fix and passed afterward; a junction inserted during the same race remains rejected. The service and MCP checks were rerun after the fix, including all three bundle builds with the identities above.

An expanded eight-file regression command with `--test-concurrency=2` executed 124 cases: 122 passed and two existing Windows process cases failed (guardian wait exceeded 7s; a fork follow-up remained queued). These two files were then run together with `--test-concurrency=1`; all 28 passed. This is a remaining parallel timing/guard-stabilization limitation, not evidence that the concurrent run passed. The other regression files passed in that run, including 20 original Council cases and the CLI/package checks. The earlier cancel-readiness test's fixed 2s wait was replaced with a bounded wait inside its existing 10s Task budget, with observer cleanup before closing its database.

## Local native connection

A private temporary service config and isolated Core state were created. The production bundled child entry served an authenticated HTTP client, exposed 20 tools and returned only the configured `opencode` target. `uagents_probe` using the installed scoped OpenCode executable returned:

```json
{ "status": "succeeded", "scope": "version_only", "version": "2.0.21", "submission": "not_sent" }
```

Authenticated `/health` reported a live fenced scheduler, zero errors and zero remaining tool children. The temporary service and files were closed/removed after the check. The real probe initially exposed a missing `parseOpenCodeVersion` import in the async refactor; the import was restored and a real `invokeCli` version-only subprocess regression now covers both bare and prefixed output without sending a prompt.

## Verification limits

The final independent review executed the four bridge response tests. Architecture review, implementation decisions and initial acceptance criteria are archived in [the design](../history/superpowers/specs/2026-10-03-shared-local-service.md).

Actual WorkBuddy application configuration, its sandbox-to-loopback access and application-exit behavior have not been tested here. Cross-user access, adversarial same-user filesystem races and long-running Git filters/hooks are also outside this verification. The service is a dispatcher for one OS user's trust domain, not a native execution sandbox. Startup instructions and these operating boundaries are documented in [current service behavior](../current/service.md).

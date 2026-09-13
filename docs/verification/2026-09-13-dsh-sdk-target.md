# DeepSeek Harness SDK Target Verification

Date: 2026-09-13.

This verification covers the first `target=dsh` implementation through the official DeepSeek Harness SDK stdio profile, including provider-free protocol checks and a real provider-bearing `session/prompt` E2E.

## Installed runtime

```text
dsh --version
0.1.5-rc.1
```

`dsh --profile sdk --help` reports the SDK stdio server profile. The npm command resolves to:

```text
C:\Users\24590\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
```

The package manifest reports `name=@deepseek-ai/dsh`, `version=0.1.5-rc.1`, and `bin.dsh=lib/bin.js`.

## Host locator / probe

`uagents ensure dsh --refresh` returned a trusted `cli-entry` whose canonical path is the package `lib/bin.js` and whose SHA-256 was cached. `uagents probe dsh --model deepseek-official/deepseek-flash` returned:

```text
status      succeeded
scope       version_only
version     0.1.5-rc.1
submission  not_sent
```

## Real SDK handshake without prompt

The installed JS entry was started as `node <dsh-bin.js> --profile sdk`. One JSON-RPC `initialize` was sent with the repository cwd, provider `deepseek-official`, and model `deepseek-flash`. The runtime returned:

```json
{
  "serverInfo": {
    "name": "deepseek-harness-sdk-runtime",
    "version": "0.0.1"
  }
}
```

`shutdown` then returned `{}` and the process exited cleanly. No `session/prompt` was sent in this handshake smoke.

## Real provider E2E and route correction

The first provider-bearing E2E used the Web UI display label as an SDK model id:

```text
deepseek-official/deepseek-v4.1-flash
```

The request was durably accepted by DSH, but the turn ended before any model tokens were consumed. The persisted DSH `turn/end` reason was:

```text
400 INVALID_REQUEST
The supported API model names are deepseek-flash, deepseek-v4-pro,
but you passed deepseek-v4.1-flash.
```

This establishes that the DSH 0.1.5-rc.1 Web UI display name “DeepSeek V4.1 Flash” is not the `deepseek-official` SDK API model id. uAgents therefore rejects that DSH route and statically admits:

```text
deepseek-official/deepseek-flash
```

The second E2E was run from the installed Codex plugin cache with a new UUID, new state directory, and exactly one submit. Result:

```text
task_id          a07f20c1-4058-4ad7-ba28-4ece5a4cc8a2
status           succeeded
submission       sent
native status    idle
response         DSH_UAGENTS_REAL_OK
input tokens     7907
output tokens    9
```

The durable DSH assistant event reported:

```text
message.source.kind      model
message.source.provider  deepseek-official
message.source.model     deepseek-flash
```

The adapter now reads this rc.1 wire shape for `model_reported`, so the final parser contract verifies `deepseek-flash` against `model_resolved=deepseek-flash`.

## Provider-free protocol fixtures

`tests/dsh-sdk.test.mjs` covers static adapter contract, checkpoint-before-acceptance ordering, root `running -> assistant/message -> idle` completion, rc.1 `message.source.model` self-report verification, unrelated-session isolation, initialize identity mismatch before send, prompt JSON-RPC failure after send, prompt acknowledgement timeout, missing root idle timeout, and local cancellation without claiming remote cancellation.

`tests/agent-locator.test.mjs` also covers Windows npm `dsh.cmd` shim resolution to package `lib/bin.js` and trusted SHA-256 caching.

Targeted gates completed during implementation:

```text
DSH/locator/policy/CLI targeted   51/51
broader targeted                 67/67
```

Full regression totals are recorded after the final repository gate.

Final repository gate:

```text
Core          327/327
Doubao MCP     11/11
TRAE MCP        9/9
Unified MCP    13/13
Total         360/360
```

## Provider-call accounting

New provider-bearing DSH prompts in this verification: `2`.

1. one failed pre-token request using the invalid SDK model id `deepseek-v4.1-flash`;
2. one successful request using `deepseek-flash`, returning `DSH_UAGENTS_REAL_OK`.

There were no automatic retries, resume calls, or UUID-replacement replays.

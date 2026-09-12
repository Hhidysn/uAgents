# WorkBuddy Generic File Attachment Real E2E

Date: 2026-09-13.

This verification used the locally installed Codex uAgents plugin and a real WorkBuddy 2.132.0 provider path. It records a **negative capability result**: the current WorkBuddy backend/default route does not accept generic file content.

## First installed-plugin attempt

Installed plugin version: `0.2.0-alpha.1+codex.20260913014746`.

Task: `81bbb6b0-0747-4e7c-a6f6-ac78acb223fb`.

The Unified MCP host attachment path successfully materialized the uploaded marker into `.uagents/inputs/...-marker.txt`, and the native WorkBuddy session was accepted. The task then became `indeterminate` with `duplicate_init` because WorkBuddy emitted more than one equivalent `system/init` event.

No automatic retry was performed.

## Repeated-init compatibility fix

The WorkBuddy stream parser now accepts a repeated `system/init` only when the native session, workspace cwd, and reported model remain consistent with the first initialization. Session/cwd mismatches still fail identity validation, and a changed reported model still fails as `duplicate_init`.

Provider-free regression after this fix passed:

```text
Core          313/313
Doubao MCP     11/11
TRAE MCP        9/9
Unified MCP    13/13
Total         346/346
```

## Authorized real re-test

The user explicitly authorized one new real call after the parser fix.

Installed plugin version used for the call: `0.2.0-alpha.1+codex.20260913020846`.

Task: `3d4c8c7e-6b5a-4c2f-a91d-8a4c66cf9f21`.

The request used one small `marker.txt` attachment and asked WorkBuddy to return its token exactly.

Observed uAgents evidence:

```text
submission       sent
native session   accepted
duplicate_init   absent
model_reported   auto
native status    error_during_execution
task status      failed
usage            0 input / 0 output tokens
```

The repeated-init fix therefore worked: the real request proceeded past the failure point from the first attempt.

## Native WorkBuddy evidence

The local WorkBuddy session history confirms that the stream-json `document` was converted to native `input_file`. The backend then returned:

```text
400 Parse message failed: unsupported content type at index 3: file
```

The corresponding WorkBuddy trace ended before token usage.

This is stronger evidence than the local CLI parser shape alone. The installed WorkBuddy bundle can parse a `document` block and create an `input_file`, but the current backend/default route does not accept that content type.

## Capability correction

uAgents therefore keeps generic WorkBuddy file capability disabled. Later image E2E established a separate model-specific image route, so the final attachment capability is:

```text
workspace_readable = true
files              = false
target images      = true
default images     = false
deepseek-v4.1-flash images = true
```

Generic WorkBuddy file requests are rejected by policy before native dispatch with `unsupported_capability` / `submission=not_sent`. uAgents does not fall back to placing the file path into prompt text.

The later authorized image E2E also proved that the current backend/default route rejects image request parameters, so `images` is now false as well. See [WorkBuddy Image Attachment Real E2E](2026-09-13-real-workbuddy-image-attachment-e2e.md).

The generic-file correction was first installed as `0.2.0-alpha.1+codex.20260913022455`. A later authorized image E2E produced a further capability correction (`images=false`) and superseded the active local build; see the image E2E verification for that final build.

The installed-cache preflight was then exercised with a fresh WorkBuddy file request UUID. `capabilities workbuddy` reported `files=false`, and `submit` returned:

```text
code        unsupported_capability
submission  not_sent
message     Target does not support native file attachments.
```

The fresh UUID does not appear in the local WorkBuddy log, confirming the corrected installed plugin rejected the file request before native/provider dispatch.

Final provider-free regression gate:

```text
Core          313/313
Doubao MCP     11/11
TRAE MCP        9/9
Unified MCP    13/13
Total         346/346
```

## Provider-call accounting

Exactly one new provider-bearing submit was made during the authorized re-test in this verification. No `resume`, `reconcile`, duplicate submit, or automatic retry was used after its failure.

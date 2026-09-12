# WorkBuddy Image Attachment Real E2E

Date: 2026-09-13.

This verification used real WorkBuddy 2.132.0 provider calls and records a **model-specific capability result**. The backend-selected `default/auto` route rejected image-bearing requests, but an explicit native `deepseek-v4.1-flash` route successfully consumed a normal RGB PNG and returned the expected visual classification.

## Installed build under test

Installed plugin version: `0.2.0-alpha.1+codex.20260913022455`.

The user explicitly authorized continuing real provider-call testing after the generic-file result.

## Call 1: valid 1×1 RGB PNG

Task: `7de81ce3-759a-4a35-b9e6-3832f8f3f910`.

Fixture: a valid 1×1 RGB red PNG, 70 bytes. Pillow decoded it successfully before submit.

Observed uAgents state:

```text
submission       sent
native session   accepted
model_reported   auto
native status    error_during_execution
task status      failed
usage            0 input / 0 output tokens
```

WorkBuddy session history confirms the image was accepted by the local stream-json layer and stored as `image_blob_ref`. The model request started, then the provider returned:

```text
400 Please start a new conversation, replace the image, and try again.
```

Because an extremely small image could itself be an unsupported provider input, this call alone was not treated as conclusive.

## Call 2: normal 64×64 RGB PNG

Task: `15352f77-f0e4-4c4e-a214-63182e89c8b0`.

Fixture: a valid 64×64 RGB solid-red PNG generated locally with Pillow, 181 bytes before uAgents ingestion. The request asked WorkBuddy to return `RED_OK` if the image was predominantly red.

Observed uAgents state again reached `submission=sent` and an accepted native session, then failed with `error_during_execution` before any token usage.

The WorkBuddy persisted user message again contains `image_blob_ref`, proving the image crossed the uAgents/native parser boundary. The assistant failure persisted by WorkBuddy is:

```text
400 the request parameters were rejected by the model provider
```

This second call rules out the 1×1 fixture as the only cause. The current backend-selected `auto` route rejects the image-bearing request parameters even though the local CLI can parse and store the image.

## Call 3: explicit deepseek-v4.1-flash succeeds

After the user selected DeepSeek V4.1 Flash in WorkBuddy, the CLI help was checked locally and confirmed the exact supported native model ID `deepseek-v4.1-flash`.

A direct native WorkBuddy stream-json request was then sent with:

```text
--model deepseek-v4.1-flash
session c75eeb46-1391-4725-b03b-f9c2f9dcd456
image   512×512 RGB PNG
content 75% red / 25% blue
```

The prompt asked for exactly `RED_OK` if the attached image was predominantly red. Native init explicitly reported:

```text
model = deepseek-v4.1-flash
```

The provider returned:

```text
assistant  RED_OK
result     success
exit       0
input      25982 tokens
output     3 tokens
```

This is conclusive positive multimodal evidence for the explicit DeepSeek route. The earlier failures therefore describe the `default/auto` route, not the WorkBuddy image transport as a whole.

## Capability correction

uAgents therefore models WorkBuddy attachment input as:

```text
workspace_readable = true
files              = false
target images      = true
default images     = false
deepseek-v4.1-flash images = true
```

`model=default` remains available for text and keeps backend-selected behavior. `model=deepseek-v4.1-flash` is an approved concrete route and is forwarded as native `--model deepseek-v4.1-flash`. Image requests on the default route are rejected before provider dispatch; image requests on the explicit DeepSeek route are admitted. Generic WorkBuddy file input remains rejected on every approved route.

OpenCode attachment capability is unchanged.

Final model-specific local plugin build: `0.2.0-alpha.1+codex.20260913030454`.

Provider-free regression after the capability correction passed:

```text
Core          316/316
Doubao MCP     11/11
TRAE MCP        9/9
Unified MCP    13/13
Total         349/349
```

## Historical installed-cache fail-closed verification

The corrected build was synced to the personal marketplace source with `136/136` tracked files and zero SHA-256 mismatches, then installed through the normal Codex plugin flow.

Installed cache:

```text
C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260913023656
```

From that cache, `capabilities workbuddy` reported:

```text
files              false
images             false
workspace_readable true
```

A fresh image request UUID `b917cccd-a743-4fce-a184-3639f1bc8c6a` was then submitted through the installed cache. It returned before native dispatch:

```text
code        unsupported_capability
submission  not_sent
message     Target does not support native image attachments.
```

That UUID does not appear anywhere in the local WorkBuddy logs, confirming the corrected installed plugin blocks the known-bad image path before WorkBuddy/provider execution.

This was intentionally superseded after the explicit DeepSeek call proved that image capability is model-specific rather than universally unavailable.

## Final installed-cache model-specific verification

The model-specific implementation was installed as:

```text
C:\Users\24590\.codex\plugins\cache\personal\uagents\0.2.0-alpha.1+codex.20260913030454
```

Repository → personal marketplace sync used `136/136` tracked plugin files with zero SHA-256 mismatches.

From that installed cache, `models workbuddy` reports both approved routes:

```text
workbuddy-default
  configured=true
  discovered=true
  usable=true
  inputs.images=false

workbuddy/deepseek-v4.1-flash
  model=deepseek-v4.1-flash
  configured=true
  discovered=true
  usable=true
  inputs.images=true
```

`capabilities workbuddy` reports `model_selection=mixed`, target `images=true`, and `files=false`.

A provider-free direct import of the installed policy/driver then verified:

```text
default + image
  unsupported_capability
  submission=not_sent

deepseek-v4.1-flash + image
  allowed=true
  route_id=workbuddy/deepseek-v4.1-flash
  native argv includes --model deepseek-v4.1-flash
```

No additional provider call was made for this installed-cache verification.

## Provider-call accounting

The first authorization covered two backend/default image submits. A later explicit authorization covered one direct native `deepseek-v4.1-flash` image call. Each used a fresh UUID/session. No `resume`, `reconcile`, duplicate submit, or automatic retry was used.

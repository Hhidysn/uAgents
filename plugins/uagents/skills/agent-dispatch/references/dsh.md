# DeepSeek Harness (`dsh`)

Use `target=dsh` with an explicit configured route. The first approved route is:

```text
model=deepseek-official/deepseek-flash
```

uAgents resolves it to provider `deepseek-official` and API model id `deepseek-flash` and starts the installed official Harness as `dsh --profile sdk` through its real npm package JS entry. In DSH 0.1.5-rc.1 the Web UI may display “DeepSeek V4.1 Flash”, but the `deepseek-official` SDK adapter rejects `deepseek-v4.1-flash` and accepts `deepseek-flash`; do not translate the UI label back into the SDK request. Prompt text is sent only over JSON-RPC stdin; it is never placed in argv. The user's Web Agent on port 3080 is not automated or required by this adapter.

V1 deliberately uses one uAgents Task per SDK subprocess. `initialize` binds the Task workspace, provider, and model. The uAgents request UUID is used as the root Harness `sessionId`; `session/prompt` acknowledgement supplies the native message id. Completion requires the root session to enter `running`, later return to `idle`, and publish a committed non-empty `assistant/message`. Reported model evidence from that assistant event is compared with `model_resolved`.

Supported modes are `analysis` and `implementation`. The workspace is readable by normal Harness coding tools and existing uAgents `expected_outputs` verification still applies after native completion. V1 does not expose native file/image attachments, session continuation/fork, per-prompt remote cancellation, Web UI automation, shared SDK process pools, or automatic model selection. Do not substitute another discovered DSH model unless it is first added to the static uAgents registry and separately verified.

`probe dsh --model deepseek-official/deepseek-flash` is version-only and does not send an Agent prompt. `ensure dsh --refresh` resolves the Windows npm shim/known install to the real `@deepseek-ai/dsh/lib/bin.js` entry and caches its verified file identity.

# Native file and image input verification

Date: 2026-09-26. Workspace revision: the attachment implementation in this record.

## Design and native interface evidence

- Core Schema 1.0 already accepts `inputs` with exactly one of workspace `path`, absolute `source`, or host `blob`. Registration materializes external bytes, records SHA-256 and media metadata, and rejects changed snapshots before dispatch. This change adds a shared immediate pre-send recheck for native drivers; it does not alter Task identity, cancellation, or runtime replay rules.
- Local Codex CLI 0.153.4 advertises `exec --image <FILE>` and `exec resume/fork --image <FILE>`. Generated app-server TypeScript bindings from the same installation define `UserInput` `{type:"localImage",path:string}`. The exec and app-server adapters now use those native fields. Generic file input remains unsupported.
- Local Claude Code 2.1.251 advertises `--input-format stream-json`. The adapter uses one native user message with image blocks and PDF or UTF-8 text document blocks. The [Claude Messages content-block reference](https://platform.claude.com/docs/en/api/messages/create) defines image and document content, and the local session record below confirms Claude Code accepted the message shape. Other binary files fail before native send.
- Installed DSH SDK protocol defines `SdkEncodedImageBlock` with `type:"image"`, base64 `data`, and raster `mimeType`. Its JSON-RPC server admits those bytes to the target's attachment store. The ordinary DSH file block instead requires a target-owned durable attachment reference; uAgents does not manufacture one.
- OpenCode and WorkBuddy keep their existing mappings and restrictions. agy, Doubao, and TRAE still lack a verified native attachment input mapping.

## Targeted tests

After the implementation, `node --test tests/artifacts.test.mjs tests/claude-code.test.mjs tests/cli-transports.test.mjs tests/codex-cli.test.mjs tests/dsh-sdk.test.mjs tests/registry-policy.test.mjs tests/unified-cli-adapters.test.mjs` passed **106/106**. The cases cover content-block shape, MIME, native argv, snapshot mismatch, unsupported binary file rejection, model selector pass-through, and existing Task status behavior.

The new Codex app-server `localImage` fixture case passed **1/1** with `node --test --test-name-pattern "localImage inputs" tests/codex-app-server.test.mjs`. In the larger app-server test group, a cancellation case failed before send with `process_tree_unconfirmed`; the same failure reproduced when run alone. A separate continuation case failed with that process-guard result under parallel load and passed on isolated rerun. Neither failure involved an attachment-bearing turn. The cancellation failure is not counted as passing verification.

`node --test tests/model-discovery.test.mjs tests/plugin-package.test.mjs` passed **19/19** after the plugin version update.

## Real CLI observations

All three requests used a new UUID and a small isolated workspace. No indeterminate Task was replayed or retried.

| Target / Task | Result | Evidence and limit |
| --- | --- | --- |
| Codex `gpt-5.6-luna`, `b8f6b066-c201-43a8-a449-72b68b6cdd60` | `succeeded`, `submission=sent` | Native session `01a0dcc9-7941-7f32-954c-45ac468c19a3` persisted an `input_image` data URL whose decoded SHA-256 exactly equals source PNG `70f2b3ed92e3af50e8b494317e2845726c2a0d52cce58198eeba94c411cc0df3`. This proves byte delivery. The model answered `BLUE` although red occupies about 75% of the image, so visual interpretation did not pass the sample task. Codex still provides no trusted model self-report (`model_verified=false`). |
| Claude Code `deepseek-v4-flash`, `cfe68b0c-1f59-4715-8d76-d6e523f2f753` | `waiting_user`, `submission=sent`, native result `success` | Native session `a8501755-dbca-4cff-a2e3-d2fdeb0c5aae` persisted content types `text,image,document,document`. Sources were `image/png` base64, `text/plain` text, and `application/pdf` base64. The response identified red as dominant and returned `TEXT_TOKEN_M6B` and `PDF_TOKEN_7Q4`. Native permission denials kept the Task at `waiting_user`; uAgents did not approve them. `init.model` matched requested model, which is CLI self-report, not upstream-provider proof. |
| DSH `deepseek-official/deepseek-flash`, `1d4f7476-c123-4168-809c-0780c8193de5` | `indeterminate`, `submission=may_have_been_sent` | The SDK process exited before an accepted native message ID or final result was recorded (`native_process_exit`). The published SDK image block and fixture mapping were verified, but actual image delivery/provider execution is unconfirmed. The request was not replayed. |

The shared PNG is a valid 256×256 RGB image with a red majority and blue right quarter. The PDF is a valid one-page rendered document containing `PDF_TOKEN_7Q4`; the UTF-8 file contains `TEXT_TOKEN_M6B`. Test requests and source files are under the ignored local `.local/attachment-e2e-20260926/` directory, not tracked in Git.

## Remaining limits

- `capabilities.inputs` describes an implemented native transport mapping. It does not prove every concrete model or account accepts the modality. DSH image execution is specifically unconfirmed after the recorded indeterminate result.
- Claude Code supports PDF and UTF-8 text in this mapping, not arbitrary binary files. Its permission result remains native and may require user action even when response text exists.
- Codex app-server image mapping has fixture and protocol-schema evidence, but no new real app-server image Task in this verification.
- Unsupported target inputs still fail with `submission=not_sent`. Sent cancellation, timeout, and process-exit uncertainty retain the existing Task rules.

## Installed Codex plugin

The personal marketplace source and installed cache were refreshed to `0.2.0-alpha.1+codex.20260926082746` through the plugin cachebuster and `codex plugin add uagents@personal` flow. All 151 tracked plugin files matched the repository by SHA-256 in both the personal source and installed cache. The installed CLI reported `codex.images=true`, `claudeCode.files=true/images=true` with PDF/text formats, and `dsh.images=true`.

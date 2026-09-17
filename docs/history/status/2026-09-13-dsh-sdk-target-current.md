# DeepSeek Harness SDK Target 当前状态

日期：2026-09-13。本文是 `target=dsh` 的当前能力入口。

## 当前入口

uAgents 通过 DeepSeek Harness 官方 SDK stdio profile 接入：

```text
uAgents Task
  -> verified @deepseek-ai/dsh/lib/bin.js
  -> node bin.js --profile sdk
  -> JSON-RPC 2.0 over stdin/stdout
  -> DeepSeek Harness root session
```

不自动操作用户已经打开的 `127.0.0.1:3080` Web Agent，也不使用把 prompt 放在命令行参数里的 headless 调用方式。

## 当前 route

第一版只批准一条显式路线：

```text
target     dsh
model      deepseek-official/deepseek-flash
provider   deepseek-official
resolved   deepseek-flash
route_id   deepseek-official/deepseek-flash
```

`models dsh` 当前返回该 configured route；没有可靠的 no-prompt DSH native model catalog 时，不自动扩展 allowlist。

## 当前能力

```text
modes                 analysis / implementation
text input            true
workspace_readable    true
native file input     false
native image input    false
text output           true
file output capture   true
resume                false
fork                  false
cancel                local-request / remote-unconfirmed
transport             sdk-jsonrpc-stdio
model selection       explicit
```

`workspace_readable=true` 表示 Harness Agent 可以通过自己的 coding tools 操作初始化时绑定的 cwd。它不是 attachment capability。V1 不把 `{type:file}` / `{type:image}` 转成 DSH SDK content block；这两类请求继续在 provider 发送前 fail-closed。

## Process / session 语义

V1 固定为：

```text
one uAgents Task = one dsh SDK process = one root session
```

`initialize` 在进程级绑定 `cwd / provider / model`。uAgents `request_id` 直接作为 DSH root `sessionId`；`session/prompt` 返回的 `messageId` 作为 native task/message identity。当前不共享 SDK process，因此不同 Task 不会串 workspace/model。

## 完成证据

发送 prompt 前先持久化 uAgents `possibly_sent`。随后：

1. `session/prompt` 返回非空 `messageId` -> native accepted；
2. root `session.status=running`；
3. root committed `session.event` / `assistant/message` 提供 response/model/usage；
4. root `session.status=idle`；
5. response 非空 -> native succeeded。

若 prompt 可能已写入但 JSON-RPC acknowledgement、root idle 或其它 terminal evidence 缺失，任务保持 `indeterminate`，不会自动换 UUID 重放。

## 本机 runtime 证据

本机已安装：

```text
dsh version  0.1.5-rc.1
real entry   C:\Users\24590\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js
```

`ensure dsh --refresh` 已通过正常 Host locator，把 npm shim/known install 归一化到上述 JS entry，并记录 SHA-256 trusted installation。

`probe dsh --model deepseek-official/deepseek-flash` 已得到：

```text
status      succeeded
scope       version_only
version     0.1.5-rc.1
submission  not_sent
```

另外直接对真实 SDK runtime 执行了 provider-free `initialize + shutdown`：runtime 返回 `serverInfo.name=deepseek-harness-sdk-runtime` 和 wire version `0.0.1`，随后 `shutdown -> {}`。

真实 `session/prompt` E2E 也已通过。第一次把 Web UI 展示名 `deepseek-v4.1-flash` 当作 SDK id 时，DSH durable `turn/end` 明确返回 `400 INVALID_REQUEST` 并指出支持的 API model 为 `deepseek-flash` / `deepseek-v4-pro`。改用批准 route `deepseek-official/deepseek-flash` 后，从安装版 uAgents 提交的新 Task 成功返回：

```text
status         succeeded
submission     sent
native status  idle
response       DSH_UAGENTS_REAL_OK
usage          7907 input / 9 output
```

真实 assistant event 的模型证据位于 `message.source.model=deepseek-flash`；当前 adapter 已按该 rc.1 wire shape 读取并用于 model verification。

## Deferred

- shared/persistent SDK process pool；
- session continuation / fork；
- native file/image attachment；
- prompt-level remote cancel；
- Web Agent 3080 automation；
- 自动 provider/model 选择；
- discovered model 自动 admission。

设计见 [DeepSeek Harness SDK Target 设计](../superpowers/specs/2026-09-13-deepseek-harness-sdk-target-design.md)，验证见 [SDK / real provider E2E 验证](../../verification/2026-09-13-dsh-sdk-target.md)。

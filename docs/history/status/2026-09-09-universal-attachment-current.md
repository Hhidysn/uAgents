# Universal Attachment Input 当前状态

> 历史阶段快照：当前附件 contract 已扩展 blob/connector-host ingestion。最新状态见 [2026-09-12 Universal Attachment 当前状态](2026-09-12-universal-attachment-current.md)。

日期：2026-09-09。本文记录**当前仓库工作树**的附件能力，不代表 2026-09-07 的已安装 uAgents cache。
旧 cache 没有本轮源码，不能用于反推当前实现。实现和验证仍以 `F:\documents\software\uAgents` 当前 checkout 为准。

## 当前结论

统一请求 Schema 1.0 保持现有 `{ "type": "file", "path": "..." }` / `{ "type": "image", "path": "..." }`
向后兼容，并新增绝对本地 `{ "type": "file|image", "source": "..." }` ingestion。`source` 在 submit 时复制到
workspace 的 `.uagents/inputs/`，随后立即归一化回现有 `{type,path}` attachment；注册时形成 metadata snapshot，
dispatch 前再次验证，target transport 不需要理解 `source`，附件 bytes 也不进入 SQLite。

当前 native attachment capability：

| Target | workspace readable | native file | native image | Mapping |
| --- | ---: | ---: | ---: | --- |
| agy 1.1.27 | true | false | false | 本机 `--help` 只有 `--add-dir` 等 workspace 接口；未发现可靠 attachment flag/message field，因此 fail-closed |
| WorkBuddy | true | true | true | 当前受信 `codebuddy.js` 的 `--input-format stream-json`：file → base64 `document` block → native `input_file`；image → base64 `image` block |
| OpenCode | true | true | true | `opencode run --file <absolute-path>`；当前 help 明确描述为 attach to message |
| Doubao Work | false | false | false | 当前 CDP 消息路径仍只有文本 |
| TRAE CN | true | false | false | 当前 gateway 输入路径仍未接附件 |

这里的 `files/images=true` 只表示 uAgents 有 target-specific native mapping；仅能让 Agent 用工具读取 workspace
不再算 native attachment capability。

## 统一 attachment contract

- 输入可使用 workspace-relative `path`，也可使用 workspace 外的绝对本地 `source`；两者互斥。
- `source` 复制到 `.uagents/inputs/<sha256>-<portable-name>` 后，stored request / snapshot / transport 全部只使用现有 `path` contract。
- Unified MCP 的 `uagents_submit` 已与 Core 对齐：`file|image` + `path|source` 都能通过 tool schema。宿主或 connector
  若已把聊天附件物化成本地文件，可直接把该绝对路径作为 `source`。
- opaque connector file-id、blob/内存、URL ingestion 仍未实现；uAgents 本身不尝试解析这些引用。
- 普通文件单项上限 32 MiB；全部声明输入合计上限 64 MiB。
- 图片单项上限 20 MiB；格式白名单 PNG/JPEG/GIF/WebP。
- 图片类型和宽高从文件字节/格式头验证，不信任扩展名。
- 单边最大 16,384 px；总像素最大 64 Mi pixels。
- 新 snapshot 保存 `type`、`path`、`media_type`、`size_bytes`、`sha256`；图片额外保存 `width_px` / `height_px`。
- 旧 Schema 1.0 file snapshot 缺少新 metadata 时仍可恢复：验证当前 richer snapshot 中所有旧字段必须完全匹配，不为旧任务伪造新证据。
- WorkBuddy inline base64 payload 只在 native process stdin 中物化；bytes 不写入 control DB。

## WorkBuddy 证据边界

当前受信入口由源码 `ensure workbuddy --refresh` 解析到：

`C:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\dist\codebuddy.js`

本轮只读检查该 bundle，确认 `StreamJsonUtils.parseMessagesFromPipeInput` 的 user-message contract 和
`convertContentBlock` 行为：`image` block 转为 `input_image`，`document` block 转为 `input_file`；base64 source
由 native parser 自己转为 data URI。uAgents 因此可以 provider-free 地证明 transport 实际消费 `request.inputs`，
而不是只证明模型碰巧能从 workspace 读文件。

该证据不代表 WorkBuddy provider 已真实消费附件，也不证明当前后端模型支持所有格式；真实消息 E2E 仍需要
用户明确授权 provider-billable 调用。

## agy 证据边界

本机 agy 版本为 `1.1.27`。当前 `agy.exe --help` 没有 file/image attachment flag；stream-json 的现有 uAgents
实现也没有已验证的 attachment message field。`--add-dir <workspace>` 只证明 workspace 可见，因此 Registry
保持 `files=false, images=false, workspace_readable=true`。

## 权限与 orchestration 边界

本轮没有新增权限沙箱，没有改变 `mode=analysis|implementation` 的含义，也没有默认增加 `--auto`、`-y`、
`dangerously-skip-permissions` 或其他 native permission bypass。WorkBuddy implementation 仍只沿用既有的
`acceptEdits` 行为；advisory-read-only 仍不会隐式打开它。

## 验证状态

provider-free contract 与回归证据见
[Universal Attachment Input 验证](../../verification/2026-09-09-universal-attachment-input.md)。当前完整门禁为 Core
273/273 + MCP 11/9/4，共 **297/297**；Skill validator、plugin validator 和 `git diff --check` 同时通过。
本轮没有执行任何真实 OpenCode、WorkBuddy、agy 或其他 provider prompt。

## 仍未完成

1. provider-billable WorkBuddy/OpenCode 图片与文件真实消息 E2E（必须先取得用户明确授权）。
2. agy 若未来版本暴露可靠 attachment API，再单独增加 mapping；当前不猜字段。
3. Doubao/TRAE target-specific attachment 协议核实与实现。
4. attachment ingestion 下一步只剩 opaque connector file-id、blob/内存等来源；绝对本地 `source` 与
   host-materialized MCP attachment 已在当前工作树实现。
5. WorkBuddy result stream 目前没有附件 identity acknowledgement，因此 mapping 证据是本机 native parser contract，
   不是远端 round-trip identity proof。

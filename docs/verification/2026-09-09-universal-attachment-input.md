# Universal Attachment Input provider-free 验证

日期：2026-09-09。范围：当前仓库源码中的 Universal Attachment Input 第一阶段，以及当前本机 native CLI 的
只读接口证据。**没有执行 provider-billable E2E。**

## 验证目标

1. 保持 Schema 1.0 现有 `{type:"file",path}` 请求兼容，同时增加 `type:"image"` 和绝对本地 `source` ingestion。
2. 用统一 snapshot contract 记录附件 identity，不把附件 bytes 放进 SQLite。
3. capability 区分 workspace readability 与 native attachment mapping。
4. agy 没有可靠附件 API 时 fail-closed。
5. WorkBuddy/OpenCode 只有在本机可验证 target-specific mapping 时才开放 file/image capability。
6. Unified MCP `uagents_submit` 与 Core 的 file/image + path/source schema 保持一致，使宿主已物化的聊天/connector
   附件可以直接进入同一 ingestion pipeline。
7. 不增加 uAgents 权限沙箱，不默认增加 native permission flags。

## 本机只读协议证据

### agy

`agy.exe --version` 返回 `1.1.27`。`agy.exe --help` 可见 `--add-dir`、`--input-format stream-json`、
`--output-format stream-json` 等参数，但没有 file/image attachment flag。当前没有证据把 `--add-dir` 解释成
message attachment，因此 Registry 保持 `files=false, images=false, workspace_readable=true`。

### WorkBuddy

当前仓库的受管入口发现返回：

```text
C:\Program Files\WorkBuddy\resources\app.asar.unpacked\cli\dist\codebuddy.js
SHA-256 0ef7a3965832ef0e6cd41b01c9659bc777b3f2a958e6910d856aeb3184b3acaa
size 22590170
```

只读检查该 bundle 可定位：

- `StreamJsonUtils.parseMessagesFromPipeInput`
- `parseUserMessage`：接收 `type:"user"` NDJSON message
- `convertUserMessage`：消费 `message.content`
- `convertContentBlock`：`image` → `input_image`；`document` → `input_file`
- image/document base64 source 转换路径

因此 WorkBuddy transport 改用 `--input-format stream-json`，把已 snapshot 的 file bytes 作为 base64 `document`
block、image bytes 作为 base64 `image` block 写入同一个 user message。该 payload 在 native process stdin 中生成；
没有写入 control DB。

### OpenCode

本机 `opencode run --help` 对 `-f, --file` 的描述为 `file(s) to attach to message`。当前源码继续把声明输入按
请求顺序映射为重复的 `--file <absolute-path>`；image 使用同一 native attachment channel。

## Attachment contract

当前 provider-free contract：

| 项目 | 规则 |
| --- | --- |
| generic file | 单项 ≤ 32 MiB |
| all inputs | 合计 ≤ 64 MiB |
| image bytes | 单项 ≤ 20 MiB |
| image formats | PNG / JPEG / GIF / WebP |
| image dimension | width、height 各 ≤ 16,384 px |
| image pixels | ≤ 64 Mi pixels |
| snapshot | type/path/media_type/size_bytes/SHA-256；图片另含 width/height |
| persistence | bytes 不进 SQLite；旧 file snapshot 以 persisted-field subset 方式兼容验证 |
| local source ingestion | `{type,source:<absolute-path>}` → workspace `.uagents/inputs/<sha256>-<name>` → existing `{type,path}` pipeline |
| Unified MCP | `uagents_submit` 接受 `file|image` + `path|source`；host-materialized local path 可直接作为 `source` |

图片格式与尺寸从 byte header 验证，不使用文件扩展名作为信任依据。

## Provider-free tests

开发过程中先运行 attachment/protocol/policy/transport/CLI adapter 定向门禁；在增加四种图片格式、大小限制、
旧 snapshot 兼容和 WorkBuddy native mapping 后，最近一次定向结果为：

```text
tests 48
pass 48
fail 0
```

覆盖包括：

- file/image Schema 与 capability fail-closed；
- PNG/JPEG/GIF/WebP header + dimensions；
- image 维度与 byte limit；generic file byte limit；
- legacy Schema 1.0 snapshot 恢复兼容；
- OpenCode file/image → native `--file`；
- WorkBuddy file → `document`、image → `image` native stream-json block；
- workspace 外绝对本地 file/image `source` 在注册前复制并归一化为现有 `path` 输入；stored request 不保留 `source`；
- Unified MCP tool schema 接受 image/source，且 MCP handler 注册后同样只持久化 normalized `{type,path}`；
- snapshot 后附件发生变化时 WorkBuddy prepare fail `input_changed`；
- 现有 agy/WorkBuddy/OpenCode shared runtime 与 advisory permission 回归。

最终完整门禁：

```text
Core            273/273
Doubao MCP       11/11
TRAE MCP           9/9
Unified MCP        4/4
Total           297/297

agent-dispatch Skill validator: pass
uagents plugin validator:       pass
git diff --check:               pass
```

源码 CLI capability 也在同一工作树上只读核对：

```text
agy       inputs = { text:true, files:false, images:false, workspace_readable:true }
workbuddy inputs = { text:true, files:true,  images:true,  workspace_readable:true }
opencode  inputs = { text:true, files:true,  images:true,  workspace_readable:true }
```

这些 capability 输出来自当前仓库 `plugins/uagents/bin/uagents.mjs`，不是 2026-09-07 的已安装 uAgents cache。

## 未声称的内容

- 没有真实调用 WorkBuddy/OpenCode/agy provider，因此不声称远端模型已消费附件。
- 没有证明 WorkBuddy result stream 回显附件 identity。
- 没有为 agy 猜测未公开 stream-json attachment field。
- 已实现绝对本地路径 ingestion 与 host-materialized MCP attachment；没有增加 URL、blob、内存或 opaque connector file-id ingestion。
- 没有添加新的 native permission bypass 或 uAgents sandbox。
